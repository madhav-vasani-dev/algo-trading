/**
 * optimize_straddle.js
 * 
 * Runs a pruned grid search to optimize Short Straddle / Strangle strategy parameters,
 * including trailing stop losses (TSL), offsets, square-off modes, and exit times.
 * It also validates baseline results against the provided AlgoTest trade logs.
 * 
 * Usage:
 *   node scripts/optimize_straddle.js <NIFTY|BANKNIFTY> [csv_log_file]
 */

const fs = require('fs');
const path = require('path');

const INDEX = process.argv[2];
const CSV_FILE = process.argv[3];

if (!INDEX || (INDEX !== 'NIFTY' && INDEX !== 'BANKNIFTY')) {
  console.error('ERROR: Index name is required. Must be NIFTY or BANKNIFTY.');
  console.log('Usage: node scripts/optimize_straddle.js <NIFTY|BANKNIFTY> [csv_log_file]');
  process.exit(1);
}

const config = {
  NIFTY: {
    dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min'),
    lotSize: 65,
    strikeStep: 50,
    baselineLegSl: 70,
    baselineOverallSl: 3000
  },
  BANKNIFTY: {
    dataDir: path.join(__dirname, '..', 'public', 'data', 'banknifty_1min'),
    lotSize: 30,
    strikeStep: 100,
    baselineLegSl: 70,
    baselineOverallSl: 1000
  }
}[INDEX];

// 1. Load historical JSON candles
if (!fs.existsSync(config.dataDir)) {
  console.error(`ERROR: Data directory ${config.dataDir} does not exist. Fetch data first.`);
  process.exit(1);
}

const files = fs.readdirSync(config.dataDir).filter(f => f.endsWith('.json')).sort();
console.log(`Loading data files from ${config.dataDir}...`);

let marketData = [];
for (const file of files) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.dataDir, file), 'utf8'));
    marketData = marketData.concat(raw);
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
  }
}

console.log(`Loaded ${marketData.length} total candles.`);

// 2. Group candles by date and index times
const daysMap = new Map();
marketData.forEach(c => {
  const dateStr = c.timestamp.substring(0, 10);
  const timeStr = c.timestamp.substring(11, 16);
  if (!daysMap.has(dateStr)) {
    daysMap.set(dateStr, []);
  }
  daysMap.get(dateStr).push({
    timeStr,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    options: c.options
  });
});

const days = Array.from(daysMap.entries()).map(([dateStr, candles]) => {
  candles.sort((a, b) => a.timeStr.localeCompare(b.timeStr));
  const timeMap = new Map();
  candles.forEach((c, idx) => {
    timeMap.set(c.timeStr, idx);
  });
  return { dateStr, candles, timeMap };
}).sort((a, b) => a.dateStr.localeCompare(b.dateStr));

console.log(`Grouped into ${days.length} trading days (from ${days[0].dateStr} to ${days[days.length - 1].dateStr}).`);

// 3. Parse CSV trade logs if provided
let csvTrades = new Map();
if (CSV_FILE) {
  const csvPath = path.resolve(CSV_FILE);
  if (fs.existsSync(csvPath)) {
    console.log(`Parsing trade logs from ${csvPath}...`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');
    
    const header = lines[0].split(',');
    const idxIndex = header.indexOf('Index');
    const idxEntryDate = header.indexOf('Entry-Date');
    const idxExitTime = header.indexOf('ExitTime');
    const idxPnl = header.indexOf('P/L');
    const idxRemarks = header.indexOf('Remarks');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length < 5) continue;
      const tradeIdx = cols[idxIndex];
      if (tradeIdx && !tradeIdx.includes('.')) {
        const entryDate = cols[idxEntryDate];
        const pnl = parseFloat(cols[idxPnl]);
        const exitTime = cols[idxExitTime] ? cols[idxExitTime].substring(0, 5) : '';
        const remarks = cols[idxRemarks];
        csvTrades.set(entryDate, { pnl, exitTime, remarks, lineNum: i + 1 });
      }
    }
    console.log(`Parsed ${csvTrades.size} daily summary trades from CSV.`);
  } else {
    console.warn(`WARNING: CSV file ${csvPath} not found. Skipping validation.`);
  }
}

