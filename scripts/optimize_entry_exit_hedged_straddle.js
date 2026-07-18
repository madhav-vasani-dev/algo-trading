/**
 * optimize_entry_exit_hedged_straddle.js
 * 
 * Grid-search optimizer for Short Straddle (Naked & Hedged) testing:
 * - Entry Times: 09:20, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30, 13:00, 13:30, 14:00
 * - Exit Times: 15:00, 15:15, 15:25, 15:29
 * - Leg SL Pct: 20%, 25%, 30%, 35%, 40%, 50%
 * - Buy Hedge Offsets: UNHEDGED (null), +500, +600, +700, +800 pts
 * 
 * Usage:
 *   node scripts/optimize_entry_exit_hedged_straddle.js
 */

const fs = require('fs');
const path = require('path');

const config = {
  dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min'),
  lotSize: 65,
  strikeStep: 50,
};

if (!fs.existsSync(config.dataDir)) {
  console.error('ERROR: Data directory does not exist.');
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

function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Optimization Grid Ranges
const entryTimes = ['09:20', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'];
const exitTimes = ['15:15', '15:25', '15:29'];
const legSlPcts = [20, 25, 30, 35, 40, 50];
const buyOffsets = [null, 500, 600, 700, 800];

function runSim(entryTime, exitTime, legSlPct, buyOffset) {
  let totalPnL = 0;
  let totalTrades = 0;
  let winTrades = 0;
  let lossTrades = 0;
  let maxDrawdown = 0;
  let peakEquity = 0;
  let currentEquity = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const entryMin = toMinutes(entryTime);
  const exitMin = toMinutes(exitTime);

  for (const date of tradingDays) {
    const candles = daysMap[date];
    if (candles.length === 0) continue;

    const entryCandle = candles.find(c => {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      return time === entryTime;
    });

    if (!entryCandle || !entryCandle.options) continue;

    const spotAtEntry = entryCandle.close;
    const atmStrike = entryCandle.atmStrike || (Math.round(spotAtEntry / config.strikeStep) * config.strikeStep);

    const ceOptEntry = entryCandle.options[atmStrike];
    const peOptEntry = entryCandle.options[atmStrike];

    if (!ceOptEntry || !ceOptEntry.CE || !peOptEntry || !peOptEntry.PE) continue;

    const ceEntryPrice = ceOptEntry.CE.open;
    const peEntryPrice = peOptEntry.PE.open;

    let buyCeStrike = null;
    let buyCeEntryPrice = 0;
    let buyCeExitPrice = 0;
    let buyPeStrike = null;
    let buyPeEntryPrice = 0;
    let buyPeExitPrice = 0;
    let hasBuyLegs = false;

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
        continue; // Skip if hedge strike missing
      }
    }

    const ceSl = ceEntryPrice * (1 + legSlPct / 100);
    const peSl = peEntryPrice * (1 + legSlPct / 100);

    let ceActive = true;
    let peActive = true;
    let ceExitPrice = 0;
    let peExitPrice = 0;

    let buyCeActive = hasBuyLegs;
    let buyPeActive = hasBuyLegs;

    const activeCandles = candles.filter(c => {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      const m = toMinutes(time);
      return m >= entryMin && m <= exitMin;
    });

    for (const c of activeCandles) {
      const time = c.timestamp.split('T')[1].substring(0, 5);
      const m = toMinutes(time);

      const ceOpt = c.options ? c.options[atmStrike] : null;
      const peOpt = c.options ? c.options[atmStrike] : null;
      const buyCeOpt = (hasBuyLegs && c.options) ? c.options[buyCeStrike] : null;
      const buyPeOpt = (hasBuyLegs && c.options) ? c.options[buyPeStrike] : null;

      if (ceActive && ceOpt && ceOpt.CE) {
        if (ceOpt.CE.high >= ceSl) {
          ceActive = false;
          ceExitPrice = ceSl;
        }
      }

      if (peActive && peOpt && peOpt.PE) {
        if (peOpt.PE.high >= peSl) {
          peActive = false;
          peExitPrice = peSl;
        }
      }

      if (m === exitMin) {
        if (ceActive) {
          ceActive = false;
          ceExitPrice = (ceOpt && ceOpt.CE) ? ceOpt.CE.close : ceEntryPrice;
        }
        if (peActive) {
          peActive = false;
          peExitPrice = (peOpt && peOpt.PE) ? peOpt.PE.close : peEntryPrice;
        }
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

    const ceSoldPnL = (ceEntryPrice - ceExitPrice) * config.lotSize;
    const peSoldPnL = (peEntryPrice - peExitPrice) * config.lotSize;
    let boughtPnL = 0;
    if (hasBuyLegs) {
      const buyCePnL = (buyCeExitPrice - buyCeEntryPrice) * config.lotSize;
      const buyPePnL = (buyPeExitPrice - buyPeEntryPrice) * config.lotSize;
      boughtPnL = buyCePnL + buyPePnL;
    }

    const dayPnL = ceSoldPnL + peSoldPnL + boughtPnL;
    totalPnL += dayPnL;
    totalTrades++;

    if (dayPnL > 0) {
      winTrades++;
      grossProfit += dayPnL;
    } else if (dayPnL < 0) {
      lossTrades++;
      grossLoss += Math.abs(dayPnL);
    }

    currentEquity += dayPnL;
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const winRate = totalTrades > 0 ? parseFloat(((winTrades / totalTrades) * 100).toFixed(2)) : 0;
  const pf = grossLoss === 0 ? 999 : parseFloat((grossProfit / grossLoss).toFixed(2));

  return {
    entryTime,
    exitTime,
    legSlPct,
    hedge: buyOffset === null ? 'Naked' : `+${buyOffset}`,
    totalPnL: Math.round(totalPnL),
    totalTrades,
    winRate: winRate + '%',
    maxDrawdown: Math.round(maxDrawdown),
    profitFactor: pf
  };
}

console.log('\n========================================================================');
console.log('  RUNNING ENTRY / EXIT / SL GRID OPTIMIZER');
console.log('========================================================================\n');

const results = [];

for (const entry of entryTimes) {
  for (const exit of exitTimes) {
    for (const sl of legSlPcts) {
      for (const offset of buyOffsets) {
        const sim = runSim(entry, exit, sl, offset);
        if (sim.totalTrades >= 350) {
          results.push(sim);
        }
      }
    }
  }
}

// Sort by highest Net Profit
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log(`Grid search complete (${results.length} total combinations evaluated).\n`);

console.log('🏆 TOP 15 OVERALL BEST STRATEGY CONFIGURATIONS BY NET PROFIT:');
console.table(results.slice(0, 15));

console.log('\n🛡️ TOP 10 HEDGED STRATEGY CONFIGURATIONS (BUY LEGS ATTACHED):');
const hedgedOnly = results.filter(r => r.hedge !== 'Naked');
console.table(hedgedOnly.slice(0, 10));
