/**
 * optimize_hedged_straddle.js
 * 
 * Extends the optimized Short Straddle strategy by adding Buy (hedge) legs
 * to reduce margin requirements. Tests all available buy strike offsets.
 * 
 * Base strategy (from optimization): 12:00 entry, 15:29 exit, 30% Leg SL, 
 * No Overall SL, ATM (offset 0), PARTIAL square-off, No TSL.
 * Net Profit: Rs 1,96,449
 * 
 * Constraints:
 * - Buy legs must NOT be exited before sold legs (margin protection)
 * - Addition of buy legs should NOT decrease baseline performance significantly
 * - Buy strikes are OTM (further from ATM than sold strikes)
 * 
 * Usage:
 *   node scripts/optimize_hedged_straddle.js
 */

const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min'),
  lotSize: 65,
  strikeStep: 50,
};

// Base strategy params (best from previous optimization)
const BASE = {
  entryTime: '12:00',
  exitTime: '15:29',
  legSlPct: 30,
  overallSl: null,
  offset: 0,            // ATM
  squareOffMode: 'PARTIAL',
  trailingSlStep: null,
};

// 1. Load data recursively
if (!fs.existsSync(config.dataDir)) {
  console.error('ERROR: Data directory does not exist. Fetch data first.');
  process.exit(1);
}

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

const filePaths = getAllJsonFiles(config.dataDir);
console.log(`Loading data from ${filePaths.length} daily files...`);

let marketData = [];
for (const filePath of filePaths) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    marketData = marketData.concat(raw);
  } catch (err) {
    console.error('Error reading ' + filePath + ': ' + err.message);
  }
}

console.log('Loaded ' + marketData.length + ' total candles.');

// Group candles by date
const daysMap = {};
marketData.forEach(c => {
  const date = c.timestamp.split('T')[0];
  if (!daysMap[date]) daysMap[date] = [];
  daysMap[date].push(c);
});

const tradingDays = Object.keys(daysMap).sort();
console.log('Total trading days: ' + tradingDays.length);