// 4. Backtest simulation function with Trailing SL
function runSimulation(entryTime, exitTime, legSlPct, overallSl, offset = 0, squareOffMode = 'PARTIAL', trailingSlStep = null, logDiscrepancies = false) {
  let totalPnl = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let maxCapital = 200000;
  let currentCapital = 200000;
  let maxDrawdown = 0;
  let discrepancies = [];

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
    const spotEntry = entryCandle.open;
    const atmStrike = Math.round(spotEntry / config.strikeStep) * config.strikeStep;
    
    const ceStrike = atmStrike + offset;
    const peStrike = atmStrike - offset;

    if (!entryCandle.options || !entryCandle.options[ceStrike] || !entryCandle.options[peStrike]) {
      continue;
    }

    const ceOptEntry = entryCandle.options[ceStrike];
    const peOptEntry = entryCandle.options[peStrike];

    const ceEntryPrice = ceOptEntry.CE.open;
    const peEntryPrice = peOptEntry.PE.open;

    let ceStatus = 'OPEN';
    let peStatus = 'OPEN';

    let ceExitPrice = null;
    let peExitPrice = null;
    let ceExitTime = null;
    let peExitTime = null;

    const originalCeSlLevel = legSlPct !== null ? ceEntryPrice * (1 + legSlPct / 100) : Infinity;
    const originalPeSlLevel = legSlPct !== null ? peEntryPrice * (1 + legSlPct / 100) : Infinity;

    let ceSlLevel = originalCeSlLevel;
    let peSlLevel = originalPeSlLevel;

    let ceLowestPrice = ceEntryPrice;
    let peLowestPrice = peEntryPrice;

    // Minute-by-minute simulation
    for (let i = entryIdx; i <= exitIdx; i++) {
      const c = day.candles[i];
      const ceOpt = c.options[ceStrike];
      const peOpt = c.options[peStrike];
      if (!ceOpt || !peOpt) continue;

      // 1. Update Trailing SL levels (if trailing SL is enabled)
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
        ceExitTime = c.timeStr;
        
        if (squareOffMode === 'COMPLETE') {
          peStatus = 'CLOSED';
          peExitPrice = peOpt.PE.close;
          peExitTime = c.timeStr;
          break;
        }
      }

      if (peStatus === 'OPEN' && peOpt.PE.high >= peSlLevel) {
        peStatus = 'CLOSED';
        peExitPrice = peOpt.PE.open > peSlLevel ? peOpt.PE.open : peSlLevel;
        peExitTime = c.timeStr;

        if (squareOffMode === 'COMPLETE') {
          ceStatus = 'CLOSED';
          ceExitPrice = ceOpt.CE.close;
          ceExitTime = c.timeStr;
          break;
        }
      }

      // 3. Check Overall daily Stop Loss (evaluated on Close of candle)
      if (overallSl !== null) {
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
        if (combinedPnl <= -overallSl) {
          if (ceStatus === 'OPEN') {
            ceStatus = 'CLOSED';
            ceExitPrice = ceOpt.CE.close;
            ceExitTime = c.timeStr;
          }
          if (peStatus === 'OPEN') {
            peStatus = 'CLOSED';
            peExitPrice = peOpt.PE.close;
            peExitTime = c.timeStr;
          }
          break;
        }
      }
    }

    // Exit remaining active legs at final exit candle close
    const exitCandle = day.candles[exitIdx];
    const ceOptExit = exitCandle.options[ceStrike];
    const peOptExit = exitCandle.options[peStrike];

    if (ceStatus === 'OPEN') {
      ceStatus = 'CLOSED';
      ceExitPrice = ceOptExit ? ceOptExit.CE.close : ceEntryPrice;
      ceExitTime = exitCandle.timeStr;
    }
    if (peStatus === 'OPEN') {
      peStatus = 'CLOSED';
      peExitPrice = peOptExit ? peOptExit.PE.close : peEntryPrice;
      peExitTime = exitCandle.timeStr;
    }

    const dayCePnl = (ceEntryPrice - ceExitPrice) * config.lotSize;
    const dayPePnl = (peEntryPrice - peExitPrice) * config.lotSize;
    const dayPnl = dayCePnl + dayPePnl;

    totalPnl += dayPnl;
    totalTrades++;
    if (dayPnl > 0) wins++;
    else losses++;

    currentCapital += dayPnl;
    if (currentCapital > maxCapital) {
      maxCapital = currentCapital;
    }
    const dd = maxCapital - currentCapital;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
    }

    // Log discrepancies with CSV logs if validation is active
    if (logDiscrepancies && csvTrades.has(day.dateStr)) {
      const csv = csvTrades.get(day.dateStr);
      const difference = Math.abs(dayPnl - csv.pnl);
      if (difference > 10.0) {
        discrepancies.push({
          date: day.dateStr,
          strike: atmStrike,
          spotEntry: spotEntry.toFixed(1),
          ourPnl: dayPnl.toFixed(1),
          csvPnl: csv.pnl.toFixed(1),
          diff: difference.toFixed(1),
          ourExitTime: ceExitTime || peExitTime || exitTime,
          csvExitTime: csv.exitTime,
          csvRemarks: csv.remarks
        });
      }
    }
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const recoveryFactor = maxDrawdown > 0 ? totalPnl / maxDrawdown : 0;

  return {
    netProfit: totalPnl,
    winRate,
    totalTrades,
    wins,
    losses,
    maxDrawdown,
    recoveryFactor,
    discrepancies
  };
}

