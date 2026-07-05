/**
 * optimize_three_candles.js
 * 
 * Backtests and optimizes the Three-Candle Options Buying Strategy.
 * Works on NIFTY or BANKNIFTY.
 * 
 * Usage:
 *   node scripts/optimize_three_candles.js <NIFTY|BANKNIFTY> [mode: backtest|optimize] [startDate: YYYY-MM-DD]
 * 
 * Default startDate is '2024-11-14' for monthly expiry contract period (last BANKNIFTY weekly expired on Nov 13, 2024).
 */

const fs = require('fs');
const path = require('path');

const INDEX = process.argv[2] || 'BANKNIFTY';
const MODE = process.argv[3] || 'backtest'; // 'backtest' (detailed logs) or 'optimize' (grid search)
const START_DATE = process.argv[4] || '2026-01-01';
const TRADE_TYPE = process.argv[5] || 'OPTIONS'; // 'OPTIONS' or 'SPOT'
const END_DATE = process.argv[6] || '2026-05-25';

if (!INDEX || (INDEX !== 'NIFTY' && INDEX !== 'BANKNIFTY')) {
  console.error('ERROR: Index name is required. Must be NIFTY or BANKNIFTY.');
  console.log('Usage: node scripts/optimize_three_candles.js <NIFTY|BANKNIFTY> [mode: backtest|optimize] [startDate: YYYY-MM-DD] [tradeType: OPTIONS|SPOT]');
  process.exit(1);
}

const config = {
  NIFTY: {
    dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min'),
    lotSize: 75,
    strikeStep: 50
  },
  BANKNIFTY: {
    dataDir: path.join(__dirname, '..', 'public', 'data', 'banknifty_1min'),
    lotSize: 15,
    strikeStep: 100
  }
}[INDEX];

// ── 1. Load data from disk ──────────────────────────────────────────────────
if (!fs.existsSync(config.dataDir)) {
  console.error(`ERROR: Data directory ${config.dataDir} does not exist. Please fetch the data first.`);
  process.exit(1);
}

console.log(`Loading data files from ${config.dataDir}...`);
const files = fs.readdirSync(config.dataDir).filter(f => f.endsWith('.json')).sort();

let marketData = [];
for (const file of files) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.dataDir, file), 'utf8'));
    const candles = Array.isArray(raw) ? raw : (raw.data || raw.candles || []);
    marketData = marketData.concat(candles);
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
  }
}

console.log(`Loaded ${marketData.length} total 1-minute candles.`);

// Group 1-minute candles by date
const daysMap = new Map();
marketData.forEach(c => {
  const dateStr = c.timestamp.substring(0, 10);
  if (!daysMap.has(dateStr)) {
    daysMap.set(dateStr, []);
  }
  
  // Format candle cleanly
  daysMap.get(dateStr).push({
    timestamp: c.timestamp,
    timeStr: c.timestamp.substring(11, 16),
    open: c.open || c.o,
    high: c.high || c.h,
    low: c.low || c.l,
    close: c.close || c.c,
    options: c.options,
    atmStrike: c.atmStrike
  });
});

// Filter by start date and sort chronologically
const allTradingDays = Array.from(daysMap.keys()).sort();

const days = Array.from(daysMap.entries())
  .map(([dateStr, candles]) => {
    candles.sort((a, b) => a.timeStr.localeCompare(b.timeStr));
    return { dateStr, candles };
  })
  .filter(d => d.dateStr >= START_DATE && d.dateStr <= END_DATE)
  .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

if (days.length === 0) {
  console.error(`No trading data found after start date: ${START_DATE}`);
  process.exit(1);
}

console.log(`Testing from ${days[0].dateStr} to ${days[days.length - 1].dateStr} (${days.length} trading days).`);

