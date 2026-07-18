/**
 * optimize_hedged_straddle_v2.js
 * 
 * Runs a grid search to optimize Short Straddle + OTM Long Hedges to minimize margin.
 * Incorporates:
 * - Trailing SL on sold legs
 * - Dynamic OTM hedge buying based on target option premiums (e.g. Rs 2, 3, 5, 10)
 * - Safe hedge exit rules (never exit hedges before sold legs are closed)
 * - Removes re-entry combinations
 */

const fs = require('fs');
const path = require('path');

const config = {
  dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min'),
  lotSize: 65,
  strikeStep: 50,
};

const BASE = {
  entryTime: '12:00',
  exitTime: '15:29',
};

// 1. Load data recursively
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

// Build structured day candles
const days = tradingDays.map(dateStr => {
  const candles = daysMap[dateStr].sort((a, b) => {
    const ta = a.timestamp.split('T')[1].substring(0, 5);
    const tb = b.timestamp.split('T')[1].substring(0, 5);
    return ta.localeCompare(tb);
  });
  const timeMap = new Map();
  candles.forEach((c, idx) => {
    const time = c.timestamp.split('T')[1].substring(0, 5);
    timeMap.set(time, idx);
  });
  return { dateStr, candles, timeMap };
});

// Core simulation function
function runSimulation(entryTime, exitTime, legSlPct, overallSl, trailingSlStep, targetHedge) {
  let totalPnL = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let maxDrawdown = 0;
  let peakEquity = 0;
  let currentEquity = 0;

  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const entryIdx = day.timeMap.get(entryTime);
    let exitIdx = day.timeMap.get(exitTime);

    if (entryIdx === undefined) continue;
    if (exitIdx === undefined) {
      exitIdx = day.candles.length - 1;
    }
    if (entryIdx >= exitIdx) continue;

    const entryCandle = day.candles[entryIdx];
    const spotEntry = entryCandle.close;
    const atmStrike = Math.round(spotEntry / config.strikeStep) * config.strikeStep;
    
    const sellCeStrike = atmStrike;
    const sellPeStrike = atmStrike;

    if (!entryCandle.options || !entryCandle.options[sellCeStrike] || !entryCandle.options[sellPeStrike]) {
      continue;
    }

    const ceOptEntry = entryCandle.options[sellCeStrike];
    const peOptEntry = entryCandle.options[sellPeStrike];

    const ceEntryPrice = ceOptEntry.CE.open;
    const peEntryPrice = peOptEntry.PE.open;

    // Find hedge strikes (buy legs)
    let buyCeStrike = null;
    let buyPeStrike = null;
    let buyCeEntryPrice = 0;
    let buyPeEntryPrice = 0;
    let hasHedge = false;

    if (targetHedge && targetHedge.type !== 'naked') {
      if (targetHedge.type === 'premium') {
        const targetHedgePremium = targetHedge.value;
        let bestCeStrike = null;
        let minCeDiff = Infinity;
        let bestPeStrike = null;
        let minPeDiff = Infinity;

        for (const strikeStr in entryCandle.options) {
          const strike = parseInt(strikeStr, 10);
          const opt = entryCandle.options[strikeStr];
          
          // CE hedge must be OTM (strike >= ATM)
          if (strike >= atmStrike && opt.CE && opt.CE.open > 0) {
            const diff = Math.abs(opt.CE.open - targetHedgePremium);
            if (diff < minCeDiff) {
              minCeDiff = diff;
              bestCeStrike = strike;
            }
          }
          // PE hedge must be OTM (strike <= ATM)
          if (strike <= atmStrike && opt.PE && opt.PE.open > 0) {
            const diff = Math.abs(opt.PE.open - targetHedgePremium);
            if (diff < minPeDiff) {
              minPeDiff = diff;
              bestPeStrike = strike;
            }
          }
        }

        if (bestCeStrike !== null && bestPeStrike !== null) {
          buyCeStrike = bestCeStrike;
          buyPeStrike = bestPeStrike;
          buyCeEntryPrice = entryCandle.options[buyCeStrike].CE.open;
          buyPeEntryPrice = entryCandle.options[buyPeStrike].PE.open;
          hasHedge = true;
        }
      } else if (targetHedge.type === 'offset') {
        const offsetVal = targetHedge.value;
        buyCeStrike = atmStrike + offsetVal;
        buyPeStrike = atmStrike - offsetVal;
        const buyCeOpt = entryCandle.options[buyCeStrike];
        const buyPeOpt = entryCandle.options[buyPeStrike];
        if (buyCeOpt && buyCeOpt.CE && buyPeOpt && buyPeOpt.PE) {
          buyCeEntryPrice = buyCeOpt.CE.open;
          buyPeEntryPrice = buyPeOpt.PE.open;
          hasHedge = true;
        }
      }
    }

    let ceStatus = 'OPEN';
    let peStatus = 'OPEN';
    let ceExitPrice = null;
    let peExitPrice = null;

    const originalCeSlLevel = legSlPct !== null ? ceEntryPrice * (1 + legSlPct / 100) : Infinity;
    const originalPeSlLevel = legSlPct !== null ? peEntryPrice * (1 + legSlPct / 100) : Infinity;

    let ceSlLevel = originalCeSlLevel;
    let peSlLevel = originalPeSlLevel;

    let ceLowestPrice = ceEntryPrice;
    let peLowestPrice = peEntryPrice;

    let buyCeActive = hasHedge;
    let buyPeActive = hasHedge;
    let buyCeExitPrice = 0;
    let buyPeExitPrice = 0;

    // Minute-by-minute simulation
    for (let i = entryIdx; i <= exitIdx; i++) {
      const c = day.candles[i];
      const ceOpt = c.options[sellCeStrike];
      const peOpt = c.options[sellPeStrike];
      if (!ceOpt || !peOpt) continue;

      // 1. Update Trailing SL levels
      if (trailingSlStep !== null) {
        if (ceStatus === 'OPEN') {
          ceLowestPrice = Math.min(ceLowestPrice, ceOpt.CE.low);
          if (ceLowestPrice < ceEntryPrice) {
            const steps = Math.floor((ceEntryPrice - ceLowestPrice) / trailingSlStep);
            ceSlLevel = originalCeSlLevel - (steps * trailingSlStep);
          }
        }
        if (peStatus === 'OPEN') {
          peLowestPrice = Math.min(peLowestPrice, peOpt.PE.low);
          if (peLowestPrice < peEntryPrice) {
            const steps = Math.floor((peEntryPrice - peLowestPrice) / trailingSlStep);
            peSlLevel = originalPeSlLevel - (steps * trailingSlStep);
          }
        }
      }

      // 2. Check Stop Loss (evaluated on High of candle)
      if (ceStatus === 'OPEN' && ceOpt.CE.high >= ceSlLevel) {
        ceStatus = 'CLOSED';
        ceExitPrice = ceOpt.CE.open > ceSlLevel ? ceOpt.CE.open : ceSlLevel;
      }

      if (peStatus === 'OPEN' && peOpt.PE.high >= peSlLevel) {
        peStatus = 'CLOSED';
        peExitPrice = peOpt.PE.open > peSlLevel ? peOpt.PE.open : peSlLevel;
      }

      // 3. Check Overall daily Stop Loss (evaluated on Close of candle)
      let currentCePnl = 0;
      let currentPePnl = 0;

      if (ceStatus === 'OPEN') {
        currentCePnl = (ceEntryPrice - ceOpt.CE.close) * config.lotSize;
      } else {
        currentCePnl = (ceEntryPrice - ceExitPrice) * config.lotSize;
      }

      if (peStatus === 'OPEN') {
        currentPePnl = (peEntryPrice - peOpt.PE.close) * config.lotSize;
      } else {
        currentPePnl = (peEntryPrice - peExitPrice) * config.lotSize;
      }

      const combinedPnl = currentCePnl + currentPePnl;
      if (overallSl !== null && combinedPnl <= -overallSl) {
        if (ceStatus === 'OPEN') {
          ceStatus = 'CLOSED';
          ceExitPrice = ceOpt.CE.close;
        }
        if (peStatus === 'OPEN') {
          peStatus = 'CLOSED';
          peExitPrice = peOpt.PE.close;
        }
      }

      // Safe buy exit: if BOTH sold legs are closed, exit buy legs immediately to lock in value
      if (hasHedge && buyCeActive && ceStatus === 'CLOSED' && peStatus === 'CLOSED') {
        buyCeActive = false;
        buyPeActive = false;
        const buyCeOpt = c.options[buyCeStrike];
        const buyPeOpt = c.options[buyPeStrike];
        buyCeExitPrice = (buyCeOpt && buyCeOpt.CE) ? buyCeOpt.CE.close : buyCeEntryPrice;
        buyPeExitPrice = (buyPeOpt && buyPeOpt.PE) ? buyPeOpt.PE.close : buyPeEntryPrice;
        break;
      }

      if (ceStatus === 'CLOSED' && peStatus === 'CLOSED') {
        break;
      }
    }

    // Exit remaining active sold legs at final exit candle close
    const exitCandle = day.candles[exitIdx];
    const ceOptExit = exitCandle.options[sellCeStrike];
    const peOptExit = exitCandle.options[sellPeStrike];

    if (ceStatus === 'OPEN') {
      ceStatus = 'CLOSED';
      ceExitPrice = ceOptExit ? ceOptExit.CE.close : ceEntryPrice;
    }
    if (peStatus === 'OPEN') {
      peStatus = 'CLOSED';
      peExitPrice = peOptExit ? peOptExit.PE.close : peEntryPrice;
    }

    // Exit bought legs at final exit if still active
    if (hasHedge && buyCeActive) {
      buyCeActive = false;
      buyPeActive = false;
      const buyCeOptExit = exitCandle.options[buyCeStrike];
      const buyPeOptExit = exitCandle.options[buyPeStrike];
      buyCeExitPrice = (buyCeOptExit && buyCeOptExit.CE) ? buyCeOptExit.CE.close : buyCeEntryPrice;
      buyPeExitPrice = (buyPeOptExit && buyPeOptExit.PE) ? buyPeOptExit.PE.close : buyPeEntryPrice;
    }

    const dayCePnl = (ceEntryPrice - ceExitPrice) * config.lotSize;
    const dayPePnl = (peEntryPrice - peExitPrice) * config.lotSize;
    const soldPnL = dayCePnl + dayPePnl;

    let boughtPnL = 0;
    if (hasHedge) {
      const buyCePnL = (buyCeExitPrice - buyCeEntryPrice) * config.lotSize;
      const buyPePnL = (buyPeExitPrice - buyPeEntryPrice) * config.lotSize;
      boughtPnL = buyCePnL + buyPePnL;
    }

    const dayPnL = soldPnL + boughtPnL;

    totalPnL += dayPnL;
    totalTrades++;
    if (dayPnL > 0) wins++;
    else losses++;

    currentEquity += dayPnL;
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0;

  return {
    entryTime,
    exitTime,
    legSlPct,
    overallSl: overallSl === null ? 'None' : overallSl,
    trailingSlStep: trailingSlStep === null ? 'None' : trailingSlStep,
    targetHedge: targetHedge.label,
    totalPnL: Math.round(totalPnL),
    winRate: winRate + '%',
    maxDrawdown: Math.round(maxDrawdown),
  };
}

