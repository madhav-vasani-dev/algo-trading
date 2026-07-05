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

// 1. Load data
if (!fs.existsSync(config.dataDir)) {
  console.error('ERROR: Data directory does not exist. Fetch data first.');
  process.exit(1);
}

const files = fs.readdirSync(config.dataDir).filter(f => f.endsWith('.json')).sort();
console.log('Loading data files...');

let marketData = [];
for (const file of files) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.dataDir, file), 'utf8'));
    marketData = marketData.concat(raw);
  } catch (err) {
    console.error('Error reading ' + file + ': ' + err.message);
  }
}

console.log('Loaded ' + marketData.length + ' total candles.');

// 2. Group candles by date
const daysMap = new Map();
marketData.forEach(function (c) {
  const dateStr = c.timestamp.substring(0, 10);
  const timeStr = c.timestamp.substring(11, 16);
  if (!daysMap.has(dateStr)) {
    daysMap.set(dateStr, []);
  }
  daysMap.get(dateStr).push({
    timeStr: timeStr,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    options: c.options
  });
});

const days = Array.from(daysMap.entries()).map(function (entry) {
  var dateStr = entry[0];
  var candles = entry[1];
  candles.sort(function (a, b) { return a.timeStr.localeCompare(b.timeStr); });
  var timeMap = new Map();
  candles.forEach(function (c, idx) {
    timeMap.set(c.timeStr, idx);
  });
  return { dateStr: dateStr, candles: candles, timeMap: timeMap };
}).sort(function (a, b) { return a.dateStr.localeCompare(b.dateStr); });

console.log('Grouped into ' + days.length + ' trading days.');

