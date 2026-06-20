/**
 * optimize_fvg.js — FVG Entry Type Only Optimization
 * Runs the grid search for FVG entry across all parameter combinations.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 1. Load Data ─────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '../public/data/nifty_1min');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();
console.log(`Loading data files from ${dataDir}...`);

let marketData = [];
for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
  const candles = Array.isArray(raw) ? raw : (raw.data || raw.candles || []);
  for (const c of candles) {
    marketData.push({
      timestamp: new Date(c.timestamp || c.time || c.t),
      open: c.open || c.o,
      high: c.high || c.h,
      low: c.low || c.l,
      close: c.close || c.c,
      options: c.options,
      atmStrike: c.atmStrike
    });
  }
}
console.log(`Loaded ${marketData.length} total 1-minute candles.\n`);

// ── 2. Helpers ────────────────────────────────────────────────────────────────
function getISTTime(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    dateStr: `${year}-${month}-${day}`
  };
}

function getFiveMinBlockId(timestamp) {
  const ist = new Date(timestamp.getTime() + (5.5 * 60 * 60 * 1000));
  const minutesSinceOpen = (ist.getUTCHours() * 60 + ist.getUTCMinutes()) - (9 * 60 + 15);
  return Math.floor(minutesSinceOpen / 5);
}

function getOptionPrice(candle, strike, type, field) {
  const strikeStr = String(strike);
  if (candle.options && candle.options[strikeStr] && candle.options[strikeStr][type]) {
    return candle.options[strikeStr][type][field];
  }
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

// ── 3. Simulation ─────────────────────────────────────────────────────────────
function runSimulation(params) {
  const lotSize = params.lotSize || 75;
  const globalLots = params.numberOfLots || 1;
  const longLotsVal = params.longOptionLots !== undefined ? params.longOptionLots : 1;
  const shortLotsVal = params.shortOptionLots !== undefined ? params.shortOptionLots : 0;
  const finalLongLots = Math.max(1, longLotsVal * globalLots);
  const finalShortLots = shortLotsVal * globalLots;

  let currentCapital = 200000;
  let tradeHistory = [];
  let openPosition = null;
  let maxEquity = currentCapital;
  let maxDrawdownValue = 0;

  let currentDayStr = '';
  let openingRangeHigh = -Infinity;
  let openingRangeLow = Infinity;
  let openingRangeSet = false;
  let tradesTakenToday = 0;
  let slHitsToday = 0;
  let canTriggerBreakout = true;

  let fiveMinOpen = null;
  let fiveMinHigh = -Infinity;
  let fiveMinLow = Infinity;
  let fiveMinClose = null;
  let prevBlockId = -1;
  let prevCompletedBlock = null;
  let fvgState = 'IDLE';
  let fvgDirection = null;
  let fvgZoneLow = 0;
  let fvgZoneHigh = 0;
  let fvgCandleN2 = null;

  const parseTimeToMinutes = (timeStr) => {
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  };

  const entryStartMinutes = parseTimeToMinutes(params.entryStartTime || '09:30');
  const entryEndMinutes = parseTimeToMinutes(params.entryEndTime || '15:29');
  const squareOffMinutes = parseTimeToMinutes(params.squareOffTime || '15:29');

  for (let i = 0; i < marketData.length; i++) {
    const candle = marketData[i];
    const ist = getISTTime(candle.timestamp);
    const timeMinutes = ist.hour * 60 + ist.minute;

    if (ist.dateStr !== currentDayStr) {
      currentDayStr = ist.dateStr;
      openingRangeHigh = -Infinity;
      openingRangeLow = Infinity;
      openingRangeSet = false;
      tradesTakenToday = 0;
      slHitsToday = 0;
      canTriggerBreakout = true;
      fiveMinOpen = null; fiveMinHigh = -Infinity; fiveMinLow = Infinity; fiveMinClose = null;
      prevBlockId = -1;
      prevCompletedBlock = null;
      fvgState = 'IDLE'; fvgDirection = null; fvgZoneLow = 0; fvgZoneHigh = 0; fvgCandleN2 = null;
    }

    const marketOpenMinutes = 9 * 60 + 15;
    const rangeEndMinutes = marketOpenMinutes + params.openingRangeMinutes;

    const currentBlockId = getFiveMinBlockId(candle.timestamp);
    if (prevBlockId !== currentBlockId) {
      if (prevBlockId !== -1 && fiveMinClose !== null) {
        prevCompletedBlock = { open: fiveMinOpen, high: fiveMinHigh, low: fiveMinLow, close: fiveMinClose };
      }
      fiveMinOpen = candle.open;
      fiveMinHigh = candle.high;
      fiveMinLow = candle.low;
      fiveMinClose = candle.close;
      prevBlockId = currentBlockId;
    } else {
      fiveMinHigh = Math.max(fiveMinHigh, candle.high);
      fiveMinLow = Math.min(fiveMinLow, candle.low);
      fiveMinClose = candle.close;
    }

    const nextCandle = marketData[i + 1];
    const nextBlockId = nextCandle ? getFiveMinBlockId(nextCandle.timestamp) : -1;
    let isNewDayNext = false;
    if (nextCandle) {
      const nextIst = getISTTime(nextCandle.timestamp);
      if (nextIst.dateStr !== ist.dateStr) isNewDayNext = true;
    }
    const isEndOfBlock = (currentBlockId !== nextBlockId) || isNewDayNext || (i === marketData.length - 1);

    if (timeMinutes >= marketOpenMinutes && timeMinutes < rangeEndMinutes) {
      openingRangeHigh = Math.max(openingRangeHigh, candle.high);
      openingRangeLow = Math.min(openingRangeLow, candle.low);
    } else if (timeMinutes >= rangeEndMinutes && openingRangeHigh !== -Infinity) {
      openingRangeSet = true;
    }

    // Monitor Open Position
    if (openPosition) {
      let shouldExit = false;
      let exitSpotPrice = candle.close;
      let exitReason = '';

      if (openPosition.type === 'LONG' && candle.high > openPosition.targetPrice) {
        shouldExit = true; exitSpotPrice = openPosition.targetPrice; exitReason = 'Target';
      } else if (openPosition.type === 'SHORT' && candle.low < openPosition.targetPrice) {
        shouldExit = true; exitSpotPrice = openPosition.targetPrice; exitReason = 'Target';
      }

      if (!shouldExit) {
        if (openPosition.type === 'LONG' && candle.low < openPosition.stopLossPrice) {
          shouldExit = true; exitSpotPrice = openPosition.stopLossPrice; exitReason = 'Stop Loss';
        } else if (openPosition.type === 'SHORT' && candle.high > openPosition.stopLossPrice) {
          shouldExit = true; exitSpotPrice = openPosition.stopLossPrice; exitReason = 'Stop Loss';
        }
      }

      if (!shouldExit && timeMinutes >= squareOffMinutes) {
        shouldExit = true; exitSpotPrice = candle.close; exitReason = 'Square-off';
      }

      if (shouldExit) {
        let tradePnl = 0;
        let exitPrice = exitSpotPrice;
        const hasOptions = candle.options !== undefined || candle.atmStrike !== undefined;

        if (params.tradeType === 'OPTIONS' && hasOptions) {
          let ceExitField = 'close', peExitField = 'close';
          if (exitReason === 'Target') {
            ceExitField = openPosition.type === 'LONG' ? 'high' : 'low';
            peExitField = openPosition.type === 'LONG' ? 'low' : 'high';
          } else if (exitReason === 'Stop Loss') {
            ceExitField = openPosition.type === 'LONG' ? 'low' : 'high';
            peExitField = openPosition.type === 'LONG' ? 'high' : 'low';
          }
          const ceExitPremium = getOptionPrice(candle, openPosition.strikePrice, 'CE', ceExitField);
          const peExitPremium = getOptionPrice(candle, openPosition.strikePrice, 'PE', peExitField);

          if (openPosition.type === 'LONG') {
            const ceEx = ceExitPremium - params.slippagePoints;
            const peEx = peExitPremium + params.slippagePoints;
            const cePnl = (ceEx - openPosition.ceEntryPrice) * lotSize * finalLongLots;
            const pePnl = (openPosition.peEntryPrice - peEx) * lotSize * finalShortLots;
            tradePnl = cePnl + pePnl - params.brokerageFlat;
            exitPrice = ceEx - peEx * (finalShortLots / finalLongLots);
          } else {
            const ceEx = ceExitPremium + params.slippagePoints;
            const peEx = peExitPremium - params.slippagePoints;
            const cePnl = (openPosition.ceEntryPrice - ceEx) * lotSize * finalShortLots;
            const pePnl = (peEx - openPosition.peEntryPrice) * lotSize * finalLongLots;
            tradePnl = cePnl + pePnl - params.brokerageFlat;
            exitPrice = peEx - ceEx * (finalShortLots / finalLongLots);
          }
        } else {
          let finalExitPrice = exitSpotPrice;
          if (openPosition.type === 'LONG') {
            finalExitPrice -= params.slippagePoints;
            tradePnl = (finalExitPrice - openPosition.entryPrice) * openPosition.quantity - params.brokerageFlat;
          } else {
            finalExitPrice += params.slippagePoints;
            tradePnl = (openPosition.entryPrice - finalExitPrice) * openPosition.quantity - params.brokerageFlat;
          }
          exitPrice = finalExitPrice;
        }

        currentCapital += tradePnl;
        openPosition.exitTime = candle.timestamp;
        openPosition.exitPrice = exitPrice;
        openPosition.status = 'CLOSED';
        openPosition.pnl = tradePnl;
        openPosition.exitReason = exitReason;

        if (exitReason === 'Stop Loss') slHitsToday++;
        tradeHistory.push({ ...openPosition });
        openPosition = null;
      }
    }

    // Breakout re-entry check
    if (isEndOfBlock && openingRangeSet) {
      if (!openPosition && !canTriggerBreakout && fiveMinClose !== null && fiveMinClose >= openingRangeLow && fiveMinClose <= openingRangeHigh) {
        canTriggerBreakout = true;
      }
    }

    // ── FVG State Machine ──────────────────────────────────────────────────────
    if (isEndOfBlock && openingRangeSet && !openPosition) {
      // Cancellation
      if (fvgState !== 'IDLE' && fiveMinClose >= openingRangeLow && fiveMinClose <= openingRangeHigh) {
        fvgState = 'IDLE'; fvgCandleN2 = null; canTriggerBreakout = true;
      }
      // WAIT_NEXT_BLOCK → WAIT_PULLBACK
      else if (fvgState === 'WAIT_NEXT_BLOCK') {
        if (fvgCandleN2 === null) {
          fvgState = 'IDLE';
        } else if (fvgDirection === 'LONG') {
          if (fiveMinLow > fvgCandleN2.high) {
            fvgZoneLow = fvgCandleN2.high; fvgZoneHigh = fiveMinLow; fvgState = 'WAIT_PULLBACK';
          } else { fvgState = 'IDLE'; fvgCandleN2 = null; }
        } else if (fvgDirection === 'SHORT') {
          if (fvgCandleN2.low > fiveMinHigh) {
            fvgZoneLow = fiveMinHigh; fvgZoneHigh = fvgCandleN2.low; fvgState = 'WAIT_PULLBACK';
          } else { fvgState = 'IDLE'; fvgCandleN2 = null; }
        }
      }
      // WAIT_PULLBACK → entry
      else if (fvgState === 'WAIT_PULLBACK') {
        const touchedFVG = fiveMinLow <= fvgZoneHigh && fiveMinHigh >= fvgZoneLow;
        const isBullishBlock = fiveMinClose > fiveMinOpen;
        const isBearishBlock = fiveMinClose < fiveMinOpen;
        const dailyLimitFvg = (slHitsToday > 0 && params.maxTradesOnSLHit > 0) ? params.maxTradesOnSLHit : params.maxTradesPerDay;
        const dailyLimitOk = tradesTakenToday < dailyLimitFvg;
        const blockTimeOk = timeMinutes < squareOffMinutes;

        if (fvgDirection === 'LONG' && touchedFVG && isBullishBlock && dailyLimitOk && blockTimeOk) {
          const fvgIdx = i + 1;
          if (fvgIdx < marketData.length) {
            const fvgEc = marketData[fvgIdx];
            const entrySpot = fvgEc.open;
            const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
            const hasOptFvg = fvgEc.options !== undefined || fvgEc.atmStrike !== undefined;
            let entryPrice = entrySpot + params.slippagePoints;
            let ceEP = 0, peEP = 0;
            if (params.tradeType === 'OPTIONS' && hasOptFvg) {
              const cePrem = getOptionPrice(fvgEc, entryStrikeFvg, 'CE', 'open');
              const pePrem = getOptionPrice(fvgEc, entryStrikeFvg, 'PE', 'open');
              ceEP = cePrem + params.slippagePoints;
              peEP = pePrem - params.slippagePoints;
              entryPrice = ceEP - peEP * (finalShortLots / finalLongLots);
            }
            const slPrice = fiveMinLow;
            const slDist = (entrySpot + params.slippagePoints) - slPrice;
            const targetPrice = (entrySpot + params.slippagePoints) + (2 * slDist);
            openPosition = { entryTime: fvgEc.timestamp, entryPrice, type: 'LONG', quantity: lotSize * finalLongLots,
              status: 'OPEN', entrySpot, stopLossPrice: slPrice, targetPrice, strikePrice: entryStrikeFvg, ceEntryPrice: ceEP, peEntryPrice: peEP };
            fvgState = 'IDLE'; fvgCandleN2 = null; canTriggerBreakout = false; tradesTakenToday++;
          }
        } else if (fvgDirection === 'SHORT' && touchedFVG && isBearishBlock && dailyLimitOk && blockTimeOk) {
          const fvgIdx = i + 1;
          if (fvgIdx < marketData.length) {
            const fvgEc = marketData[fvgIdx];
            const entrySpot = fvgEc.open;
            const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
            const hasOptFvg = fvgEc.options !== undefined || fvgEc.atmStrike !== undefined;
            let entryPrice = entrySpot - params.slippagePoints;
            let ceEP = 0, peEP = 0;
            if (params.tradeType === 'OPTIONS' && hasOptFvg) {
              const cePrem = getOptionPrice(fvgEc, entryStrikeFvg, 'CE', 'open');
              const pePrem = getOptionPrice(fvgEc, entryStrikeFvg, 'PE', 'open');
              ceEP = cePrem - params.slippagePoints;
              peEP = pePrem + params.slippagePoints;
              entryPrice = peEP - ceEP * (finalShortLots / finalLongLots);
            }
            const slPrice = fiveMinHigh;
            const slDist = slPrice - (entrySpot - params.slippagePoints);
            const targetPrice = (entrySpot - params.slippagePoints) - (2 * slDist);
            openPosition = { entryTime: fvgEc.timestamp, entryPrice, type: 'SHORT', quantity: lotSize * finalLongLots,
              status: 'OPEN', entrySpot, stopLossPrice: slPrice, targetPrice, strikePrice: entryStrikeFvg, ceEntryPrice: ceEP, peEntryPrice: peEP };
            fvgState = 'IDLE'; fvgCandleN2 = null; canTriggerBreakout = false; tradesTakenToday++;
          }
        }
      }
    }

    // FVG breakout detection (triggers WAIT_NEXT_BLOCK)
    const blockStartMinutes = (9 * 60 + 15) + currentBlockId * 5;
    if (!openPosition && isEndOfBlock && openingRangeSet && fvgState === 'IDLE' && blockStartMinutes >= entryStartMinutes && blockStartMinutes < entryEndMinutes) {
      const dailyLimit = (slHitsToday > 0 && params.maxTradesOnSLHit > 0) ? params.maxTradesOnSLHit : params.maxTradesPerDay;
      if (tradesTakenToday < dailyLimit && canTriggerBreakout) {
        let triggerType = null;
        let hasBody = false;
        if (fiveMinOpen !== null && fiveMinClose !== null) {
          const body = Math.abs(fiveMinClose - fiveMinOpen);
          const isGreen = fiveMinClose > fiveMinOpen;
          const wicks = isGreen ? (fiveMinHigh - fiveMinClose) + (fiveMinOpen - fiveMinLow) : (fiveMinHigh - fiveMinOpen) + (fiveMinClose - fiveMinLow);
          hasBody = body > 0 && body >= wicks;
        }
        if (hasBody) {
          if (fiveMinClose > openingRangeHigh) triggerType = 'LONG';
          else if (fiveMinClose < openingRangeLow) triggerType = 'SHORT';
        }
        if (triggerType) {
          fvgDirection = triggerType;
          fvgCandleN2 = prevCompletedBlock ? { ...prevCompletedBlock } : null;
          fvgState = 'WAIT_NEXT_BLOCK';
          canTriggerBreakout = false;
        }
      }
    }

    // Drawdown tracking
    let currentEquity = currentCapital;
    if (openPosition) {
      const hasOptions = candle.options !== undefined || candle.atmStrike !== undefined;
      let openPnl = 0;
      if (params.tradeType === 'OPTIONS' && hasOptions) {
        const cePrice = getOptionPrice(candle, openPosition.strikePrice, 'CE', 'close');
        const pePrice = getOptionPrice(candle, openPosition.strikePrice, 'PE', 'close');
        if (openPosition.type === 'LONG') {
          openPnl = (cePrice - openPosition.ceEntryPrice) * lotSize * finalLongLots + (openPosition.peEntryPrice - pePrice) * lotSize * finalShortLots - params.brokerageFlat;
        } else {
          openPnl = (openPosition.ceEntryPrice - cePrice) * lotSize * finalShortLots + (pePrice - openPosition.peEntryPrice) * lotSize * finalLongLots - params.brokerageFlat;
        }
      } else {
        openPnl = openPosition.type === 'LONG'
          ? (candle.close - openPosition.entryPrice) * openPosition.quantity - params.brokerageFlat
          : (openPosition.entryPrice - candle.close) * openPosition.quantity - params.brokerageFlat;
      }
      currentEquity += openPnl;
    }
    if (currentEquity > maxEquity) maxEquity = currentEquity;
    const drawdown = maxEquity - currentEquity;
    if (drawdown > maxDrawdownValue) maxDrawdownValue = drawdown;
  }

  const winningTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0);
  const winRate = tradeHistory.length > 0 ? (winningTrades.length / tradeHistory.length) * 100 : 0;
  const netProfit = currentCapital - 200000;
  const recoveryFactor = maxDrawdownValue > 0 ? netProfit / maxDrawdownValue : 0;

  return { netProfit, winRate, totalTrades: tradeHistory.length, maxDrawdown: maxDrawdownValue, recoveryFactor };
}

// ── 4. Grid Search (FVG only) ─────────────────────────────────────────────────
const openingRangeOptions = [15, 30];
const trailToCostOptions = [false, true];
const trailingSLOptions = [0, 15, 30, 50];
const tradeLimitConfigs = [
  { maxTradesPerDay: 3, maxTradesOnSLHit: 1 },
  { maxTradesPerDay: 2, maxTradesOnSLHit: 1 },
  { maxTradesPerDay: 1, maxTradesOnSLHit: 1 }
];

const baselineParams = {
  openingRangeMinutes: 15,
  direction: 'BOTH',
  stopLossType: 'ENTRY_CANDLE',
  stopLossValue: 2,
  takeProfitType: 'SL_MULTIPLE',
  takeProfitValue: 2,
  entryStartTime: '09:30',
  entryEndTime: '15:29',
  squareOffTime: '15:29',
  lotSize: 65,
  numberOfLots: 1,
  longOptionLots: 1,
  shortOptionLots: 0,
  slippagePoints: 1.0,
  brokerageFlat: 250,
  tradeType: 'OPTIONS',
  maxTradesPerDay: 3,
  maxTradesOnSLHit: 1,
  trailingStopLoss: 0,
  trailToCostAtFiftyPercentTarget: false,
  entryType: 'FVG'
};

const setups = [
  { name: 'Buy 1, Sell 0', longLots: 1, shortLots: 0 },
  { name: 'Buy 1, Sell 1', longLots: 1, shortLots: 1 },
  { name: 'Buy 2, Sell 1', longLots: 2, shortLots: 1 }
];

let report = `# FVG Entry Optimization Report\n\n`;
report += `Grid search over FVG (Fair Value Gap) entry configurations (Sep 2024 – Jun 2026).\n`;
report += `FVG rules: Breakout = middle candle; wait for pullback into FVG zone; enter on bullish/bearish confirmation candle; SL = confirm candle low/high; TP = 2× SL distance.\n\n`;

for (const setup of setups) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`SETUP: ${setup.name}`);
  console.log('='.repeat(50));

  const currentBase = { ...baselineParams, longOptionLots: setup.longLots, shortOptionLots: setup.shortLots };
  const baseResult = runSimulation(currentBase);
  console.log(`Baseline: ₹${baseResult.netProfit.toFixed(0)}, WR: ${baseResult.winRate.toFixed(1)}%, Trades: ${baseResult.totalTrades}`);

  const results = [];
  for (const or of openingRangeOptions) {
    for (const trailCost of trailToCostOptions) {
      for (const trailSL of trailingSLOptions) {
        for (const limitConfig of tradeLimitConfigs) {
          const params = {
            ...currentBase,
            openingRangeMinutes: or,
            trailToCostAtFiftyPercentTarget: trailCost,
            trailingStopLoss: trailSL,
            maxTradesPerDay: limitConfig.maxTradesPerDay,
            maxTradesOnSLHit: limitConfig.maxTradesOnSLHit
          };
          const res = runSimulation(params);
          results.push({ params: { openingRangeMinutes: or, trailToCostAtFiftyPercentTarget: trailCost, trailingStopLoss: trailSL, ...limitConfig }, metrics: res });
        }
      }
    }
  }

  results.sort((a, b) => b.metrics.netProfit - a.metrics.netProfit || b.metrics.recoveryFactor - a.metrics.recoveryFactor);

  report += `\n## Setup: **${setup.name}**\n`;
  report += `### Baseline (OR=15m, No Trail)\n`;
  report += `* Net Profit: ₹${baseResult.netProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}\n`;
  report += `* Win Rate: ${baseResult.winRate.toFixed(2)}%\n`;
  report += `* Trades: ${baseResult.totalTrades}\n`;
  report += `* Max Drawdown: ₹${baseResult.maxDrawdown.toLocaleString('en-IN', { maximumFractionDigits: 0 })}\n`;
  report += `* Recovery Factor: ${baseResult.recoveryFactor.toFixed(2)}\n\n`;

  report += `### 🏆 Top 10 Configurations\n\n`;
  report += `| Rank | Range | Trail to Cost | Trailing SL | Max Trades / SL Cap | Net Profit (₹) | Win Rate (%) | Trades | Max DD (₹) | Recovery Factor |\n`;
  report += `|---|---|---|---|---|---|---|---|---|---|\n`;

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const p = r.params;
    const m = r.metrics;
    const limitStr = `Max ${p.maxTradesPerDay} (Max ${p.maxTradesOnSLHit} if SL)`;
    report += `| **#${i + 1}** | ${p.openingRangeMinutes}m | ${p.trailToCostAtFiftyPercentTarget ? 'Enabled' : 'Disabled'} | ${p.trailingStopLoss || 'Off'} | ${limitStr} | **₹${m.netProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}** | ${m.winRate.toFixed(1)}% | ${m.totalTrades} | ₹${m.maxDrawdown.toLocaleString('en-IN', { maximumFractionDigits: 0 })} | **${m.recoveryFactor.toFixed(2)}** |\n`;
  }

  console.log(`Top result: ₹${results[0].metrics.netProfit.toFixed(0)}, WR: ${results[0].metrics.winRate.toFixed(1)}%, RF: ${results[0].metrics.recoveryFactor.toFixed(2)}`);
}

const outPath = 'c:/Users/Madhav/.gemini/antigravity-ide/brain/0bc3c4d4-35f2-4e01-bb15-8c163f31497c/optimization_results.md';
fs.writeFileSync(outPath, report);
console.log(`\nFVG optimization complete. Results written to ${outPath}`);