// Grid Search parameter arrays
const entryTimeOptions = ['09:20', '09:30', '10:00', '10:30', '11:00', '12:00'];
const exitTimeOptions  = ['14:00', '15:00', '15:15', '15:29'];
const legSlOptions = [25, 30, 40];
const overallSlOptions = [null, 4000];
const trailingSlOptions = [null, 5, 10];

const targetHedgeOptions = [
  { type: 'naked',   label: 'Naked' },
  { type: 'premium', value: 2,   label: 'Rs 2 Prem' },
  { type: 'premium', value: 5,   label: 'Rs 5 Prem' },
  { type: 'premium', value: 10,  label: 'Rs 10 Prem' },
  { type: 'offset',  value: 400, label: '+400 Offset' },
  { type: 'offset',  value: 600, label: '+600 Offset' },
];

const totalCombinations = entryTimeOptions.length * exitTimeOptions.length * legSlOptions.length * overallSlOptions.length * trailingSlOptions.length * targetHedgeOptions.length;
console.log(`Running Hedged Straddle Grid Search... (${totalCombinations} combinations)`);
const results = [];

for (const entryTime of entryTimeOptions) {
  for (const exitTime of exitTimeOptions) {
    for (const legSl of legSlOptions) {
      for (const overallSl of overallSlOptions) {
        for (const trailingSl of trailingSlOptions) {
          for (const targetHedge of targetHedgeOptions) {
            results.push(runSimulation(entryTime, exitTime, legSl, overallSl, trailingSl, targetHedge));
          }
        }
      }
    }
  }
}

// Sort results by total PnL descending
results.sort((a, b) => b.totalPnL - a.totalPnL);

console.log('\nTop 30 Combinations (all entry/exit times, hedges, SL combos):');
console.table(results.slice(0, 30));

console.log('\nBaseline (12:00 entry, 15:29 exit, Naked, 30% Leg SL, No SL, No TSL):');
const baseline = results.find(r =>
  r.entryTime === '12:00' && r.exitTime === '15:29' &&
  r.legSlPct === 30 && r.overallSl === 'None' &&
  r.trailingSlStep === 'None' && r.targetHedge === 'Naked'
);
console.log(baseline);

// Also show best naked combination per entry time
console.log('\n--- Best Naked Combination Per Entry Time ---');
for (const et of entryTimeOptions) {
  const best = results.find(r => r.entryTime === et && r.targetHedge === 'Naked');
  if (best) console.log(`  ${et}: ₹${best.totalPnL.toLocaleString()} | Exit: ${best.exitTime} | WR: ${best.winRate} | Max DD: ₹${best.maxDrawdown.toLocaleString()} | LegSL: ${best.legSlPct}% | OvSL: ${best.overallSl}`);
}