// 5. Validate Baseline Strategy
console.log(`\n===================================================`);
console.log(`  VALIDATING BASELINE BACKTEST ON ${INDEX}`);
console.log(`===================================================`);

const baselineResult = runSimulation(
  '10:30',
  '15:15',
  config.baselineLegSl,
  config.baselineOverallSl,
  0,
  'PARTIAL',
  null,
  true
);

console.log(`Baseline Net Profit: ₹${baselineResult.netProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
console.log(`Baseline Win Rate  : ${baselineResult.winRate.toFixed(2)}%`);
console.log(`Baseline Total Days: ${baselineResult.totalTrades}`);
console.log(`Baseline Max DD    : ₹${baselineResult.maxDrawdown.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
console.log(`Discrepancies found: ${baselineResult.discrepancies.length}`);

// 6. Run Parameter Grid Search Optimization (Pruned Search Space)
console.log(`\n===================================================`);
console.log(`  RUNNING OPTIMIZATION GRID SEARCH ON ${INDEX}`);
console.log(`===================================================`);

// Pruned Grid Space to keep search fast and target best performing zones
const entryTimes = ['09:20', '09:30', '10:30', '12:00'];
const exitTimes = ['15:15', '15:25', '15:29'];
const legSlPcts = [30, 40, 50, 70, 90, null];
const overallSls = [1500, 3000, 5000, null];
const strikeOffsets = [0, 50]; // Straddle vs Strangle
const squareOffModes = ['PARTIAL', 'COMPLETE'];
const trailingSlSteps = [null, 1, 5, 10]; // Trailing SL Steps (Points-based)

const gridResults = [];

// Calculate total combinations
let totalCombinations = 0;
for (const entryTime of entryTimes) {
  for (const exitTime of exitTimes) {
    if (exitTime > entryTime) {
      totalCombinations += legSlPcts.length * overallSls.length * strikeOffsets.length * squareOffModes.length * trailingSlSteps.length;
    }
  }
}
console.log(`Total grid combinations to test: ${totalCombinations}`);

let processed = 0;
const searchStartTime = Date.now();

for (const entryTime of entryTimes) {
  for (const exitTime of exitTimes) {
    if (exitTime <= entryTime) continue;
    
    for (const legSl of legSlPcts) {
      for (const overallSl of overallSls) {
        for (const offset of strikeOffsets) {
          for (const squareOffMode of squareOffModes) {
            for (const trailingSl of trailingSlSteps) {
              processed++;
              const res = runSimulation(entryTime, exitTime, legSl, overallSl, offset, squareOffMode, trailingSl);
              
              if (res.totalTrades > 0) {
                gridResults.push({
                  entryTime,
                  exitTime,
                  legSl,
                  overallSl,
                  offset,
                  squareOffMode,
                  trailingSl,
                  metrics: res
                });
              }
            }
          }
        }
      }
    }
  }
}

// Sort by Net Profit descending, then recovery factor descending
gridResults.sort((a, b) => b.metrics.netProfit - a.metrics.netProfit || b.metrics.recoveryFactor - a.metrics.recoveryFactor);

const searchTimeSec = ((Date.now() - searchStartTime) / 1000).toFixed(1);
console.log(`Tested ${processed} valid combinations in ${searchTimeSec}s.`);
console.log(`\n🏆 TOP 10 COMBINATIONS FOR ${INDEX}:`);

console.log(`| Rank | Entry | Exit | Offset | Mode | Trailing SL | Leg SL | Overall SL | Net Profit | Win Rate | Max DD | Recovery F. |`);
console.log(`|------|-------|------|--------|------|-------------|--------|------------|------------|----------|--------|-------------|`);
gridResults.slice(0, 10).forEach((r, idx) => {
  const legSlStr = r.legSl === null ? 'No SL' : `${r.legSl}%`;
  const overallSlStr = r.overallSl === null ? 'No SL' : `₹${r.overallSl}`;
  const offsetStr = r.offset === 0 ? 'ATM' : `OTM ${r.offset}`;
  const trailingStr = r.trailingSl === null ? 'None' : `${r.trailingSl} pts`;
  console.log(`| #${idx + 1} | ${r.entryTime} | ${r.exitTime} | ${offsetStr} | ${r.squareOffMode} | ${trailingStr} | ${legSlStr} | ${overallSlStr} | ₹${r.metrics.netProfit.toFixed(0)} | ${r.metrics.winRate.toFixed(1)}% | ₹${r.metrics.maxDrawdown.toFixed(0)} | ${r.metrics.recoveryFactor.toFixed(2)} |`);
});

const outDir = path.join(__dirname, '..', 'public', 'data');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const outFile = path.join(outDir, `optimization_${INDEX.toLowerCase()}_results.json`);
fs.writeFileSync(outFile, JSON.stringify(gridResults.slice(0, 50), null, 2));
console.log(`\nSaved top 50 combinations to ${outFile}`);
