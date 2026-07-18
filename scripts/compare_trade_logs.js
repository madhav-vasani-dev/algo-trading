/**
 * compare_trade_logs.js
 * 
 * Compares the user's "11AM Selling Naked.csv" trade log day-by-day against 
 * our script output to find exact discrepancies in entry prices, exit prices, 
 * slippage, lot size, and date coverage.
 */

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', '11AM Selling Naked.csv');
const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');

function getAllJsonFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllJsonFiles(fullPath));
    } else if (file.endsWith('.json') && file !== 'index.json') {
      results.push(fullPath);
    }
  });
  return results.sort();
}

// 1. Parse CSV
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n').filter(l => l.trim().length > 0);

const csvDailyMap = {};
let totalCsvPnL = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
  
  const index = cols[0];
  const date = cols[1];

  // Primary day row (index like "1", "2", "3")
  if (!index.includes('.')) {
    const pnl = parseFloat(cols[12] || 0);
    if (!isNaN(pnl) && date) {
      csvDailyMap[date] = {
        csvPnL: pnl,
        legs: []
      };
      totalCsvPnL += pnl;
    }
  } else {
    // Sub-row leg details (index like "1.1", "1.2")
    if (csvDailyMap[date]) {
      csvDailyMap[date].legs.push({
        type: cols[5],
        strike: cols[6],
        entryTime: cols[2],
        exitTime: cols[4],
        entryPrice: parseFloat(cols[9]),
        exitPrice: parseFloat(cols[10]),
        pnl: parseFloat(cols[12])
      });
    }
  }
}

console.log('========================================================================');
console.log(`  USER CSV SUMMARY: Total Trades: ${Object.keys(csvDailyMap).length} days | Net PnL: Rs ${totalCsvPnL.toFixed(2)}`);
console.log('========================================================================\n');

// 2. Load Local Data
const filePaths = getAllJsonFiles(dataDir);
let marketData = [];
for (const filePath of filePaths) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    marketData = marketData.concat(raw);
  } catch (err) {}
}

const daysMap = {};
marketData.forEach(c => {
  const date = c.timestamp.split('T')[0];
  if (!daysMap[date]) daysMap[date] = [];
  daysMap[date].push(c);
});

// 3. Compare day-by-day
const csvDates = Object.keys(csvDailyMap).sort();
console.log(`CSV Date Range: ${csvDates[0]} to ${csvDates[csvDates.length - 1]}`);

let matchedDays = 0;
let totalScriptPnLForCsvDates = 0;
const diffs = [];

for (const date of csvDates) {
  const csvData = csvDailyMap[date];
  const candles = daysMap[date];

  if (!candles) {
    diffs.push({ date, reason: 'Date missing in local dataset', csvPnL: csvData.csvPnL, scriptPnL: 'N/A' });
    continue;
  }

  const entryCandle = candles.find(c => c.timestamp.split('T')[1].substring(0, 5) === '11:00');
  if (!entryCandle || !entryCandle.options) {
    diffs.push({ date, reason: '11:00 entry candle missing', csvPnL: csvData.csvPnL, scriptPnL: 'N/A' });
    continue;
  }

  const spot = entryCandle.close;
  const atm = Math.round(spot / 50) * 50;

  const ceOpt = entryCandle.options[atm] ? entryCandle.options[atm].CE : null;
  const peOpt = entryCandle.options[atm] ? entryCandle.options[atm].PE : null;

  if (!ceOpt || !peOpt) {
    diffs.push({ date, reason: 'ATM options missing at 11:00', csvPnL: csvData.csvPnL, scriptPnL: 'N/A' });
    continue;
  }

  // Calculate script PnL for 11:00 AM entry, 50% SL, 15:29 exit
  const ceEntryPrice = ceOpt.open;
  const peEntryPrice = peOpt.open;

  const ceSl = ceEntryPrice * 1.50;
  const peSl = peEntryPrice * 1.50;

  let ceActive = true;
  let peActive = true;
  let ceExitPrice = 0;
  let peExitPrice = 0;

  const activeCandles = candles.filter(c => {
    const time = c.timestamp.split('T')[1].substring(0, 5);
    return time >= '11:00' && time <= '15:29';
  });

  for (const c of activeCandles) {
    const time = c.timestamp.split('T')[1].substring(0, 5);
    const opt = c.options ? c.options[atm] : null;

    if (ceActive && opt && opt.CE && opt.CE.high >= ceSl) {
      ceActive = false;
      ceExitPrice = ceSl;
    }
    if (peActive && opt && opt.PE && opt.PE.high >= peSl) {
      peActive = false;
      peExitPrice = peSl;
    }

    if (time === '15:29') {
      if (ceActive) ceExitPrice = (opt && opt.CE) ? opt.CE.close : ceEntryPrice;
      if (peActive) peExitPrice = (opt && opt.PE) ? opt.PE.close : peEntryPrice;
      break;
    }
  }

  const cePnL = (ceEntryPrice - ceExitPrice) * 65;
  const pePnL = (peEntryPrice - peExitPrice) * 65;
  const scriptPnL = cePnL + pePnL;

  matchedDays++;
  totalScriptPnLForCsvDates += scriptPnL;

  const diffAmount = scriptPnL - csvData.csvPnL;
  if (Math.abs(diffAmount) > 100) {
    const ceLeg = csvData.legs.find(l => l.type === 'CE');
    const peLeg = csvData.legs.find(l => l.type === 'PE');
    diffs.push({
      date,
      strike: atm,
      csvStrike: ceLeg ? ceLeg.strike : 'N/A',
      csvCE_Open: ceLeg ? ceLeg.entryPrice : 'N/A',
      scriptCE_Open: ceEntryPrice,
      csvPE_Open: peLeg ? peLeg.entryPrice : 'N/A',
      scriptPE_Open: peEntryPrice,
      csvPnL: csvData.csvPnL,
      scriptPnL: Math.round(scriptPnL),
      diff: Math.round(diffAmount)
    });
  }
}

console.log(`Matched Trading Days: ${matchedDays} / ${csvDates.length}`);
console.log(`Script Net PnL for CSV Date Range: Rs ${Math.round(totalScriptPnLForCsvDates)}`);
console.log(`User CSV Net PnL: Rs ${Math.round(totalCsvPnL)}`);
console.log(`Difference: Rs ${Math.round(totalScriptPnLForCsvDates - totalCsvPnL)}\n`);

console.log('Sample Day-by-Day Discrepancies (Top 15 Largest Differences):');
diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.table(diffs.slice(0, 15));
