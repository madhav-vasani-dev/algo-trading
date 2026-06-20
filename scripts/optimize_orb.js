const fs = require('fs');
const path = require('path');

// 1. Load data from public/data/nifty_1min
const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
console.log(`Loading data files from ${dataDir}...`);
const files = fs.readdirSync(dataDir)
  .filter(f => f.endsWith('.json'))
  .sort();

let marketData = [];
for (const file of files) {
  const filePath = path.join(dataDir, file);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    marketData = marketData.concat(data);
  } catch (err) {
    console.error(`Error loading ${file}:`, err.message);
  }
}

console.log(`Loaded ${marketData.length} total 1-minute candles.`);

// Parse timestamps to Date objects once
marketData = marketData.map(c => ({
  ...c,
  timestamp: new Date(c.timestamp)
}));

// Helper to convert Date to IST time details
function getISTTime(date) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  
  const year = ist.getFullYear();
  const month = String(ist.getMonth() + 1).padStart(2, '0');
  const day = String(ist.getDate()).padStart(2, '0');
  const hour = ist.getHours();
  const minute = ist.getMinutes();
  
  return {
    hour,
    minute,
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

// 5-minute block identifier base 09:15
function getFiveMinBlockId(timestamp) {
  const ist = getISTTime(timestamp);
  const blockBase = 9 * 60 + 15;
  const timeMinutes = ist.hour * 60 + ist.minute;
  const minutesSinceBase = timeMinutes - blockBase;
  if (minutesSinceBase < 0) return -1;
  return Math.floor(minutesSinceBase / 5);
}

// Options pricing helper matching getOptionPrice in TS
function getOptionPrice(candle, strike, type, field) {
  const strikeStr = String(strike);
  if (candle.options && candle.options[strikeStr] && candle.options[strikeStr][type]) {
    return candle.options[strikeStr][type][field];
  }
  // Fallback intrinsic value
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

// Emulate runORBSimulation inside a fast runner function (look-ahead free, correct breakout direction, re-entry check)
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
  let pendingLimitPrice = null;
  let pendingLimitType = null;
  let pendingLimitStrike = null;
  let breakoutFiveMinLow = -Infinity;
  let breakoutFiveMinHigh = Infinity;

  let fiveMinOpen = null;
  let fiveMinHigh = -Infinity;
  let fiveMinLow = Infinity;
  let fiveMinClose = null;
  let prevBlockId = -1;
  let blockStartCandleIndex = -1;

  // FVG state machine variables
  let prevCompletedBlock = null; // rolling last closed 5-min block (candle[n-2] at breakout time)
  let fvgState = 'IDLE'; // 'IDLE' | 'WAIT_NEXT_BLOCK' | 'WAIT_PULLBACK'
  let fvgDirection = null;
  let fvgZoneLow = 0;
  let fvgZoneHigh = 0;
  let fvgCandleN2 = null; // candle[n-2] stored at breakout detection

  const parseTimeToMinutes = (timeStr) => {
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  };

  const entryStartMinutes = parseTimeToMinutes(params.entryStartTime || '09:30');
  const entryEndMinutes = parseTimeToMinutes(params.entryEndTime || '14:30');
  const squareOffMinutes = parseTimeToMinutes(params.squareOffTime || '15:15');

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
      pendingLimitPrice = null;
      pendingLimitType = null;
      pendingLimitStrike = null;
      breakoutFiveMinLow = -Infinity;
      breakoutFiveMinHigh = Infinity;

      fiveMinOpen = null;
      fiveMinHigh = -Infinity;
      fiveMinLow = Infinity;
      fiveMinClose = null;
      prevBlockId = -1;
      blockStartCandleIndex = -1;

      // Reset FVG state
      prevCompletedBlock = null;
      fvgState = 'IDLE';
      fvgDirection = null;
      fvgZoneLow = 0;
      fvgZoneHigh = 0;
      fvgCandleN2 = null;
    }

    const marketOpenMinutes = 9 * 60 + 15;
    const rangeEndMinutes = marketOpenMinutes + params.openingRangeMinutes;

    const currentBlockId = getFiveMinBlockId(candle.timestamp);
    if (prevBlockId !== currentBlockId) {
      // Save completed block for FVG tracking BEFORE resetting
      if (prevBlockId !== -1 && fiveMinClose !== null) {
        prevCompletedBlock = { open: fiveMinOpen, high: fiveMinHigh, low: fiveMinLow, close: fiveMinClose };
      }
      fiveMinOpen = candle.open;
      fiveMinHigh = candle.high;
      fiveMinLow = candle.low;
      fiveMinClose = candle.close;
      prevBlockId = currentBlockId;
      blockStartCandleIndex = i;
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
      if (nextIst.dateStr !== ist.dateStr) {
        isNewDayNext = true;
      }
    }
    const isEndOfBlock = (currentBlockId !== nextBlockId) || isNewDayNext || (i === marketData.length - 1);

    if (timeMinutes >= marketOpenMinutes && timeMinutes < rangeEndMinutes) {
      openingRangeHigh = Math.max(openingRangeHigh, candle.high);
      openingRangeLow = Math.min(openingRangeLow, candle.low);
    } else if (timeMinutes >= rangeEndMinutes && openingRangeHigh !== -Infinity) {
      openingRangeSet = true;
    }

    // 3. Monitor Position
    if (openPosition) {
      // Trailing SL
      if (params.trailingStopLoss && params.trailingStopLoss > 0) {
        if (openPosition.type === 'LONG') {
          const currentPeak = openPosition.peakSpot !== undefined ? openPosition.peakSpot : openPosition.entrySpot;
          if (candle.high > currentPeak) {
            openPosition.peakSpot = candle.high;
            const newSL = candle.high - params.trailingStopLoss;
            if (newSL > openPosition.stopLossPrice) {
              openPosition.stopLossPrice = newSL;
            }
          }
        } else {
          const currentTrough = openPosition.troughSpot !== undefined ? openPosition.troughSpot : openPosition.entrySpot;
          if (candle.low < currentTrough) {
            openPosition.troughSpot = candle.low;
            const newSL = candle.low + params.trailingStopLoss;
            if (newSL < openPosition.stopLossPrice) {
              openPosition.stopLossPrice = newSL;
            }
          }
        }
      }

      // Trail to cost at 50% target
      if (params.trailToCostAtFiftyPercentTarget && !openPosition.isSlMovedToCost) {
        if (openPosition.type === 'LONG') {
          const halfwayTarget = openPosition.entrySpot + 0.5 * (openPosition.targetPrice - openPosition.entrySpot);
          if (candle.high >= halfwayTarget) {
            openPosition.stopLossPrice = openPosition.entrySpot;
            openPosition.isSlMovedToCost = true;
          }
        } else {
          const halfwayTarget = openPosition.entrySpot - 0.5 * (openPosition.entrySpot - openPosition.targetPrice);
          if (candle.low <= halfwayTarget) {
            openPosition.stopLossPrice = openPosition.entrySpot;
            openPosition.isSlMovedToCost = true;
          }
        }
      }

      let shouldExit = false;
      let exitSpotPrice = candle.close;
      let exitReason = '';

      if (openPosition.type === 'LONG' && candle.high > openPosition.targetPrice) {
        shouldExit = true;
        exitSpotPrice = openPosition.targetPrice;
        exitReason = 'Target';
      } else if (openPosition.type === 'SHORT' && candle.low < openPosition.targetPrice) {
        shouldExit = true;
        exitSpotPrice = openPosition.targetPrice;
        exitReason = 'Target';
      }

      if (!shouldExit) {
        if (openPosition.type === 'LONG' && candle.low < openPosition.stopLossPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.stopLossPrice;
          exitReason = 'Stop Loss';
        } else if (openPosition.type === 'SHORT' && candle.high > openPosition.stopLossPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.stopLossPrice;
          exitReason = 'Stop Loss';
        }
      }

      if (!shouldExit && timeMinutes >= squareOffMinutes) {
        shouldExit = true;
        exitSpotPrice = candle.close;
        exitReason = 'Square-off';
      }

      if (shouldExit) {
        let tradePnl = 0;
        let exitPrice = exitSpotPrice;

        const hasOptions = candle.options !== undefined || candle.atmStrike !== undefined;
        let ceExitPrice = 0;
        let peExitPrice = 0;

        if (params.tradeType === 'OPTIONS' && hasOptions) {
          let ceExitField = 'close';
          let peExitField = 'close';

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
            ceExitPrice = ceExitPremium - params.slippagePoints;
            peExitPrice = peExitPremium + params.slippagePoints;
            const cePnl = (ceExitPrice - openPosition.ceEntryPrice) * lotSize * finalLongLots;
            const pePnl = (openPosition.peEntryPrice - peExitPrice) * lotSize * finalShortLots;
            tradePnl = cePnl + pePnl - params.brokerageFlat;
            exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
          } else {
            ceExitPrice = ceExitPremium + params.slippagePoints;
            peExitPrice = peExitPremium - params.slippagePoints;
            const cePnl = (openPosition.ceEntryPrice - ceExitPrice) * lotSize * finalShortLots;
            const pePnl = (peExitPrice - openPosition.peEntryPrice) * lotSize * finalLongLots;
            tradePnl = cePnl + pePnl - params.brokerageFlat;
            exitPrice = peExitPrice - ceExitPrice * (finalShortLots / finalLongLots);
          }
        } else {
          // Spot mode exit
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
        openPosition.ceExitPrice = ceExitPrice;
        openPosition.peExitPrice = peExitPrice;
        openPosition.exitReason = exitReason;

        if (exitReason === 'Stop Loss') {
          slHitsToday++;
        }

        tradeHistory.push({ ...openPosition });
        openPosition = null;
      }
    }

    // Monitor Pending Limit Order (if any)
    if (!openPosition && pendingLimitPrice !== null) {
      let filled = false;
      const currentSpot = pendingLimitPrice;

      if (pendingLimitType === 'LONG') {
        if (candle.low <= pendingLimitPrice) filled = true;
      } else if (pendingLimitType === 'SHORT') {
        if (candle.high >= pendingLimitPrice) filled = true;
      }

      if (filled) {
        const quantity = lotSize * finalLongLots;
        const entryStrike = pendingLimitStrike;
        
        let entryPrice = currentSpot;
        const hasOptions = candle.options !== undefined || candle.atmStrike !== undefined;

        let ceEntryPrice = 0;
        let peEntryPrice = 0;

        if (params.tradeType === 'OPTIONS' && hasOptions) {
          const ceEntryPremium = getOptionPrice(candle, entryStrike, 'CE', 'open');
          const peEntryPremium = getOptionPrice(candle, entryStrike, 'PE', 'open');

          if (pendingLimitType === 'LONG') {
            ceEntryPrice = ceEntryPremium + params.slippagePoints;
            peEntryPrice = peEntryPremium - params.slippagePoints;
            entryPrice = ceEntryPrice - peEntryPrice * (finalShortLots / finalLongLots);
          } else {
            ceEntryPrice = ceEntryPremium - params.slippagePoints;
            peEntryPrice = peEntryPremium + params.slippagePoints;
            entryPrice = peEntryPrice - ceEntryPrice * (finalShortLots / finalLongLots);
          }
        } else {
          if (pendingLimitType === 'LONG') entryPrice += params.slippagePoints;
          else entryPrice -= params.slippagePoints;
        }

        // Calculate Spot SL
        let stopLossPrice = 0;
        if (params.stopLossType === 'OR_OPPOSITE') {
          stopLossPrice = pendingLimitType === 'LONG' ? openingRangeLow : openingRangeHigh;
        } else if (params.stopLossType === 'POINTS') {
          stopLossPrice = pendingLimitType === 'LONG' ? (currentSpot - params.stopLossValue) : (currentSpot + params.stopLossValue);
        } else if (params.stopLossType === 'PERCENT') {
          stopLossPrice = pendingLimitType === 'LONG'
            ? currentSpot * (1 - params.stopLossValue / 100)
            : currentSpot * (1 + params.stopLossValue / 100);
        } else if (params.stopLossType === 'ENTRY_CANDLE') {
          stopLossPrice = pendingLimitType === 'LONG'
            ? (breakoutFiveMinLow - params.stopLossValue)
            : (breakoutFiveMinHigh + params.stopLossValue);
        }

        // Calculate Spot Target
        let targetPrice = 0;
        if (params.takeProfitType === 'OR_MULTIPLE') {
          const rangeSize = openingRangeHigh - openingRangeLow;
          targetPrice = pendingLimitType === 'LONG'
            ? currentSpot + (params.takeProfitValue * rangeSize)
            : currentSpot - (params.takeProfitValue * rangeSize);
        } else if (params.takeProfitType === 'POINTS') {
          targetPrice = pendingLimitType === 'LONG' ? (currentSpot + params.takeProfitValue) : (currentSpot - params.takeProfitValue);
        } else if (params.takeProfitType === 'PERCENT') {
          targetPrice = pendingLimitType === 'LONG'
            ? currentSpot * (1 + params.takeProfitValue / 100)
            : currentSpot * (1 - params.takeProfitValue / 100);
        } else if (params.takeProfitType === 'SL_MULTIPLE') {
          const slDistance = Math.abs(currentSpot - stopLossPrice);
          targetPrice = pendingLimitType === 'LONG'
            ? currentSpot + (params.takeProfitValue * slDistance)
            : currentSpot - (params.takeProfitValue * slDistance);
        }

        openPosition = {
          entryTime: candle.timestamp,
          entryPrice: entryPrice,
          type: pendingLimitType,
          quantity: quantity,
          status: 'OPEN',
          entrySpot: currentSpot,
          stopLossPrice: stopLossPrice,
          targetPrice: targetPrice,
          strikePrice: entryStrike,
          ceEntryPrice,
          peEntryPrice
        };

        pendingLimitPrice = null;
        pendingLimitType = null;
        pendingLimitStrike = null;
        tradesTakenToday++;

        // Retroactive monitor exit on same candle
        if (params.trailingStopLoss && params.trailingStopLoss > 0) {
          if (openPosition.type === 'LONG') {
            const currentPeak = openPosition.peakSpot !== undefined ? openPosition.peakSpot : openPosition.entrySpot;
            if (candle.high > currentPeak) {
              openPosition.peakSpot = candle.high;
              const newSL = candle.high - params.trailingStopLoss;
              if (newSL > openPosition.stopLossPrice) openPosition.stopLossPrice = newSL;
            }
          } else {
            const currentTrough = openPosition.troughSpot !== undefined ? openPosition.troughSpot : openPosition.entrySpot;
            if (candle.low < currentTrough) {
              openPosition.troughSpot = candle.low;
              const newSL = candle.low + params.trailingStopLoss;
              if (newSL < openPosition.stopLossPrice) openPosition.stopLossPrice = newSL;
            }
          }
        }

        if (params.trailToCostAtFiftyPercentTarget && !openPosition.isSlMovedToCost) {
          if (openPosition.type === 'LONG') {
            const halfwayTarget = openPosition.entrySpot + 0.5 * (openPosition.targetPrice - openPosition.entrySpot);
            if (candle.high >= halfwayTarget) {
              openPosition.stopLossPrice = openPosition.entrySpot;
              openPosition.isSlMovedToCost = true;
            }
          } else {
            const halfwayTarget = openPosition.entrySpot - 0.5 * (openPosition.entrySpot - openPosition.targetPrice);
            if (candle.low <= halfwayTarget) {
              openPosition.stopLossPrice = openPosition.entrySpot;
              openPosition.isSlMovedToCost = true;
            }
          }
        }

        let shouldExit = false;
        let exitSpotPrice = candle.close;
        let exitReason = '';

        if (openPosition.type === 'LONG' && candle.high > openPosition.targetPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.targetPrice;
          exitReason = 'Target';
        } else if (openPosition.type === 'SHORT' && candle.low < openPosition.targetPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.targetPrice;
          exitReason = 'Target';
        }

        if (!shouldExit) {
          if (openPosition.type === 'LONG' && candle.low < openPosition.stopLossPrice) {
            shouldExit = true;
            exitSpotPrice = openPosition.stopLossPrice;
            exitReason = 'Stop Loss';
          } else if (openPosition.type === 'SHORT' && candle.high > openPosition.stopLossPrice) {
            shouldExit = true;
            exitSpotPrice = openPosition.stopLossPrice;
            exitReason = 'Stop Loss';
          }
        }

        if (!shouldExit && timeMinutes >= squareOffMinutes) {
          shouldExit = true;
          exitSpotPrice = candle.close;
          exitReason = 'Square-off';
        }

        if (shouldExit) {
          let exitPrice = exitSpotPrice;
          let tradePnl = 0;

          if (params.tradeType === 'OPTIONS') {
            const optType = openPosition.type === 'LONG' ? 'CE' : 'PE';
            let ceExitField = 'close';
            let peExitField = 'close';
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
              const ceExitPrice = ceExitPremium - params.slippagePoints;
              const peExitPrice = peExitPremium + params.slippagePoints;
              const cePnl = (ceExitPrice - openPosition.ceEntryPrice) * lotSize * finalLongLots;
              const pePnl = (openPosition.peEntryPrice - peExitPrice) * lotSize * finalShortLots;
              tradePnl = cePnl + pePnl - params.brokerageFlat;
              exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
            } else {
              const ceExitPrice = ceExitPremium + params.slippagePoints;
              const peExitPrice = peExitPremium - params.slippagePoints;
              const cePnl = (openPosition.ceEntryPrice - ceExitPrice) * lotSize * finalShortLots;
              const pePnl = (peExitPrice - openPosition.peEntryPrice) * lotSize * finalLongLots;
              tradePnl = cePnl + pePnl - params.brokerageFlat;
              exitPrice = peExitPrice - ceExitPrice * (finalShortLots / finalLongLots);
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
      } else {
        // Cancel logic
        let cancel = false;
        if (pendingLimitType === 'LONG') {
          if (candle.close < openingRangeHigh) cancel = true;
        } else if (pendingLimitType === 'SHORT') {
          if (candle.close > openingRangeLow) cancel = true;
        }

        if (cancel) {
          pendingLimitPrice = null;
          pendingLimitType = null;
          pendingLimitStrike = null;
          canTriggerBreakout = true;
        }
      }
    }

    // Breakout re-entry check on block close
    if (isEndOfBlock && openingRangeSet) {
      if (!openPosition && !canTriggerBreakout && fiveMinClose !== null && fiveMinClose >= openingRangeLow && fiveMinClose <= openingRangeHigh) {
        canTriggerBreakout = true;
      }
    }

    // ── FVG State Machine (block-close transitions) ──────────────────────────
    if (params.entryType === 'FVG' && isEndOfBlock && openingRangeSet && !openPosition) {

      // Cancellation: price re-entered ORB range
      if (fvgState !== 'IDLE' && fiveMinClose >= openingRangeLow && fiveMinClose <= openingRangeHigh) {
        fvgState = 'IDLE';
        fvgCandleN2 = null;
        canTriggerBreakout = true;
      }

      // WAIT_NEXT_BLOCK → WAIT_PULLBACK: confirm FVG zone from candle[n]
      else if (fvgState === 'WAIT_NEXT_BLOCK') {
        if (fvgCandleN2 === null) {
          fvgState = 'IDLE';
        } else if (fvgDirection === 'LONG') {
          if (fiveMinLow > fvgCandleN2.high) {
            fvgZoneLow = fvgCandleN2.high;
            fvgZoneHigh = fiveMinLow;
            fvgState = 'WAIT_PULLBACK';
          } else {
            fvgState = 'IDLE';
            fvgCandleN2 = null;
          }
        } else if (fvgDirection === 'SHORT') {
          if (fvgCandleN2.low > fiveMinHigh) {
            fvgZoneLow = fiveMinHigh;
            fvgZoneHigh = fvgCandleN2.low;
            fvgState = 'WAIT_PULLBACK';
          } else {
            fvgState = 'IDLE';
            fvgCandleN2 = null;
          }
        }
      }

      // WAIT_PULLBACK: check for confirmation candle touching FVG zone
      else if (fvgState === 'WAIT_PULLBACK') {
        const touchedFVG = fiveMinLow <= fvgZoneHigh && fiveMinHigh >= fvgZoneLow;
        const isBullishBlock = fiveMinClose > fiveMinOpen;
        const isBearishBlock = fiveMinClose < fiveMinOpen;
        const dailyLimitFvg = (slHitsToday > 0 && params.maxTradesOnSLHit > 0)
          ? params.maxTradesOnSLHit : params.maxTradesPerDay;
        const dailyLimitOk = tradesTakenToday < dailyLimitFvg;
        const blockTimeOk = timeMinutes < squareOffMinutes;

        if (fvgDirection === 'LONG' && touchedFVG && isBullishBlock && dailyLimitOk && blockTimeOk) {
          const fvgEntryCandleIndex = i + 1;
          if (fvgEntryCandleIndex < marketData.length) {
            const fvgEntryCandle = marketData[fvgEntryCandleIndex];
            const entrySpot = fvgEntryCandle.open;
            const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
            const hasOptionsFvg = fvgEntryCandle.options !== undefined || fvgEntryCandle.atmStrike !== undefined;

            let entryPrice = entrySpot + params.slippagePoints;
            let ceEntryPrice = 0;
            let peEntryPrice = 0;

            if (params.tradeType === 'OPTIONS' && hasOptionsFvg) {
              const ceEntryPremium = getOptionPrice(fvgEntryCandle, entryStrikeFvg, 'CE', 'open');
              const peEntryPremium = getOptionPrice(fvgEntryCandle, entryStrikeFvg, 'PE', 'open');
              ceEntryPrice = ceEntryPremium + params.slippagePoints;
              peEntryPrice = peEntryPremium - params.slippagePoints;
              entryPrice = ceEntryPrice - peEntryPrice * (finalShortLots / finalLongLots);
            }

            // SL and TP in spot terms (triggers); P&L uses option prices in exit logic
            const slPrice = fiveMinLow;
            const slDist = (entrySpot + params.slippagePoints) - slPrice;
            const targetPrice = (entrySpot + params.slippagePoints) + (2 * slDist);

            const quantity = lotSize * finalLongLots;
            openPosition = {
              entryTime: fvgEntryCandle.timestamp,
              entryPrice,
              type: 'LONG',
              quantity,
              status: 'OPEN',
              entrySpot,
              stopLossPrice: slPrice,
              targetPrice,
              strikePrice: entryStrikeFvg,
              ceEntryPrice,
              peEntryPrice
            };
            fvgState = 'IDLE';
            fvgCandleN2 = null;
            canTriggerBreakout = false;
            tradesTakenToday++;
          }
        } else if (fvgDirection === 'SHORT' && touchedFVG && isBearishBlock && dailyLimitOk && blockTimeOk) {
          const fvgEntryCandleIndex = i + 1;
          if (fvgEntryCandleIndex < marketData.length) {
            const fvgEntryCandle = marketData[fvgEntryCandleIndex];
            const entrySpot = fvgEntryCandle.open;
            const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
            const hasOptionsFvg = fvgEntryCandle.options !== undefined || fvgEntryCandle.atmStrike !== undefined;

            let entryPrice = entrySpot - params.slippagePoints;
            let ceEntryPrice = 0;
            let peEntryPrice = 0;

            if (params.tradeType === 'OPTIONS' && hasOptionsFvg) {
              const ceEntryPremium = getOptionPrice(fvgEntryCandle, entryStrikeFvg, 'CE', 'open');
              const peEntryPremium = getOptionPrice(fvgEntryCandle, entryStrikeFvg, 'PE', 'open');
              ceEntryPrice = ceEntryPremium - params.slippagePoints;
              peEntryPrice = peEntryPremium + params.slippagePoints;
              entryPrice = peEntryPrice - ceEntryPrice * (finalShortLots / finalLongLots);
            }

            // SL and TP in spot terms (triggers); P&L uses option prices in exit logic
            const slPrice = fiveMinHigh;
            const slDist = slPrice - (entrySpot - params.slippagePoints);
            const targetPrice = (entrySpot - params.slippagePoints) - (2 * slDist);

            const quantity = lotSize * finalLongLots;
            openPosition = {
              entryTime: fvgEntryCandle.timestamp,
              entryPrice,
              type: 'SHORT',
              quantity,
              status: 'OPEN',
              entrySpot,
              stopLossPrice: slPrice,
              targetPrice,
              strikePrice: entryStrikeFvg,
              ceEntryPrice,
              peEntryPrice
            };
            fvgState = 'IDLE';
            fvgCandleN2 = null;
            canTriggerBreakout = false;
            tradesTakenToday++;
          }
        }
      }
    }
    // ── End of FVG State Machine ─────────────────────────────────────────────

    const blockStartMinutes = (9 * 60 + 15) + currentBlockId * 5;
    if (!openPosition && isEndOfBlock && openingRangeSet && blockStartMinutes >= entryStartMinutes && blockStartMinutes < entryEndMinutes) {
      const dailyLimit = (slHitsToday > 0 && params.maxTradesOnSLHit > 0)
        ? params.maxTradesOnSLHit
        : params.maxTradesPerDay;

      if (tradesTakenToday < dailyLimit) {
        if (canTriggerBreakout) {
          let triggerType = null;
          let hasBody = false;
          if (fiveMinOpen !== null && fiveMinClose !== null) {
            const isGreen = fiveMinClose > fiveMinOpen;
            const body = Math.abs(fiveMinClose - fiveMinOpen);
            const wicks = isGreen
              ? (fiveMinHigh - fiveMinClose) + (fiveMinOpen - fiveMinLow)
              : (fiveMinHigh - fiveMinOpen) + (fiveMinClose - fiveMinLow);
            hasBody = body > 0 && body >= wicks;
          }

          if (hasBody) {
            if (fiveMinClose > openingRangeHigh) {
              triggerType = params.entryType === 'REVERSION' ? 'SHORT' : 'LONG';
            } else if (fiveMinClose < openingRangeLow) {
              triggerType = params.entryType === 'REVERSION' ? 'LONG' : 'SHORT';
            }
          }

          if (triggerType) {
            const entryStrike = Math.round(fiveMinClose / 50) * 50;

            if (params.entryType === 'FVG') {
              // Breakout → initiate FVG: store candle[n-2] and await next block
              fvgDirection = triggerType;
              fvgCandleN2 = prevCompletedBlock ? { ...prevCompletedBlock } : null;
              fvgState = 'WAIT_NEXT_BLOCK';
              canTriggerBreakout = false;
            } else if (params.entryType === 'RETEST') {
              pendingLimitPrice = triggerType === 'LONG' ? openingRangeHigh : openingRangeLow;
              pendingLimitType = triggerType;
              pendingLimitStrike = entryStrike;
              breakoutFiveMinLow = fiveMinLow;
              breakoutFiveMinHigh = fiveMinHigh;
              canTriggerBreakout = false;
            } else {
              const entryCandleIndex = i + 1;
              if (entryCandleIndex < marketData.length) {
                const entryCandle = marketData[entryCandleIndex];

              const lastTrade = tradeHistory[tradeHistory.length - 1];
              const isOverlap = lastTrade && lastTrade.exitTime && lastTrade.exitTime.getTime() > entryCandle.timestamp.getTime();

              if (!isOverlap) {
                const quantity = lotSize * finalLongLots;
                const hasOptions = entryCandle.options !== undefined || entryCandle.atmStrike !== undefined;
                const entryStrike = Math.round(fiveMinClose / 50) * 50;

                let entryPrice = entryCandle.open;
                let ceEntryPrice = 0;
                let peEntryPrice = 0;

                if (params.tradeType === 'OPTIONS' && hasOptions) {
                  const ceEntryPremium = getOptionPrice(entryCandle, entryStrike, 'CE', 'open');
                  const peEntryPremium = getOptionPrice(entryCandle, entryStrike, 'PE', 'open');

                  if (triggerType === 'LONG') {
                    ceEntryPrice = ceEntryPremium + params.slippagePoints;
                    peEntryPrice = peEntryPremium - params.slippagePoints;
                    entryPrice = ceEntryPrice - peEntryPrice * (finalShortLots / finalLongLots);
                  } else {
                    ceEntryPrice = ceEntryPremium - params.slippagePoints;
                    peEntryPrice = peEntryPremium + params.slippagePoints;
                    entryPrice = peEntryPrice - ceEntryPrice * (finalShortLots / finalLongLots);
                  }
                } else {
                  if (triggerType === 'LONG') {
                    entryPrice += params.slippagePoints;
                  } else {
                    entryPrice -= params.slippagePoints;
                  }
                }

                let stopLossPrice = 0;
                if (params.stopLossType === 'OR_OPPOSITE') {
                  stopLossPrice = triggerType === 'LONG' ? openingRangeLow : openingRangeHigh;
                } else if (params.stopLossType === 'POINTS') {
                  stopLossPrice = triggerType === 'LONG' ? (entryCandle.open - params.stopLossValue) : (entryCandle.open + params.stopLossValue);
                } else if (params.stopLossType === 'PERCENT') {
                  stopLossPrice = triggerType === 'LONG'
                    ? entryCandle.open * (1 - params.stopLossValue / 100)
                    : entryCandle.open * (1 + params.stopLossValue / 100);
                } else if (params.stopLossType === 'ENTRY_CANDLE') {
                  stopLossPrice = triggerType === 'LONG'
                    ? (fiveMinLow - params.stopLossValue)
                    : (fiveMinHigh + params.stopLossValue);
                }

                let targetPrice = 0;
                if (params.takeProfitType === 'OR_MULTIPLE') {
                  const rangeSize = openingRangeHigh - openingRangeLow;
                  targetPrice = triggerType === 'LONG'
                    ? entryCandle.open + (params.takeProfitValue * rangeSize)
                    : entryCandle.open - (params.takeProfitValue * rangeSize);
                } else if (params.takeProfitType === 'POINTS') {
                  targetPrice = triggerType === 'LONG' ? (entryCandle.open + params.takeProfitValue) : (entryCandle.open - params.takeProfitValue);
                } else if (params.takeProfitType === 'PERCENT') {
                  targetPrice = triggerType === 'LONG'
                    ? entryCandle.open * (1 + params.takeProfitValue / 100)
                    : entryCandle.open * (1 - params.takeProfitValue / 100);
                } else if (params.takeProfitType === 'SL_MULTIPLE') {
                  const slDistance = Math.abs(entryCandle.open - stopLossPrice);
                  targetPrice = triggerType === 'LONG'
                    ? entryCandle.open + (params.takeProfitValue * slDistance)
                    : entryCandle.open - (params.takeProfitValue * slDistance);
                }

                openPosition = {
                  entryTime: entryCandle.timestamp,
                  entryPrice: entryPrice,
                  type: triggerType,
                  status: 'OPEN',
                  entrySpot: entryCandle.open,
                  stopLossPrice: stopLossPrice,
                  targetPrice: targetPrice,
                  strikePrice: entryStrike,
                  ceEntryPrice,
                  peEntryPrice
                };

                canTriggerBreakout = false;
                tradesTakenToday++;
              }
            }
          }
          }
        }
      }
    }

    // Daily capital track for drawdown
    let currentEquity = currentCapital;
    if (openPosition) {
      const currentSpot = candle.close;
      let openPnl = 0;
      if (params.tradeType === 'OPTIONS' && candle.options !== undefined) {
        const cePrice = getOptionPrice(candle, openPosition.strikePrice, 'CE', 'close');
        const pePrice = getOptionPrice(candle, openPosition.strikePrice, 'PE', 'close');

        if (openPosition.type === 'LONG') {
          const cePnl = (cePrice - openPosition.ceEntryPrice) * lotSize * finalLongLots;
          const pePnl = (openPosition.peEntryPrice - pePrice) * lotSize * finalShortLots;
          openPnl = cePnl + pePnl - params.brokerageFlat;
        } else {
          const cePnl = (openPosition.ceEntryPrice - cePrice) * lotSize * finalShortLots;
          const pePnl = (pePrice - openPosition.peEntryPrice) * lotSize * finalLongLots;
          openPnl = cePnl + pePnl - params.brokerageFlat;
        }
      } else {
        if (openPosition.type === 'LONG') {
          openPnl = (currentSpot - openPosition.entryPrice) * openPosition.quantity - params.brokerageFlat;
        } else {
          openPnl = (openPosition.entryPrice - currentSpot) * openPosition.quantity - params.brokerageFlat;
        }
      }
      currentEquity += openPnl;
    }

    if (currentEquity > maxEquity) {
      maxEquity = currentEquity;
    }
    const drawdown = maxEquity - currentEquity;
    if (drawdown > maxDrawdownValue) {
      maxDrawdownValue = drawdown;
    }
  }

  const winningTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0);
  const winRate = tradeHistory.length > 0 ? (winningTrades.length / tradeHistory.length) * 100 : 0;
  const netProfit = currentCapital - 200000;
  const recoveryFactor = maxDrawdownValue > 0 ? netProfit / maxDrawdownValue : 0;

  return {
    netProfit,
    winRate,
    totalTrades: tradeHistory.length,
    maxDrawdown: maxDrawdownValue,
    recoveryFactor
  };
}

