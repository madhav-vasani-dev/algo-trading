const fs = require('fs');
const path = require('path');

// Load data
const dataPath = 'c:/Users/Madhav/OneDrive/Desktop/trading/public/data/nifty_1min';
const files = fs.readdirSync(dataPath).filter(f => f.endsWith('.json')).sort();
let marketData = [];
for (const file of files) {
  marketData = marketData.concat(JSON.parse(fs.readFileSync(path.join(dataPath, file), 'utf8')));
}

marketData = marketData.map(c => ({
  ...c,
  timestamp: new Date(c.timestamp)
}));

function getISTTime(date) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  return {
    hour: ist.getHours(),
    minute: ist.getMinutes(),
    dateStr: `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`
  };
}

function getFiveMinBlockId(timestamp) {
  const ist = getISTTime(timestamp);
  const blockBase = 9 * 60 + 14;
  const timeMinutes = ist.hour * 60 + ist.minute;
  const minutesSinceBase = timeMinutes - blockBase;
  if (minutesSinceBase < 0) return -1;
  return Math.floor(minutesSinceBase / 5);
}

function getOptionPrice(candle, strike, type, field) {
  const strikeStr = String(strike);
  if (candle.options && candle.options[strikeStr] && candle.options[strikeStr][type]) {
    return candle.options[strikeStr][type][field];
  }
  // Fallback
  if (type === 'CE') {
    return Math.max(0, candle[field] - strike);
  } else {
    let spotVal = candle[field];
    if (field === 'high') spotVal = candle.low;
    else if (field === 'low') spotVal = candle.high;
    return Math.max(0, strike - spotVal);
  }
}

