const fs = require('fs');
const path = require('path');

// Load all monthly json files from public/data/nifty_1min
const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
const files = fs.readdirSync(dataDir)
  .filter(f => f.endsWith('.json') && f >= '2025-12.json' && f <= '2026-05.json')
  .sort();

let marketData = [];
for (const file of files) {
  const filePath = path.join(dataDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  marketData = marketData.concat(data);
}

// Convert timestamps to dates and parse
marketData = marketData.map(c => ({
  ...c,
  timestamp: new Date(c.timestamp)
})).filter(c => {
  const dateStr = c.timestamp.toISOString().split('T')[0];
  return dateStr <= '2026-05-19';
});

// Strategy Service Mock
const strategyService = {
  getISTTime(date) {
    const estDate = new Date(date.getTime());
    const utc = estDate.getTime() + (estDate.getTimezoneOffset() * 60000);
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
};

const params = {
  entryType: 'MARKET',
  openingRangeMinutes: 15,
  direction: 'BOTH',
  stopLossType: 'ENTRY_CANDLE',
  stopLossValue: 0.0,
  takeProfitType: 'SL_MULTIPLE',
  takeProfitValue: 3.0,
  entryStartTime: '09:30',
  entryEndTime: '15:30', // Aligned with Python (no strict 14:30 exit window limit)
  squareOffTime: '15:15',
  lotSize: 75,
  numberOfLots: 1,
  slippagePoints: 0.0,
  brokerageFlat: 0.0
};

function getFiveMinBlockId(timestamp) {
  const ist = strategyService.getISTTime(timestamp);
  const blockBase = 9 * 60 + 14;
  const timeMinutes = ist.hour * 60 + ist.minute;
  const minutesSinceBase = timeMinutes - blockBase;
  if (minutesSinceBase < 0) return -1;
  return Math.floor(minutesSinceBase / 5);
}

function runBacktest() {
  let currentCapital = 100000;
  let tradeHistory = [];
  let openPosition = null;

  let currentDayStr = '';
  let openingRangeHigh = -Infinity;
  let openingRangeLow = Infinity;
  let openingRangeSet = false;
  let tradesTakenToday = 0;

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
    const ist = strategyService.getISTTime(candle.timestamp);

    if (ist.dateStr !== currentDayStr) {
      currentDayStr = ist.dateStr;
      openingRangeHigh = -Infinity;
      openingRangeLow = Infinity;
      openingRangeSet = false;
      tradesTakenToday = 0;

      fiveMinOpen = null;
      fiveMinHigh = -Infinity;
      fiveMinLow = Infinity;
      fiveMinClose = null;
      prevBlockId = -1;
      blockStartCandleIndex = -1;
    }

    const timeMinutes = ist.hour * 60 + ist.minute;
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
      const nextIst = strategyService.getISTTime(nextCandle.timestamp);
      if (nextIst.dateStr !== ist.dateStr) {
        isNewDayNext = true;
      }
    }
    const isEndOfBlock = (currentBlockId !== nextBlockId) || isNewDayNext || (i === marketData.length - 1);

    // 2. Establish Opening Range
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
        if (openPosition.type === 'LONG') {
          tradePnl = (exitSpotPrice - openPosition.entryPrice) * openPosition.quantity;
        } else {
          tradePnl = (openPosition.entryPrice - exitSpotPrice) * openPosition.quantity;
        }

        currentCapital += tradePnl;
        openPosition.exitTime = candle.timestamp;
        openPosition.exitPrice = exitSpotPrice;
        openPosition.status = 'CLOSED';
        openPosition.pnl = tradePnl;
        openPosition.exitReason = exitReason;

        tradeHistory.push({ ...openPosition });
        openPosition = null;
      }
    }

    // 4. Trigger Entry
    const blockStartMinutes = (9 * 60 + 14) + currentBlockId * 5;
    if (!openPosition && isEndOfBlock && openingRangeSet && blockStartMinutes >= entryStartMinutes && blockStartMinutes < entryEndMinutes) {
      if (tradesTakenToday === 0) {
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
          // Check if breakout occurred
          if (fiveMinClose > openingRangeHigh || fiveMinClose < openingRangeLow) {
            // Trade direction is based entirely on the breakout candle's color (Green -> LONG, Red -> SHORT)
            triggerType = fiveMinClose > fiveMinOpen ? 'LONG' : 'SHORT';
          }
        }

        if (triggerType) {
          const quantity = 75;
          const blockCandlesCount = i - blockStartCandleIndex + 1;
          const entryCandleIndex = blockStartCandleIndex + Math.min(1, blockCandlesCount - 1);
          const entryCandle = marketData[entryCandleIndex];

          const entryPrice = entryCandle.open;
          
          let stopLossPrice = 0;
          if (triggerType === 'LONG') {
            stopLossPrice = fiveMinLow;
          } else {
            stopLossPrice = fiveMinHigh;
          }

          const slDistance = Math.abs(entryPrice - stopLossPrice);
          const lossGap = triggerType === 'LONG' ? (entryPrice - stopLossPrice) : (stopLossPrice - entryPrice);
          
          let targetPrice = 0;
          if (triggerType === 'LONG') {
            targetPrice = entryPrice + (3.0 * lossGap);
          } else {
            targetPrice = entryPrice - (3.0 * lossGap);
          }

          openPosition = {
            entryTime: entryCandle.timestamp,
            entryPrice: entryPrice,
            type: triggerType,
            quantity: quantity,
            status: 'OPEN',
            entrySpot: entryPrice,
            stopLossPrice: stopLossPrice,
            targetPrice: targetPrice,
            strikePrice: Math.round(fiveMinClose / 50) * 50
          };

          tradesTakenToday++;

          // Retroactively check for exits on the candles within this block (from entry index to current index i)
          for (let j = entryCandleIndex; j <= i; j++) {
            const checkCandle = marketData[j];
            const checkIst = strategyService.getISTTime(checkCandle.timestamp);
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
              if (openPosition.type === 'LONG') {
                tradePnl = (exitSpotPrice - openPosition.entryPrice) * openPosition.quantity;
              } else {
                tradePnl = (openPosition.entryPrice - exitSpotPrice) * openPosition.quantity;
              }

              currentCapital += tradePnl;
              openPosition.exitTime = checkCandle.timestamp;
              openPosition.exitPrice = exitSpotPrice;
              openPosition.status = 'CLOSED';
              openPosition.pnl = tradePnl;
              openPosition.exitReason = exitReason;

              tradeHistory.push({ ...openPosition });
              openPosition = null;
              break;
            }
          }
        }
      }
    }
  }

  console.log(`TS Total Trades: ${tradeHistory.length}`);
  fs.writeFileSync(path.join(__dirname, 'ts_trades.json'), JSON.stringify(tradeHistory.map(t => ({
    Date: t.entryTime.toISOString().split('T')[0],
    EntryTime: t.entryTime.toTimeString().split(' ')[0],
    ExitTime: t.exitTime ? t.exitTime.toTimeString().split(' ')[0] : undefined,
    Type: t.type,
    EntryPrice: t.entryPrice,
    ExitPrice: t.exitPrice,
    ExitReason: t.exitReason,
    PnL: t.pnl / t.quantity
  })), null, 2));
}

runBacktest();