// 5. Grid Search Generation
const openingRangeOptions = [15, 30];
const takeProfitOptions = [1.5, 2.0, 2.5, 3.0];
const stopLossBufferOptions = [0, 2, 5];
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
  shortOptionLots: 0, // default simple buy options
  slippagePoints: 1.0,
  brokerageFlat: 250,
  tradeType: 'OPTIONS',
  maxTradesPerDay: 3,
  maxTradesOnSLHit: 1,
  trailingStopLoss: 0,
  trailToCostAtFiftyPercentTarget: false
};

// We will optimize for three main setups:
// 1. Buy 1, Sell 0
// 2. Buy 1, Sell 1 (Synthetic Futures / Hedge)
// 3. Buy 2, Sell 1 (Asymmetric Ratio)

const setups = [
  { name: 'Buy 1, Sell 0', longLots: 1, shortLots: 0 },
  { name: 'Buy 1, Sell 1', longLots: 1, shortLots: 1 },
  { name: 'Buy 2, Sell 1', longLots: 2, shortLots: 1 }
];

let finalReportMarkdown = `# Grid Search Strategy Optimization Report

This report summarizes the results of running a grid search over parameter combinations for three option lot configurations (September 2024 to June 2026).
All runs use the corrected **look-ahead free entry logic**, strict **09:15 block base**, and **canTriggerBreakout range re-entry checks**.
Entry types compared: **MARKET** (immediate breakout entry), **REVERSION** (mean reversion), and **FVG** (Fair Value Gap pullback).

`;