// Emulate runner with asymmetric configuration
function runAsymmetricSimulation(ceLots, peLots) {
  const params = {
    entryType: 'MARKET',
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
    slippagePoints: 1.0,
    brokerageFlat: 250,
    maxTradesPerDay: 3,
    maxTradesOnSLHit: 1
  };

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

  let fiveMinOpen = null;
  let fiveMinHigh = -Infinity;
  let fiveMinLow = Infinity;
  let fiveMinClose = null;
  let prevBlockId = -1;
  let blockStartCandleIndex = -1;

  const parseTimeToMinutes = (timeStr) => {
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  };

  const entryStartMinutes = parseTimeToMinutes(params.entryStartTime);
  const entryEndMinutes = parseTimeToMinutes(params.entryEndTime);
  const squareOffMinutes = parseTimeToMinutes(params.squareOffTime);

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

      fiveMinOpen = null;
      fiveMinHigh = -Infinity;
      fiveMinLow = Infinity;
      fiveMinClose = null;
      prevBlockId = -1;
      blockStartCandleIndex = -1;
    }

    const marketOpenMinutes = 9 * 60 + 15;
    const rangeEndMinutes = marketOpenMinutes + params.openingRangeMinutes;

    const currentBlockId = getFiveMinBlockId(candle.timestamp);
    if (prevBlockId !== currentBlockId) {
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
          // Long: bought CE, sold PE
          const ceExitPrice = ceExitPremium - params.slippagePoints;
          const peExitPrice = peExitPremium + params.slippagePoints; // buying back short PE, slippage added
          
          const cePnl = (ceExitPrice - openPosition.ceEntryPrice) * params.lotSize * ceLots;
          const pePnl = (openPosition.peEntryPrice - peExitPrice) * params.lotSize * peLots; // short PE profit: entry - exit
          tradePnl = cePnl + pePnl - params.brokerageFlat;
        } else {
          // Short: sold CE, bought PE
          const ceExitPrice = ceExitPremium + params.slippagePoints; // buying back short CE, slippage added
          const peExitPrice = peExitPremium - params.slippagePoints;
          
          const cePnl = (openPosition.ceEntryPrice - ceExitPrice) * params.lotSize * ceLots; // short CE profit
          const pePnl = (peExitPrice - openPosition.peEntryPrice) * params.lotSize * peLots; // long PE profit
          tradePnl = cePnl + pePnl - params.brokerageFlat;
        }

        currentCapital += tradePnl;
        openPosition.status = 'CLOSED';
        openPosition.pnl = tradePnl;
        openPosition.exitReason = exitReason;

        if (exitReason === 'Stop Loss') {
          slHitsToday++;
        }

        tradeHistory.push({ ...openPosition });
        openPosition = null;
      }
    }

    // 4. Trigger Entry
    const blockStartMinutes = (9 * 60 + 14) + currentBlockId * 5;
    if (!openPosition && isEndOfBlock && openingRangeSet && blockStartMinutes >= entryStartMinutes && blockStartMinutes < entryEndMinutes) {
      const dailyLimit = (slHitsToday > 0 && params.maxTradesOnSLHit > 0)
        ? params.maxTradesOnSLHit
        : params.maxTradesPerDay;

      if (tradesTakenToday < dailyLimit) {
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
          if (fiveMinClose > openingRangeHigh || fiveMinClose < openingRangeLow) {
            triggerType = fiveMinClose > fiveMinOpen ? 'LONG' : 'SHORT';
          }
        }

        if (triggerType) {
          const blockCandlesCount = i - blockStartCandleIndex + 1;
          const entryCandleIndex = blockStartCandleIndex + Math.min(1, blockCandlesCount - 1);
          const entryCandle = marketData[entryCandleIndex];
          const entryStrike = Math.round(fiveMinClose / 50) * 50;

          const ceEntryPremium = getOptionPrice(entryCandle, entryStrike, 'CE', 'open');
          const peEntryPremium = getOptionPrice(entryCandle, entryStrike, 'PE', 'open');

          let ceEntryPrice = ceEntryPremium;
          let peEntryPrice = peEntryPremium;

          if (triggerType === 'LONG') {
            // Long: buy CE (slippage added), sell PE (slippage subtracted)
            ceEntryPrice += params.slippagePoints;
            peEntryPrice -= params.slippagePoints;
          } else {
            // Short: sell CE (slippage subtracted), buy PE (slippage added)
            ceEntryPrice -= params.slippagePoints;
            peEntryPrice += params.slippagePoints;
          }

          let stopLossPrice = triggerType === 'LONG' ? (fiveMinLow - params.stopLossValue) : (fiveMinHigh + params.stopLossValue);
          const slDistance = Math.abs(entryCandle.open - stopLossPrice);
          let targetPrice = triggerType === 'LONG' ? entryCandle.open + (2 * slDistance) : entryCandle.open - (2 * slDistance);

          openPosition = {
            entryTime: entryCandle.timestamp,
            type: triggerType,
            status: 'OPEN',
            entrySpot: entryCandle.open,
            stopLossPrice: stopLossPrice,
            targetPrice: targetPrice,
            strikePrice: entryStrike,
            ceEntryPrice,
            peEntryPrice
          };

          tradesTakenToday++;

          // Retroactive monitoring
          for (let j = entryCandleIndex; j <= i; j++) {
            const checkCandle = marketData[j];
            const checkIst = getISTTime(checkCandle.timestamp);
            const checkMinutes = checkIst.hour * 60 + checkIst.minute;

            let shouldExit = false;
            let exitSpotPrice = checkCandle.close;
            let exitReason = '';

            if (openPosition.type === 'LONG' && checkCandle.high > openPosition.targetPrice) {
              shouldExit = true;
              exitSpotPrice = openPosition.targetPrice;
              exitReason = 'Target';
            } else if (openPosition.type === 'SHORT' && checkCandle.low < openPosition.targetPrice) {
              shouldExit = true;
              exitSpotPrice = openPosition.targetPrice;
              exitReason = 'Target';
            }

            if (!shouldExit) {
              if (openPosition.type === 'LONG' && checkCandle.low < openPosition.stopLossPrice) {
                shouldExit = true;
                exitSpotPrice = openPosition.stopLossPrice;
                exitReason = 'Stop Loss';
              } else if (openPosition.type === 'SHORT' && checkCandle.high > openPosition.stopLossPrice) {
                shouldExit = true;
                exitSpotPrice = openPosition.stopLossPrice;
                exitReason = 'Stop Loss';
              }
            }

            if (!shouldExit && checkMinutes >= squareOffMinutes) {
              shouldExit = true;
              exitSpotPrice = checkCandle.close;
              exitReason = 'Square-off';
            }

            if (shouldExit) {
              let tradePnl = 0;
              let ceExitField = 'close';
              let peExitField = 'close';

              if (exitReason === 'Target') {
                ceExitField = openPosition.type === 'LONG' ? 'high' : 'low';
                peExitField = openPosition.type === 'LONG' ? 'low' : 'high';
              } else if (exitReason === 'Stop Loss') {
                ceExitField = openPosition.type === 'LONG' ? 'low' : 'high';
                peExitField = openPosition.type === 'LONG' ? 'high' : 'low';
              }

              const ceExitPremium = getOptionPrice(checkCandle, openPosition.strikePrice, 'CE', ceExitField);
              const peExitPremium = getOptionPrice(checkCandle, openPosition.strikePrice, 'PE', peExitField);

              if (openPosition.type === 'LONG') {
                const ceExitPrice = ceExitPremium - params.slippagePoints;
                const peExitPrice = peExitPremium + params.slippagePoints;
                
                const cePnl = (ceExitPrice - openPosition.ceEntryPrice) * params.lotSize * ceLots;
                const pePnl = (openPosition.peEntryPrice - peExitPrice) * params.lotSize * peLots;
                tradePnl = cePnl + pePnl - params.brokerageFlat;
              } else {
                const ceExitPrice = ceExitPremium + params.slippagePoints;
                const peExitPrice = peExitPremium - params.slippagePoints;
                
                const cePnl = (openPosition.ceEntryPrice - ceExitPrice) * params.lotSize * ceLots;
                const pePnl = (peExitPrice - openPosition.peEntryPrice) * params.lotSize * peLots;
                tradePnl = cePnl + pePnl - params.brokerageFlat;
              }

              currentCapital += tradePnl;
              openPosition.status = 'CLOSED';
              openPosition.pnl = tradePnl;
              openPosition.exitReason = exitReason;

              if (exitReason === 'Stop Loss') {
                slHitsToday++;
              }

              tradeHistory.push({ ...openPosition });
              openPosition = null;
              break;
            }
          }
        }
      }
    }

    // Equity track
    let currentEquity = currentCapital;
    if (openPosition) {
      const cePrice = getOptionPrice(candle, openPosition.strikePrice, 'CE', 'close');
      const pePrice = getOptionPrice(candle, openPosition.strikePrice, 'PE', 'close');
      let openPnl = 0;

      if (openPosition.type === 'LONG') {
        const cePnl = (cePrice - openPosition.ceEntryPrice) * params.lotSize * ceLots;
        const pePnl = (openPosition.peEntryPrice - pePrice) * params.lotSize * peLots;
        openPnl = cePnl + pePnl - params.brokerageFlat;
      } else {
        const cePnl = (openPosition.ceEntryPrice - cePrice) * params.lotSize * ceLots;
        const pePnl = (pePrice - openPosition.peEntryPrice) * params.lotSize * peLots;
        openPnl = cePnl + pePnl - params.brokerageFlat;
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

console.log('Comparing Asymmetric Configurations:');
console.log('-------------------------------------');

// Baseline: 1 lot Call, 0 lot Put (simple options buy CE/PE as executed in Angular code)
console.log('1. Baseline Strategy (Buy 1 Call only for LONG, Buy 1 Put only for SHORT):');
const resBase = runAsymmetricSimulation(1, 0);
console.log(JSON.stringify(resBase, null, 2));

// 2. Synthetic Future: 1 lot Call, 1 lot Put (Buy CE + Sell PE for LONG, Sell CE + Buy PE for SHORT)
console.log('\n2. Synthetic Futures (Buy 1 CE + Sell 1 PE for LONG, Sell 1 CE + Buy 1 PE for SHORT):');
const resSynth = runAsymmetricSimulation(1, 1);
console.log(JSON.stringify(resSynth, null, 2));

// 3. User Idea: Buy 2 Call + Sell 1 Put for LONG, Sell 1 Call + Buy 2 Put for SHORT
console.log('\n3. Asymmetric Setup (Buy 2 CE + Sell 1 PE for LONG, Sell 1 CE + Buy 2 PE for SHORT):');
const resAsymm = runAsymmetricSimulation(2, 1);
console.log(JSON.stringify(resAsymm, null, 2));

// 4. Strong Asymmetric Setup (Buy 2 CE + Sell 0 PE for LONG)
console.log('\n4. Double Buy (Buy 2 CE + Sell 0 PE for LONG, Sell 0 CE + Buy 2 PE for SHORT):');
const resDouble = runAsymmetricSimulation(2, 0);
console.log(JSON.stringify(resDouble, null, 2));