// 3. Simulation function for hedged straddle
// buyOffset = how many points further OTM from ATM to buy (e.g. 100 means buy CE at ATM+100, PE at ATM-100)
// If buyOffset is null, no hedge (naked straddle)
function runHedgedSimulation(buyOffset) {
  var totalPnl = 0;
  var totalTrades = 0;
  var wins = 0;
  var losses = 0;
  var maxCapital = 200000;
  var currentCapital = 200000;
  var maxDrawdown = 0;
  var totalBuyCost = 0;
  var skippedDays = 0;
  var dailyResults = [];

  for (var d = 0; d < days.length; d++) {
    var day = days[d];
    var entryIdx = day.timeMap.get(BASE.entryTime);
    var exitIdx = day.timeMap.get(BASE.exitTime);

    if (entryIdx === undefined) continue;
    if (exitIdx === undefined) {
      exitIdx = day.candles.length - 1;
    }
    if (entryIdx >= exitIdx) continue;

    var entryCandle = day.candles[entryIdx];
    var spotEntry = entryCandle.open;
    var atmStrike = Math.round(spotEntry / config.strikeStep) * config.strikeStep;

    // Sold legs (ATM straddle)
    var ceStrike = atmStrike + BASE.offset;
    var peStrike = atmStrike - BASE.offset;

    if (!entryCandle.options || !entryCandle.options[ceStrike] || !entryCandle.options[peStrike]) {
      continue;
    }

    var ceOptEntry = entryCandle.options[ceStrike];
    var peOptEntry = entryCandle.options[peStrike];

    if (!ceOptEntry.CE || !peOptEntry.PE) continue;

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

      // Check if buy strikes exist in data
      var buyCeOpt = entryCandle.options[buyCeStrike];
      var buyPeOpt = entryCandle.options[buyPeStrike];

      if (!buyCeOpt || !buyCeOpt.CE || !buyPeOpt || !buyPeOpt.PE) {
        // If buy strikes not available, skip this day for hedged strategy
        skippedDays++;
        continue;
      }

      buyCeEntryPrice = buyCeOpt.CE.open;
      buyPeEntryPrice = buyPeOpt.PE.open;
      hasBuyLegs = true;
      totalBuyCost += (buyCeEntryPrice + buyPeEntryPrice) * config.lotSize;
    }

    // Simulation state for sold legs
    var ceStatus = 'OPEN';
    var peStatus = 'OPEN';
    var ceExitPrice = null;
    var peExitPrice = null;

    var ceSlLevel = BASE.legSlPct !== null ? ceEntryPrice * (1 + BASE.legSlPct / 100) : Infinity;
    var peSlLevel = BASE.legSlPct !== null ? peEntryPrice * (1 + BASE.legSlPct / 100) : Infinity;

    // Minute-by-minute simulation
    for (var i = entryIdx; i <= exitIdx; i++) {
      var c = day.candles[i];
      var ceOpt = c.options[ceStrike];
      var peOpt = c.options[peStrike];
      if (!ceOpt || !peOpt) continue;

      // Check Stop Loss for sold CE leg
      if (ceStatus === 'OPEN' && ceOpt.CE.high >= ceSlLevel) {
        ceStatus = 'CLOSED';
        ceExitPrice = ceOpt.CE.open > ceSlLevel ? ceOpt.CE.open : ceSlLevel;

        if (BASE.squareOffMode === 'COMPLETE') {
          peStatus = 'CLOSED';
          peExitPrice = peOpt.PE.close;
          break;
        }
      }

      // Check Stop Loss for sold PE leg
      if (peStatus === 'OPEN' && peOpt.PE.high >= peSlLevel) {
        peStatus = 'CLOSED';
        peExitPrice = peOpt.PE.open > peSlLevel ? peOpt.PE.open : peSlLevel;

        if (BASE.squareOffMode === 'COMPLETE') {
          ceStatus = 'CLOSED';
          ceExitPrice = ceOpt.CE.close;
          break;
        }
      }
    }

    // Exit remaining sold legs at final exit candle close
    var exitCandle = day.candles[exitIdx];
    var ceOptExit = exitCandle.options[ceStrike];
    var peOptExit = exitCandle.options[peStrike];

    if (ceStatus === 'OPEN') {
      ceExitPrice = ceOptExit ? ceOptExit.CE.close : ceEntryPrice;
    }
    if (peStatus === 'OPEN') {
      peExitPrice = peOptExit ? peOptExit.PE.close : peEntryPrice;
    }

    // Buy legs: EXIT only at the exit time (never before sold legs)
    // Buy legs profit = (exitPrice - entryPrice) * lotSize (we are long)
    if (hasBuyLegs) {
      var buyCeOptExit = exitCandle.options[buyCeStrike];
      var buyPeOptExit = exitCandle.options[buyPeStrike];

      buyCeExitPrice = buyCeOptExit && buyCeOptExit.CE ? buyCeOptExit.CE.close : 0;
      buyPeExitPrice = buyPeOptExit && buyPeOptExit.PE ? buyPeOptExit.PE.close : 0;
    }

    // PnL calculation
    // Sold legs: entry - exit (short position profit)
    var dayCePnl = (ceEntryPrice - ceExitPrice) * config.lotSize;
    var dayPePnl = (peEntryPrice - peExitPrice) * config.lotSize;

    // Buy legs: exit - entry (long position profit)
    var dayBuyCePnl = 0;
    var dayBuyPePnl = 0;
    if (hasBuyLegs) {
      dayBuyCePnl = (buyCeExitPrice - buyCeEntryPrice) * config.lotSize;
      dayBuyPePnl = (buyPeExitPrice - buyPeEntryPrice) * config.lotSize;
    }

    var dayPnl = dayCePnl + dayPePnl + dayBuyCePnl + dayBuyPePnl;

    totalPnl += dayPnl;
    totalTrades++;
    if (dayPnl > 0) wins++;
    else losses++;

    currentCapital += dayPnl;
    if (currentCapital > maxCapital) {
      maxCapital = currentCapital;
    }
    var dd = maxCapital - currentCapital;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
    }

    dailyResults.push({
      date: day.dateStr,
      soldCePnl: dayCePnl,
      soldPePnl: dayPePnl,
      buyCePnl: dayBuyCePnl,
      buyPePnl: dayBuyPePnl,
      totalPnl: dayPnl,
      buyCeEntry: buyCeEntryPrice,
      buyPeEntry: buyPeEntryPrice,
      buyCeExit: buyCeExitPrice,
      buyPeExit: buyPeExitPrice,
    });
  }

  var winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  var recoveryFactor = maxDrawdown > 0 ? totalPnl / maxDrawdown : 0;

  return {
    netProfit: totalPnl,
    winRate: winRate,
    totalTrades: totalTrades,
    wins: wins,
    losses: losses,
    maxDrawdown: maxDrawdown,
    recoveryFactor: recoveryFactor,
    totalBuyCost: totalBuyCost,
    avgBuyCostPerDay: totalTrades > 0 ? totalBuyCost / totalTrades : 0,
    skippedDays: skippedDays,
    dailyResults: dailyResults,
  };
}

// 4. Run baseline (no hedge)
console.log('\n===================================================');
console.log('  BASELINE: NAKED SHORT STRADDLE (NO HEDGE)');
console.log('===================================================');

var baselineResult = runHedgedSimulation(null);
console.log('Net Profit : Rs ' + baselineResult.netProfit.toFixed(0));
console.log('Win Rate   : ' + baselineResult.winRate.toFixed(1) + '%');
console.log('Total Days : ' + baselineResult.totalTrades);
console.log('Max DD     : Rs ' + baselineResult.maxDrawdown.toFixed(0));
console.log('Recovery F.: ' + baselineResult.recoveryFactor.toFixed(2));

// 5. Test all possible buy offsets
console.log('\n===================================================');
console.log('  TESTING HEDGED STRADDLE COMBINATIONS');
console.log('===================================================');

// Buy offsets to test: from 50 to 400 points from ATM (step 50)
var buyOffsets = [50, 100, 150, 200, 250, 300, 350, 400];

var results = [];