// ── 2. Helpers ──────────────────────────────────────────────────────────────
function getLastTuesdayOfMonth(year, month, expiryDayOfWeek) {
  const date = new Date(Date.UTC(year, month + 1, 0));
  while (date.getUTCDay() !== expiryDayOfWeek) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

function getMonthlyExpiryDate(dateStr, tradingDays) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed month
  const expiryDayOfWeek = INDEX === 'BANKNIFTY' ? 2 : 4; // 2 = Tuesday, 4 = Thursday
  
  let lastTuesday = getLastTuesdayOfMonth(year, month, expiryDayOfWeek);
  let expiryDateStr = lastTuesday.toISOString().split('T')[0];
  
  if (dateStr > expiryDateStr) {
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 11) {
      nextMonth = 0;
      nextYear += 1;
    }
    lastTuesday = getLastTuesdayOfMonth(nextYear, nextMonth, expiryDayOfWeek);
    expiryDateStr = lastTuesday.toISOString().split('T')[0];
  }
  
  let actualExpiryDay = null;
  for (let i = tradingDays.length - 1; i >= 0; i--) {
    if (tradingDays[i] <= expiryDateStr) {
      actualExpiryDay = tradingDays[i];
      break;
    }
  }
  return actualExpiryDay;
}

function getOptionPrice(candle, strike, type, field) {
  const strikeStr = String(strike);
  if (candle.options && candle.options[strikeStr] && candle.options[strikeStr][type]) {
    return candle.options[strikeStr][type][field];
  }
  // Fallback to intrinsic value
  if (type === 'CE') {
    const spotVal = candle[field];
    return Math.max(0, spotVal - strike);
  } else {
    let spotVal = candle[field];
    if (field === 'high') spotVal = candle.low;
    else if (field === 'low') spotVal = candle.high;
    return Math.max(0, strike - spotVal);
  }
}

function aggregateCandles(oneMinCandles, K) {
  if (K === 1) {
    return oneMinCandles.map(c => ({
      ...c,
      timeStr: c.timestamp.substring(11, 16)
    }));
  }
  
  const blocks = new Map();
  oneMinCandles.forEach(c => {
    const parts = c.timeStr.split(':');
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    const mins = hour * 60 + minute;
    const minsSinceOpen = mins - (9 * 60 + 15); // market opens at 09:15
    
    if (minsSinceOpen < 0) return; // ignore pre-market
    
    const blockId = Math.floor(minsSinceOpen / K);
    if (!blocks.has(blockId)) {
      blocks.set(blockId, []);
    }
    blocks.get(blockId).push(c);
  });
  
  const aggregated = [];
  const sortedBlockIds = Array.from(blocks.keys()).sort((a, b) => a - b);
  
  for (const blockId of sortedBlockIds) {
    const list = blocks.get(blockId);
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    const first = list[0];
    const last = list[list.length - 1];
    
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    
    list.forEach(c => {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += (c.volume || 0);
    });
    
    // Gather all option strikes in the block
    const strikes = new Set();
    list.forEach(c => {
      if (c.options) {
        Object.keys(c.options).forEach(s => strikes.add(s));
      }
    });
    
    const optionsObj = {};
    strikes.forEach(strike => {
      let ceOpen = null;
      let ceClose = null;
      let ceHigh = -Infinity;
      let ceLow = Infinity;
      let ceVol = 0;
      
      let peOpen = null;
      let peClose = null;
      let peHigh = -Infinity;
      let peLow = Infinity;
      let peVol = 0;
      
      for (let i = 0; i < list.length; i++) {
        const opt = list[i].options && list[i].options[strike];
        if (opt) {
          if (opt.CE && ceOpen === null) ceOpen = opt.CE.open;
          if (opt.PE && peOpen === null) peOpen = opt.PE.open;
        }
      }
      
      for (let i = list.length - 1; i >= 0; i--) {
        const opt = list[i].options && list[i].options[strike];
        if (opt) {
          if (opt.CE && ceClose === null) ceClose = opt.CE.close;
          if (opt.PE && peClose === null) peClose = opt.PE.close;
        }
      }
      
      list.forEach(c => {
        const opt = c.options && c.options[strike];
        if (opt) {
          if (opt.CE) {
            if (opt.CE.high > ceHigh) ceHigh = opt.CE.high;
            if (opt.CE.low < ceLow) ceLow = opt.CE.low;
            ceVol += (opt.CE.volume || 0);
          }
          if (opt.PE) {
            if (opt.PE.high > peHigh) peHigh = opt.PE.high;
            if (opt.PE.low < peLow) peLow = opt.PE.low;
            peVol += (opt.PE.volume || 0);
          }
        }
      });
      
      if (ceOpen === null) ceOpen = Math.max(0, first.open - parseFloat(strike));
      if (ceClose === null) ceClose = Math.max(0, last.close - parseFloat(strike));
      if (ceHigh === -Infinity) ceHigh = Math.max(0, high - parseFloat(strike));
      if (ceLow === Infinity) ceLow = Math.max(0, low - parseFloat(strike));
      
      if (peOpen === null) peOpen = Math.max(0, parseFloat(strike) - first.open);
      if (peClose === null) peClose = Math.max(0, parseFloat(strike) - last.close);
      if (peHigh === -Infinity) peHigh = Math.max(0, parseFloat(strike) - low);
      if (peLow === Infinity) peLow = Math.max(0, parseFloat(strike) - high);
      
      optionsObj[strike] = {
        CE: { open: ceOpen, high: ceHigh, low: ceLow, close: ceClose, volume: ceVol },
        PE: { open: peOpen, high: peHigh, low: peLow, close: peClose, volume: peVol }
      };
    });
    
    aggregated.push({
      timestamp: first.timestamp,
      timeStr: first.timestamp.substring(11, 16),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      options: optionsObj,
      atmStrike: first.atmStrike,
      oneMinCandles: list // reference back to 1-minute components
    });
  }
  
  return aggregated;
}