for (const setup of setups) {
  console.log(`\n==================================================`);
  console.log(`OPTIMIZING SETUP: ${setup.name}`);
  console.log(`==================================================`);

  const currentBaseline = {
    ...baselineParams,
    longOptionLots: setup.longLots,
    shortOptionLots: setup.shortLots
  };

  const baselineResult = runSimulation(currentBaseline);
  console.log(`Baseline Results:`, JSON.stringify(baselineResult, null, 2));

  const entryTypeOptions = ['MARKET', 'REVERSION', 'FVG'];

  const results = [];
  for (const entryType of entryTypeOptions) {
    for (const or of openingRangeOptions) {
      for (const tp of takeProfitOptions) {
        for (const slBuffer of stopLossBufferOptions) {
          for (const trailCost of trailToCostOptions) {
            for (const trailSL of trailingSLOptions) {
              for (const limitConfig of tradeLimitConfigs) {
                const params = {
                  ...currentBaseline,
                  entryType: entryType,
                  openingRangeMinutes: or,
                  takeProfitValue: tp,
                  stopLossValue: slBuffer,
                  trailToCostAtFiftyPercentTarget: trailCost,
                  trailingStopLoss: trailSL,
                  maxTradesPerDay: limitConfig.maxTradesPerDay,
                  maxTradesOnSLHit: limitConfig.maxTradesOnSLHit
                };

                const res = runSimulation(params);
                results.push({
                  params: {
                    entryType: entryType,
                    openingRangeMinutes: or,
                    takeProfitValue: tp,
                    stopLossValue: slBuffer,
                    trailToCostAtFiftyPercentTarget: trailCost,
                    trailingStopLoss: trailSL,
                    maxTradesPerDay: limitConfig.maxTradesPerDay,
                    maxTradesOnSLHit: limitConfig.maxTradesOnSLHit
                  },
                  metrics: res
                });
              }
            }
          }
        }
      }
    }
  }

  // Sort by netProfit then recoveryFactor
  results.sort((a, b) => b.metrics.netProfit - a.metrics.netProfit || b.metrics.recoveryFactor - a.metrics.recoveryFactor);

  const marketResults = results.filter(r => r.params.entryType === 'MARKET');
  const reversionResults = results.filter(r => r.params.entryType === 'REVERSION');
  const fvgResults = results.filter(r => r.params.entryType === 'FVG');

  finalReportMarkdown += `\n## 📈 Optimization for Setup: **${setup.name}**\n`;
  finalReportMarkdown += `### 🏁 Baseline Performance
* **Net Profit:** **₹${baselineResult.netProfit.toLocaleString('en-IN', {maximumFractionDigits:2})}**
* **Win Rate:** **${baselineResult.winRate.toFixed(2)}%**
* **Total Trades:** ${baselineResult.totalTrades}
* **Max Drawdown:** ₹${baselineResult.maxDrawdown.toLocaleString('en-IN', {maximumFractionDigits:2})}
* **Recovery Factor:** **${baselineResult.recoveryFactor.toFixed(2)}**

### 🏆 Top 5 MARKET Parameter Configurations (Ranked by Net Profit)

| Rank | Entry | Range | Target | SL Buffer | Trail to Cost | Trailing SL | Max Trades / SL Capping | Net Profit (₹) | Win Rate (%) | Trades | Max DD (₹) | Recovery Factor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

  for (let i = 0; i < Math.min(5, marketResults.length); i++) {
    const r = marketResults[i];
    const p = r.params;
    const m = r.metrics;
    const limitStr = `Max ${p.maxTradesPerDay} (Max ${p.maxTradesOnSLHit} if SL)`;
    finalReportMarkdown += `| **#${i + 1}** | ${p.entryType} | ${p.openingRangeMinutes}m | ${p.takeProfitValue}x | ${p.stopLossValue} | ${p.trailToCostAtFiftyPercentTarget ? 'Enabled' : 'Disabled'} | ${p.trailingStopLoss || 'Disabled'} | ${limitStr} | **₹${m.netProfit.toLocaleString('en-IN', {maximumFractionDigits:0})}** | ${m.winRate.toFixed(1)}% | ${m.totalTrades} | ₹${m.maxDrawdown.toLocaleString('en-IN', {maximumFractionDigits:0})} | **${m.recoveryFactor.toFixed(2)}** |\n`;
  }

  finalReportMarkdown += `
### 🏆 Top 5 REVERSION Parameter Configurations (Ranked by Net Profit)

| Rank | Entry | Range | Target | SL Buffer | Trail to Cost | Trailing SL | Max Trades / SL Capping | Net Profit (₹) | Win Rate (%) | Trades | Max DD (₹) | Recovery Factor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

  for (let i = 0; i < Math.min(5, reversionResults.length); i++) {
    const r = reversionResults[i];
    const p = r.params;
    const m = r.metrics;
    const limitStr = `Max ${p.maxTradesPerDay} (Max ${p.maxTradesOnSLHit} if SL)`;
    finalReportMarkdown += `| **#${i + 1}** | ${p.entryType} | ${p.openingRangeMinutes}m | ${p.takeProfitValue}x | ${p.stopLossValue} | ${p.trailToCostAtFiftyPercentTarget ? 'Enabled' : 'Disabled'} | ${p.trailingStopLoss || 'Disabled'} | ${limitStr} | **₹${m.netProfit.toLocaleString('en-IN', {maximumFractionDigits:0})}** | ${m.winRate.toFixed(1)}% | ${m.totalTrades} | ₹${m.maxDrawdown.toLocaleString('en-IN', {maximumFractionDigits:0})} | **${m.recoveryFactor.toFixed(2)}** |\n`;
  }

  finalReportMarkdown += `
### 🏆 Top 5 FVG Parameter Configurations (Ranked by Net Profit)

| Rank | Entry | Range | Target | SL Buffer | Trail to Cost | Trailing SL | Max Trades / SL Capping | Net Profit (₹) | Win Rate (%) | Trades | Max DD (₹) | Recovery Factor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

  for (let i = 0; i < Math.min(5, fvgResults.length); i++) {
    const r = fvgResults[i];
    const p = r.params;
    const m = r.metrics;
    const limitStr = `Max ${p.maxTradesPerDay} (Max ${p.maxTradesOnSLHit} if SL)`;
    finalReportMarkdown += `| **#${i + 1}** | ${p.entryType} | ${p.openingRangeMinutes}m | ${p.takeProfitValue}x | ${p.stopLossValue} | ${p.trailToCostAtFiftyPercentTarget ? 'Enabled' : 'Disabled'} | ${p.trailingStopLoss || 'Disabled'} | ${limitStr} | **₹${m.netProfit.toLocaleString('en-IN', {maximumFractionDigits:0})}** | ${m.winRate.toFixed(1)}% | ${m.totalTrades} | ₹${m.maxDrawdown.toLocaleString('en-IN', {maximumFractionDigits:0})} | **${m.recoveryFactor.toFixed(2)}** |\n`;
  }
}

const artifactPath = 'c:/Users/Madhav/.gemini/antigravity-ide/brain/0bc3c4d4-35f2-4e01-bb15-8c163f31497c/optimization_results.md';
fs.writeFileSync(artifactPath, finalReportMarkdown);
console.log(`\nSuccessfully wrote correct optimization report to ${artifactPath}`);