for (var idx = 0; idx < buyOffsets.length; idx++) {
  var offset = buyOffsets[idx];
  console.log('\nTesting Buy Offset: ATM +/- ' + offset + ' points...');

  var res = runHedgedSimulation(offset);

  var profitDiff = res.netProfit - baselineResult.netProfit;
  var profitDiffPct = (profitDiff / Math.abs(baselineResult.netProfit)) * 100;

  results.push({
    buyOffset: offset,
    metrics: {
      netProfit: res.netProfit,
      winRate: res.winRate,
      totalTrades: res.totalTrades,
      wins: res.wins,
      losses: res.losses,
      maxDrawdown: res.maxDrawdown,
      recoveryFactor: res.recoveryFactor,
      totalBuyCost: res.totalBuyCost,
      avgBuyCostPerDay: res.avgBuyCostPerDay,
      skippedDays: res.skippedDays,
    },
    profitDiff: profitDiff,
    profitDiffPct: profitDiffPct,
  });

  console.log('  Net Profit  : Rs ' + res.netProfit.toFixed(0) +
    ' (' + (profitDiff >= 0 ? '+' : '') + profitDiff.toFixed(0) + ' | ' +
    (profitDiffPct >= 0 ? '+' : '') + profitDiffPct.toFixed(1) + '%)');
  console.log('  Win Rate    : ' + res.winRate.toFixed(1) + '%');
  console.log('  Total Days  : ' + res.totalTrades + ' (skipped: ' + res.skippedDays + ')');
  console.log('  Max DD      : Rs ' + res.maxDrawdown.toFixed(0));
  console.log('  Recovery F. : ' + res.recoveryFactor.toFixed(2));
  console.log('  Avg Buy Cost: Rs ' + res.avgBuyCostPerDay.toFixed(0) + '/day');
}

// 6. Summary Table
console.log('\n===================================================');
console.log('  SUMMARY: HEDGED STRADDLE RESULTS');
console.log('===================================================');

console.log('\n| Buy Offset | Net Profit | vs Baseline | Win Rate | Days | Skipped | Max DD | Recovery F | Avg Buy Cost/Day |');
console.log('|------------|------------|-------------|----------|------|---------|--------|------------|------------------|');

// First row: baseline
console.log('| NONE (Naked) | Rs ' + baselineResult.netProfit.toFixed(0) +
  ' | BASELINE | ' + baselineResult.winRate.toFixed(1) + '% | ' +
  baselineResult.totalTrades + ' | 0 | Rs ' + baselineResult.maxDrawdown.toFixed(0) +
  ' | ' + baselineResult.recoveryFactor.toFixed(2) + ' | Rs 0 |');

for (var i = 0; i < results.length; i++) {
  var r = results[i];
  var diffStr = (r.profitDiff >= 0 ? '+' : '') + 'Rs ' + r.profitDiff.toFixed(0) + 
    ' (' + (r.profitDiffPct >= 0 ? '+' : '') + r.profitDiffPct.toFixed(1) + '%)';
  console.log('| ATM +/- ' + r.buyOffset + ' | Rs ' + r.metrics.netProfit.toFixed(0) +
    ' | ' + diffStr + ' | ' + r.metrics.winRate.toFixed(1) + '% | ' +
    r.metrics.totalTrades + ' | ' + r.metrics.skippedDays +
    ' | Rs ' + r.metrics.maxDrawdown.toFixed(0) +
    ' | ' + r.metrics.recoveryFactor.toFixed(2) +
    ' | Rs ' + r.metrics.avgBuyCostPerDay.toFixed(0) + ' |');
}

// 7. Filter: Only show combinations that don't reduce baseline profit
console.log('\n===================================================');
console.log('  VIABLE COMBINATIONS (Profit >= Baseline)');
console.log('===================================================');

var viable = results.filter(function (r) {
  return r.metrics.netProfit >= baselineResult.netProfit * 0.95; // Allow 5% tolerance
});

if (viable.length === 0) {
  console.log('No viable combinations found that maintain baseline profit.');
  console.log('All hedge combinations reduce net profit due to the cost of buying options.');
} else {
  console.log('\n| Buy Offset | Net Profit | vs Baseline | Win Rate | Max DD | Avg Buy Cost/Day |');
  console.log('|------------|------------|-------------|----------|--------|------------------|');
  for (var j = 0; j < viable.length; j++) {
    var v = viable[j];
    var vDiffStr = (v.profitDiff >= 0 ? '+' : '') + 'Rs ' + v.profitDiff.toFixed(0);
    console.log('| ATM +/- ' + v.buyOffset + ' | Rs ' + v.metrics.netProfit.toFixed(0) +
      ' | ' + vDiffStr + ' | ' + v.metrics.winRate.toFixed(1) + '% | Rs ' +
      v.metrics.maxDrawdown.toFixed(0) + ' | Rs ' + v.metrics.avgBuyCostPerDay.toFixed(0) + ' |');
  }
}

// 8. Save results
var outDir = path.join(__dirname, '..', 'public', 'data');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

var outFile = path.join(outDir, 'hedged_straddle_results.json');
var output = {
  baseline: {
    params: BASE,
    metrics: {
      netProfit: baselineResult.netProfit,
      winRate: baselineResult.winRate,
      totalTrades: baselineResult.totalTrades,
      wins: baselineResult.wins,
      losses: baselineResult.losses,
      maxDrawdown: baselineResult.maxDrawdown,
      recoveryFactor: baselineResult.recoveryFactor,
    }
  },
  hedgedResults: results,
  viableResults: viable,
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log('\nResults saved to ' + outFile);