// ── 3. Backtest Simulation Runner ───────────────────────────────────────────
function runSimulation(params) {
  const tradeType = params.tradeType || 'OPTIONS';
  const K = params.timeframe || 5;
  const slOffset = params.slOffset !== undefined ? params.slOffset : 10;
  const tpMultiplier = params.tpMultiplier || 1.5;
  const slippage = params.slippagePoints !== undefined ? params.slippagePoints : 0.5;
  const brokerage = params.brokerageFlat !== undefined ? params.brokerageFlat : 40;
  const maxTradesPerDay = params.maxTradesPerDay || 2;
  const entryStartTime = params.entryStartTime || '09:45';
  const entryEndTime = params.entryEndTime || '13:00';
  const squareOffTime = params.squareOffTime || '14:30';
  
  let currentCapital = 200000;
  const tradeHistory = [];
  
  let totalWins = 0;
  let totalLosses = 0;
  let peakCapital = currentCapital;
  let maxDrawdown = 0;
  
  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    
    // Check if it's the monthly expiry day or day before expiry
    const expiryDay = getMonthlyExpiryDate(day.dateStr, allTradingDays);
    const expiryIdx = allTradingDays.indexOf(expiryDay);
    const isExpiryOrDayBefore = (day.dateStr === expiryDay) || (expiryIdx > 0 && day.dateStr === allTradingDays[expiryIdx - 1]);
    
    if (isExpiryOrDayBefore) {
      if (MODE === 'backtest') {
        console.log(`[Skip] ${day.dateStr} (Monthly Expiry Day or Day Before Expiry)`);
      }
      continue;
    }
    
    const oneMinCandles = day.candles;
    
    // Aggregate to target timeframe
    const aggCandles = aggregateCandles(oneMinCandles, K);
    
    let tradesToday = 0;
    
    // Loop through aggregated candles to detect pattern completion (requires at least 3 completed candles)
    for (let m = 2; m < aggCandles.length - 1; m++) {
      if (tradesToday >= maxTradesPerDay) break;
      
      const C1 = aggCandles[m-2];
      const C2 = aggCandles[m-1];
      const C3 = aggCandles[m];

      
      // 1. Same color streak
      const isGreenStreak = C1.close > C1.open && C2.close > C2.open && C3.close > C3.open;
      const isRedStreak = C1.close < C1.open && C2.close < C2.open && C3.close < C3.open;
      
      if (!isGreenStreak && !isRedStreak) continue;
      
      // console.log(C1, C2, C3, 'Three Candles')
      // 2. High/low conditions
      const satisfiesHigh = C3.high > C1.high && C3.high > C2.high;
      const satisfiesLow = C1.low < C2.low && C1.low < C3.low;
      
      if (!satisfiesHigh || !satisfiesLow) continue;
      
      // 3. Difference rule (1st candle high and 3rd candle low difference > 0)
      const satisfiesDiff = (C1.high - C3.low) > 0;
      if (!satisfiesDiff) continue;
      
      // Setup detected!
      const direction = isGreenStreak ? 'LONG' : 'SHORT'; // LONG = Buy CE, SHORT = Buy PE
      const triggerSpot = C3.open;
      const atmStrike = Math.round(triggerSpot / config.strikeStep) * config.strikeStep;
      
      // Now monitor the next candle (Candle 4) and onwards using 1-minute resolution
      const nextBlock = aggCandles[m+1];
      if (!nextBlock) continue;
      
      // Find start index of next block in 1-minute list
      const startIdx = oneMinCandles.findIndex(c => c.timestamp >= nextBlock.timestamp);
      if (startIdx === -1) continue;
      
      let entryCandleIdx = -1;
      let entryTimeStr = '';
      
      // Search for entry touch within the entry window
      for (let i = startIdx; i < oneMinCandles.length; i++) {
        const c1 = oneMinCandles[i];
        if (c1.timeStr < entryStartTime || c1.timeStr > entryEndTime) continue;
        
        let touch = false;
        if (direction === 'LONG') {
          // CALL: entry if price pulls back down to triggerSpot
          if (c1.low <= triggerSpot) touch = true;
        } else {
          // PUT: entry if price rises up to triggerSpot
          if (c1.high >= triggerSpot) touch = true;
        }
        
        if (touch) {
          entryCandleIdx = i;
          entryTimeStr = c1.timeStr;
          break;
        }
      }
      
      // If no entry touch was found, pattern setup is bypassed/invalidated
      if (entryCandleIdx === -1) continue;
      
      // We enter the trade at entryCandleIdx!
      const entryCandle = oneMinCandles[entryCandleIdx];
      const optType = direction === 'LONG' ? 'CE' : 'PE';
      
      const spotSL = direction === 'LONG' ? (C1.low + slOffset) : (C3.high - slOffset);
      const spotRisk = Math.abs(triggerSpot - C1.low);
      
      let entryPremium;
      let premiumTP;
      
      if (tradeType === 'SPOT') {
        // In SPOT mode, we simulate trading the index directly.
        // Entry is at triggerSpot, plus/minus slippage in spot terms (default 5 points or params.slippagePoints)
        entryPremium = triggerSpot + (direction === 'LONG' ? slippage : -slippage);
        const targetSpotPoints = spotRisk * tpMultiplier;
        premiumTP = direction === 'LONG' ? (triggerSpot + targetSpotPoints) : (triggerSpot - targetSpotPoints);
      } else {
        // OPTIONS mode (uses options premiums / intrinsic fallback)
        const rawEntryPremium = getOptionPrice(entryCandle, atmStrike, optType, 'open');
        entryPremium = rawEntryPremium + slippage;
        const targetPremiumPoints = (spotRisk * tpMultiplier) / 2;
        premiumTP = entryPremium + targetPremiumPoints;
      }
      
      let exitPremium = null;
      let exitTimeStr = '';
      let exitReason = '';
      let exitCandleIdx = -1;
      
      // Monitor the position from the entry candle onwards
      for (let i = entryCandleIdx; i < oneMinCandles.length; i++) {
        const c = oneMinCandles[i];
        
        let slHit = false;
        let tpHit = false;
        let eodHit = false;
        
        if (c.timeStr >= squareOffTime) {
          eodHit = true;
        }
        
        if (tradeType === 'SPOT') {
          // Spot SL / TP check
          if (direction === 'LONG') {
            if (c.low <= spotSL) slHit = true;
            if (c.high >= premiumTP) tpHit = true;
          } else {
            if (c.high >= spotSL) slHit = true;
            if (c.low <= premiumTP) tpHit = true;
          }
          
          if (slHit || tpHit || eodHit) {
            exitCandleIdx = i;
            exitTimeStr = c.timeStr;
            if (eodHit) {
              exitReason = 'Square-off';
              exitPremium = c.close;
            } else if (slHit && tpHit) {
              exitReason = 'Stop Loss';
              exitPremium = spotSL - (direction === 'LONG' ? slippage : -slippage);
            } else if (slHit) {
              exitReason = 'Stop Loss';
              exitPremium = spotSL - (direction === 'LONG' ? slippage : -slippage);
            } else {
              exitReason = 'Target';
              exitPremium = premiumTP + (direction === 'LONG' ? -slippage : slippage);
            }
            break;
          }
        } else {
          // OPTIONS mode SL / TP checks
          const optPriceHigh = getOptionPrice(c, atmStrike, optType, 'high');
          const optPriceLow = getOptionPrice(c, atmStrike, optType, 'low');
          const optPriceClose = getOptionPrice(c, atmStrike, optType, 'close');
          
          if (direction === 'LONG') {
            if (c.low <= spotSL) slHit = true;
          } else {
            if (c.high >= spotSL) slHit = true;
          }
          
          if (optPriceHigh >= premiumTP) {
            tpHit = true;
          }
          
          if (slHit || tpHit || eodHit) {
            exitCandleIdx = i;
            exitTimeStr = c.timeStr;
            
            if (eodHit) {
              exitReason = 'Square-off';
              exitPremium = Math.max(0.05, optPriceClose - slippage);
            } else if (slHit && tpHit) {
              exitReason = 'Stop Loss';
              exitPremium = Math.max(0.05, optPriceLow - slippage);
            } else if (slHit) {
              exitReason = 'Stop Loss';
              exitPremium = Math.max(0.05, optPriceLow - slippage);
            } else {
              exitReason = 'Target';
              const optOpen = getOptionPrice(c, atmStrike, optType, 'open');
              exitPremium = Math.max(0.05, (optOpen > premiumTP ? optOpen : premiumTP) - slippage);
            }
            break;
          }
        }
      }
      
      // Calculate PnL
      let grossPoints;
      if (tradeType === 'SPOT') {
        grossPoints = direction === 'LONG' ? (exitPremium - entryPremium) : (entryPremium - exitPremium);
      } else {
        grossPoints = exitPremium - entryPremium;
      }
      const tradeQty = config.lotSize;
      const tradePnl = (grossPoints * tradeQty) - brokerage;
      
      currentCapital += tradePnl;
      if (currentCapital > peakCapital) peakCapital = currentCapital;
      const dd = peakCapital - currentCapital;
      if (dd > maxDrawdown) maxDrawdown = dd;
      
      if (tradePnl > 0) totalWins++;
      else totalLosses++;
      
      const tradeLog = {
        date: day.dateStr,
        direction,
        strike: atmStrike,
        entryTime: entryTimeStr,
        entrySpot: triggerSpot,
        entryPremium: parseFloat(entryPremium.toFixed(2)),
        spotSL: parseFloat(spotSL.toFixed(2)),
        premiumTP: parseFloat(premiumTP.toFixed(2)),
        exitTime: exitTimeStr,
        exitPremium: parseFloat(exitPremium.toFixed(2)),
        exitReason,
        points: parseFloat(grossPoints.toFixed(2)),
        pnl: parseFloat(tradePnl.toFixed(2)),
        capital: parseFloat(currentCapital.toFixed(2))
      };
      
      tradeHistory.push(tradeLog);
      tradesToday++;
      
      // Determine where to resume pattern scanning in aggCandles
      // We find the aggregated candle containing or immediately after the exit timestamp
      const exitTimestamp = oneMinCandles[exitCandleIdx].timestamp;
      const nextAggIndex = aggCandles.findIndex(ac => ac.timestamp > exitTimestamp);
      if (nextAggIndex !== -1) {
        m = nextAggIndex - 1; // loop increment will make it nextAggIndex
      } else {
        m = aggCandles.length; // end day scanning
      }
    }
  }
  
  const totalTrades = tradeHistory.length;
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const netProfit = currentCapital - 200000;
  const recoveryFactor = maxDrawdown > 0 ? netProfit / maxDrawdown : 0;
  
  return {
    netProfit,
    winRate,
    totalTrades,
    wins: totalWins,
    losses: totalLosses,
    maxDrawdown,
    recoveryFactor,
    tradeHistory
  };
}