// Parse HH:MM to minutes from midnight
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// ----------------------------------------------------
// Core Simulation Function
// ----------------------------------------------------
function runHedgedStraddle(buyOffset) {
  let totalPnL = 0;
  let totalTrades = 0;
  let winTrades = 0;
  let lossTrades = 0;
  let maxDrawdown = 0;
  let peakEquity = 0;
  let currentEquity = 0;
  let buyLegExitsWithSellCount = 0;
  let missingStrikeDays = 0;

  const dailyResults = [];

  for (const date of tradingDays) {
    const candles = daysMap[date];
    if (candles.length === 0) continue;

    // Find entry candle
    const entryCandle = candles.find(c => {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      return time === BASE.entryTime;
    });

    if (!entryCandle || !entryCandle.options) {
      continue; // Skip if no data at entry time
    }

    const spotAtEntry = entryCandle.close;
    const atmStrike = entryCandle.atmStrike || (Math.round(spotAtEntry / config.strikeStep) * config.strikeStep);
    
    // Sold leg strikes (ATM + offset)
    const sellCeStrike = atmStrike + BASE.offset;
    const sellPeStrike = atmStrike - BASE.offset;

    // Check if sold strikes exist in entry candle
    const ceOptEntry = entryCandle.options[sellCeStrike];
    const peOptEntry = entryCandle.options[sellPeStrike];

    if (!ceOptEntry || !ceOptEntry.CE || !peOptEntry || !peOptEntry.PE) {
      continue;
    }

    var ceEntryPrice = ceOptEntry.CE.open;
    var peEntryPrice = peOptEntry.PE.open;

    // Buy legs (OTM hedge)
    var buyCeStrike = null;
    var buyCeEntryPrice = 0;
    var buyCeExitPrice = 0;
    var buyPeStrike = null;
    var buyPeEntryPrice = 0;
    var buyPeExitPrice = 0;
    var hasBuyLegs = false;

    if (buyOffset !== null) {
      buyCeStrike = atmStrike + buyOffset;
      buyPeStrike = atmStrike - buyOffset;

      const buyCeOpt = entryCandle.options[buyCeStrike];
      const buyPeOpt = entryCandle.options[buyPeStrike];

      if (buyCeOpt && buyCeOpt.CE && buyPeOpt && buyPeOpt.PE) {
        buyCeEntryPrice = buyCeOpt.CE.open;
        buyPeEntryPrice = buyPeOpt.PE.open;
        hasBuyLegs = true;
      } else {
        missingStrikeDays++;
        // If requested buy strikes don't exist in option chain, skip day or skip hedge
        continue;
      }
    }

    // Stop Losses for Sold Legs
    const ceSl = ceEntryPrice * (1 + BASE.legSlPct / 100);
    const peSl = peEntryPrice * (1 + BASE.legSlPct / 100);

    let ceActive = true;
    let peActive = true;
    let ceExitPrice = 0;
    let peExitPrice = 0;
    let ceExitTime = '';
    let peExitTime = '';

    // Buy legs active state
    let buyCeActive = hasBuyLegs;
    let buyPeActive = hasBuyLegs;

    const entryMinutes = toMinutes(BASE.entryTime);
    const exitMinutes = toMinutes(BASE.exitTime);

    // Filter intraday candles after entry
    const activeCandles = candles.filter(c => {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      const m = toMinutes(time);
      return m >= entryMinutes && m <= exitMinutes;
    });

    for (const c of activeCandles) {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      const m = toMinutes(time);

      const ceOpt = c.options ? c.options[sellCeStrike] : null;
      const peOpt = c.options ? c.options[sellPeStrike] : null;
      const buyCeOpt = (hasBuyLegs && c.options) ? c.options[buyCeStrike] : null;
      const buyPeOpt = (hasBuyLegs && c.options) ? c.options[buyPeStrike] : null;

      // 1. Check CE Sold Leg SL
      if (ceActive && ceOpt && ceOpt.CE) {
        if (ceOpt.CE.high >= ceSl) {
          ceActive = false;
          ceExitPrice = ceSl; // Assume SL hit price
          ceExitTime = time;
        }
      }

      // 2. Check PE Sold Leg SL
      if (peActive && peOpt && peOpt.PE) {
        if (peOpt.PE.high >= peSl) {
          peActive = false;
          peExitPrice = peSl;
          peExitTime = time;
        }
      }

      // Check if both sold legs hit SL -> Full Square Off
      if (BASE.squareOffMode === 'FULL' && (!ceActive || !peActive)) {
        if (ceActive) {
          ceActive = false;
          ceExitPrice = (ceOpt && ceOpt.CE) ? ceOpt.CE.close : ceEntryPrice;
          ceExitTime = time;
        }
        if (peActive) {
          peActive = false;
          peExitPrice = (peOpt && peOpt.PE) ? peOpt.PE.close : peEntryPrice;
          peExitTime = time;
        }
      }

      // End of day forced exit
      if (m === exitMinutes) {
        if (ceActive) {
          ceActive = false;
          ceExitPrice = (ceOpt && ceOpt.CE) ? ceOpt.CE.close : ceEntryPrice;
          ceExitTime = time;
        }
        if (peActive) {
          peActive = false;
          peExitPrice = (peOpt && peOpt.PE) ? peOpt.PE.close : peEntryPrice;
          peExitTime = time;
        }

        // Exit Buy Legs at EOD
        if (buyCeActive) {
          buyCeActive = false;
          buyCeExitPrice = (buyCeOpt && buyCeOpt.CE) ? buyCeOpt.CE.close : buyCeEntryPrice;
        }
        if (buyPeActive) {
          buyPeActive = false;
          buyPeExitPrice = (buyPeOpt && buyPeOpt.PE) ? buyPeOpt.PE.close : buyPeEntryPrice;
        }
        break;
      }
    }

    // ----------------------------------------------------
    // Calculate PnL
    // ----------------------------------------------------
    // Sold Legs PnL (Sell High, Buy Low) -> (Entry - Exit)
    const ceSoldPnL = (ceEntryPrice - ceExitPrice) * config.lotSize;
    const peSoldPnL = (peEntryPrice - peExitPrice) * config.lotSize;
    const soldPnL = ceSoldPnL + peSoldPnL;

    // Bought Legs PnL (Buy Low, Sell High) -> (Exit - Entry)
    let boughtPnL = 0;
    if (hasBuyLegs) {
      const buyCePnL = (buyCeExitPrice - buyCeEntryPrice) * config.lotSize;
      const buyPePnL = (buyPeExitPrice - buyPeEntryPrice) * config.lotSize;
      boughtPnL = buyCePnL + buyPePnL;
    }

    const dayPnL = soldPnL + boughtPnL;

    totalPnL += dayPnL;
    totalTrades++;
    if (dayPnL > 0) winTrades++;
    else if (dayPnL < 0) lossTrades++;

    currentEquity += dayPnL;
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    dailyResults.push({
      date,
      atmStrike,
      sellCePrice: ceEntryPrice,
      sellPePrice: peEntryPrice,
      buyCePrice: buyCeEntryPrice,
      buyPePrice: buyPeEntryPrice,
      soldPnL,
      boughtPnL,
      dayPnL,
    });
  }

  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(2) : 0;

  return {
    buyOffset: buyOffset === null ? 'UNHEDGED (Naked)' : `+${buyOffset} pts`,
    totalPnL: Math.round(totalPnL),
    totalTrades,
    winRate: winRate + '%',
    maxDrawdown: Math.round(maxDrawdown),
    missingStrikeDays,
    profitFactor: calculateProfitFactor(dailyResults),
  };
}

function calculateProfitFactor(dailyResults) {
  let grossProfit = 0;
  let grossLoss = 0;

  dailyResults.forEach(r => {
    if (r.dayPnL > 0) grossProfit += r.dayPnL;
    else if (r.dayPnL < 0) grossLoss += Math.abs(r.dayPnL);
  });

  return grossLoss === 0 ? 'INF' : (grossProfit / grossLoss).toFixed(2);
}

// ----------------------------------------------------
// Execution: Test Baseline & Buy Offset Options
// ----------------------------------------------------
console.log('\n========================================================================');
console.log('  OPTIMIZING HEDGED SHORT STRADDLE (BUY HEDGE LEGS)');
console.log('========================================================================');

// Test Offsets: 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000
const buyOffsetsToTest = [null, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000];

const summaryTable = [];

for (const offset of buyOffsetsToTest) {
  const result = runHedgedStraddle(offset);
  summaryTable.push(result);
}

console.table(summaryTable);

console.log('\n========================================================================');
console.log('  OPTIMIZATION COMPLETE');
console.log('========================================================================\n');