// ── 4. Main Program Execution ────────────────────────────────────────────────
if (MODE === 'backtest') {
  console.log(`\n===================================================`);
  console.log(`  RUNNING SINGLE BACKTEST ON ${INDEX} (${START_DATE} to end)`);
  console.log(`===================================================`);
  
  const params = {
    tradeType: TRADE_TYPE,
    timeframe: 5,
    slOffset: 10,
    tpMultiplier: 1.5,
    slippagePoints: 0.5,
    brokerageFlat: 40,
    maxTradesPerDay: 2,
    entryStartTime: '09:45',
    entryEndTime: '13:00',
    squareOffTime: '14:30'
  };
  
  const res = runSimulation(params);
  
  console.log(`\nTrade Log:`);
  console.log(`| Date       | Type  | Strike | Entry Time | Entry Spot | Entry Prem | Spot SL   | Prem TP   | Exit Time | Exit Prem | Reason     | Pts   | PnL (₹)   |`);
  console.log(`|------------|-------|--------|------------|------------|------------|-----------|-----------|-----------|-----------|------------|-------|-----------|`);
  res.tradeHistory.forEach(t => {
    console.log(`| ${t.date} | ${t.direction.padEnd(5)} | ${t.strike}  | ${t.entryTime}      | ${t.entrySpot.toFixed(1).padEnd(10)} | ${t.entryPremium.toFixed(1).padEnd(10)} | ${t.spotSL.toFixed(1).padEnd(9)} | ${t.premiumTP.toFixed(1).padEnd(9)} | ${t.exitTime}      | ${t.exitPremium.toFixed(1).padEnd(9)} | ${t.exitReason.padEnd(10)} | ${t.points.toFixed(1).padEnd(5)} | ${t.pnl.toFixed(0).padStart(9)} |`);
  });
  
  console.log(`\nSummary Statistics:`);
  console.log(`---------------------------------`);
  console.log(`Net Profit       : ₹${res.netProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
  console.log(`Win Rate         : ${res.winRate.toFixed(2)}%`);
  console.log(`Total Trades     : ${res.totalTrades} (Wins: ${res.wins}, Losses: ${res.losses})`);
  console.log(`Max Drawdown     : ₹${res.maxDrawdown.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
  console.log(`Recovery Factor  : ${res.recoveryFactor.toFixed(2)}`);
  console.log(`---------------------------------`);

  // Write detailed markdown trade log to disk
  const outDir = path.join(__dirname, '..', 'public', 'data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const logFilePath = path.join(outDir, `backtest_${INDEX.toLowerCase()}_top1_trades.md`);
  let md = `# Backtest Trade Logs: ${INDEX}\n\n`;
  md += `Timeframe: **${params.timeframe}m** | SL Offset: **${params.slOffset} pts** | TP Multiplier: **${params.tpMultiplier}** | Max Trades/Day: **${params.maxTradesPerDay}**\n\n`;
  md += `| Date | Type | Strike | Entry Time | Entry Spot | Entry Prem | Spot SL | Prem TP | Exit Time | Exit Prem | Reason | Pts | PnL (₹) |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  res.tradeHistory.forEach(t => {
    md += `| ${t.date} | ${t.direction} | ${t.strike} | ${t.entryTime} | ${t.entrySpot.toFixed(1)} | ${t.entryPremium.toFixed(1)} | ${t.spotSL.toFixed(1)} | ${t.premiumTP.toFixed(1)} | ${t.exitTime} | ${t.exitPremium.toFixed(1)} | ${t.exitReason} | ${t.points.toFixed(1)} | ${t.pnl.toFixed(0)} |\n`;
  });
  
  md += `\n\n## Summary Statistics\n`;
  md += `* **Net Profit**: ₹${res.netProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}\n`;
  md += `* **Win Rate**: ${res.winRate.toFixed(2)}%\n`;
  md += `* **Total Trades**: ${res.totalTrades} (Wins: ${res.wins}, Losses: ${res.losses})\n`;
  md += `* **Max Drawdown**: ₹${res.maxDrawdown.toLocaleString('en-IN', { maximumFractionDigits: 0 })}\n`;
  md += `* **Recovery Factor**: ${res.recoveryFactor.toFixed(2)}\n`;
  
  fs.writeFileSync(logFilePath, md, 'utf8');
  console.log(`Saved detailed trade logs to ${logFilePath}`);
} else if (MODE === 'optimize') {
  console.log(`\n===================================================`);
  console.log(`  RUNNING PARAMETER OPTIMIZATION GRID SEARCH`);
  console.log(`===================================================`);
  
  const timeframes = [1, 3, 5, 10, 15];
  const slOffsets = [0, 5, 10, 15, 20];
  const tpMultipliers = [1.0, 1.5, 2.0];
  const maxTrades = [1, 2];
  
  const combinations = [];
  for (const timeframe of timeframes) {
    for (const slOffset of slOffsets) {
      for (const tpMultiplier of tpMultipliers) {
        for (const maxTrade of maxTrades) {
          combinations.push({ timeframe, slOffset, tpMultiplier, maxTradesPerDay: maxTrade });
        }
      }
    }
  }
  
  console.log(`Testing ${combinations.length} parameter combinations...`);
  
  const results = [];
  const searchStartTime = Date.now();
  
  combinations.forEach((c, idx) => {
    const res = runSimulation({
      tradeType: TRADE_TYPE,
      timeframe: c.timeframe,
      slOffset: c.slOffset,
      tpMultiplier: c.tpMultiplier,
      maxTradesPerDay: c.maxTradesPerDay,
      slippagePoints: 0.5,
      brokerageFlat: 40,
      entryStartTime: '09:45',
      entryEndTime: '13:00',
      squareOffTime: '14:30'
    });
    
    results.push({
      params: c,
      metrics: res
    });
  });
  
  // Sort by Net Profit descending
  results.sort((a, b) => b.metrics.netProfit - a.metrics.netProfit || b.metrics.recoveryFactor - a.metrics.recoveryFactor);
  
  const searchTimeSec = ((Date.now() - searchStartTime) / 1000).toFixed(1);
  console.log(`Tested ${combinations.length} combinations in ${searchTimeSec}s.`);
  console.log(`\n🏆 TOP 10 COMBINATIONS FOR ${INDEX}:`);
  console.log(`| Rank | Timeframe | SL Offset | TP Mult | Max Trades | Net Profit | Win Rate | Trades | Max DD | Recovery F. |`);
  console.log(`|------|-----------|-----------|---------|------------|------------|----------|--------|--------|-------------|`);
  results.slice(0, 10).forEach((r, idx) => {
    console.log(`| #${idx + 1} | ${String(r.params.timeframe).padEnd(9)} | ${String(r.params.slOffset).padEnd(9)} | ${String(r.params.tpMultiplier).padEnd(7)} | ${String(r.params.maxTradesPerDay).padEnd(10)} | ₹${r.metrics.netProfit.toFixed(0).padStart(8)} | ${r.metrics.winRate.toFixed(1)}% | ${String(r.metrics.totalTrades).padStart(6)} | ₹${r.metrics.maxDrawdown.toFixed(0).padStart(6)} | ${r.metrics.recoveryFactor.toFixed(2).padStart(11)} |`);
  });
  
  const outDir = path.join(__dirname, '..', 'public', 'data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  const outFile = path.join(outDir, `optimization_three_candles_${INDEX.toLowerCase()}_results.json`);
  fs.writeFileSync(outFile, JSON.stringify(results.slice(0, 50), null, 2));
  console.log(`\nSaved top 50 combinations to ${outFile}`);
}
