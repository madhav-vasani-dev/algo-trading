import { Injectable } from '@angular/core';
import { 
  BacktestConfig, 
  Candle, 
  TradePosition, 
  BacktestMetrics, 
  BacktestResult, 
  TradeSignal,
  ORBParams
} from '../models/backtest.models';
import { StrategyLogicService } from './strategy.service';

@Injectable({
  providedIn: 'root'
})
export class BacktestRunnerService {

  constructor(private strategyService: StrategyLogicService) { }

  /**
   * Core Engine Loop. Simulates the passage of time over historical data.
   */
  public runBacktest(config: BacktestConfig, marketData: Candle[]): BacktestResult {
    if (config.strategyId === 'ORB') {
      return this.runORBSimulation(config, marketData);
    }
    
    console.log(`[BacktestRunner] Starting simulation with ${marketData.length} candles.`);

    let currentCapital = config.initialCapital;
    let equityCurve: { time: Date, equity: number }[] = [];
    let tradeHistory: TradePosition[] = [];
    
    // State of the current open trade (assuming strategy only holds 1 position at a time for simplicity)
    let openPosition: TradePosition | null = null;
    let maxEquity = currentCapital;
    let maxDrawdownValue = 0;

    // We start from the beginning of the array. Over time, 'history' grows.
    for (let i = 0; i < marketData.length; i++) {
        const currentCandle = marketData[i];
        const historicalSlice = marketData.slice(0, i + 1);

        // 1. Evaluate Strategy for the current candle
        let signal: TradeSignal = { type: 'HOLD', price: 0, reason: '' };
        
        if (config.strategyId === 'MACross') {
           signal = this.strategyService.evaluateMovingAverageCrossover(
             currentCandle, 
             historicalSlice, 
             config.strategyParams || { shortWindow: 9, longWindow: 21 }
           );
        }

        // 2. Execute Trading Logic based on Signal
        if (signal.type === 'BUY' && !openPosition) {
           // Execute Buy Order (Enter Long)
           const executionPrice = this.applySlippage(currentCandle.close, 'BUY', config.slippagePercent);
           const cost = config.brokeragePerOrder || 0;
           
           // Calculate how many shares we can buy
           const quantity = Math.floor((currentCapital - cost) / executionPrice);
           
           if (quantity > 0) {
              const investment = (quantity * executionPrice) + cost;
              currentCapital -= investment;
              
              openPosition = {
                  entryTime: currentCandle.timestamp,
                  entryPrice: executionPrice,
                  type: 'LONG',
                  quantity: quantity,
                  status: 'OPEN'
              };
           }
        } 
        else if (signal.type === 'SELL' && openPosition && openPosition.type === 'LONG') {
           // Execute Sell Order (Close Long)
           const executionPrice = this.applySlippage(currentCandle.close, 'SELL', config.slippagePercent);
           const cost = config.brokeragePerOrder || 0;
           
           const revenue = (openPosition.quantity * executionPrice) - cost;
           currentCapital += revenue;
           
           // Calculate Trade P&L
           const totalCost = (openPosition.quantity * openPosition.entryPrice); // Ignoring entry brokerage here for simplicity of P&L display
           const tradePnl = revenue - totalCost;

           openPosition.exitTime = currentCandle.timestamp;
           openPosition.exitPrice = executionPrice;
           openPosition.status = 'CLOSED';
           openPosition.pnl = tradePnl;
           
           tradeHistory.push({ ...openPosition });
           openPosition = null;
        }

        // 3. Mark to Market (Calculate daily equity for the curve and drawdown)
        let currentEquity = currentCapital;
        if (openPosition) {
            currentEquity += (openPosition.quantity * currentCandle.close);
        }
        
        equityCurve.push({ time: currentCandle.timestamp, equity: currentEquity });

        // Update Max Drawdown tracker
        if (currentEquity > maxEquity) {
            maxEquity = currentEquity;
        }
        const drawdown = maxEquity - currentEquity;
        if (drawdown > maxDrawdownValue) {
            maxDrawdownValue = drawdown;
        }
    }

    // Force close any open positions at the very end of the backtest
    if (openPosition) {
        const lastCandle = marketData[marketData.length - 1];
        const executionPrice = lastCandle.close; // No slippage on forced exit
        const revenue = (openPosition.quantity * executionPrice) - (config.brokeragePerOrder || 0);
        currentCapital += revenue;
        
        const totalCost = (openPosition.quantity * openPosition.entryPrice);
        openPosition.exitTime = lastCandle.timestamp;
        openPosition.exitPrice = executionPrice;
        openPosition.status = 'CLOSED';
        openPosition.pnl = revenue - totalCost;
        tradeHistory.push({ ...openPosition });
    }

    // Calculate Final Metrics
    const winningTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0);
    const losingTrades = tradeHistory.filter(t => t.pnl && t.pnl <= 0);
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLoss = losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl || 0), 0);

    const metrics: BacktestMetrics = {
        totalTrades: tradeHistory.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: tradeHistory.length > 0 ? (winningTrades.length / tradeHistory.length) * 100 : 0,
        grossProfit,
        grossLoss,
        netProfit: currentCapital - config.initialCapital,
        maxDrawdown: maxDrawdownValue,
        maxDrawdownPercent: (maxDrawdownValue / config.initialCapital) * 100, // Roughly speaking
        finalCapital: currentCapital
    };

    console.log('[BacktestRunner] Simulation Complete.', metrics);

    return {
        config,
        metrics,
        trades: tradeHistory,
        equityCurve
    };
  }

  private getFiveMinBlockId(timestamp: Date): number {
    const ist = this.strategyService.getISTTime(new Date(timestamp));
    // Base at 09:15 to align strictly with standard 5-minute boundaries starting at 09:15.
    // This produces blocks: [09:15-09:19], [09:20-09:24], [09:25-09:29]...
    const blockBase = 9 * 60 + 15;
    const timeMinutes = ist.hour * 60 + ist.minute;
    const minutesSinceBase = timeMinutes - blockBase;
    if (minutesSinceBase < 0) return -1;
    return Math.floor(minutesSinceBase / 5);
  }

  /**
   * Specialized Opening Range Breakout (ORB) Simulation Engine
   */
  private runORBSimulation(config: BacktestConfig, marketData: Candle[]): BacktestResult {
    const params = config.strategyParams as ORBParams;
    let currentCapital = config.initialCapital;
    const lotSize = params.lotSize || 75;
    const globalLots = params.numberOfLots || 1;
    const longLotsVal = params.longOptionLots !== undefined ? params.longOptionLots : 1;
    const shortLotsVal = params.shortOptionLots !== undefined ? params.shortOptionLots : 0;
    const finalLongLots = Math.max(1, longLotsVal * globalLots);
    const finalShortLots = shortLotsVal * globalLots;

    let equityCurve: { time: Date, equity: number }[] = [];
    let tradeHistory: TradePosition[] = [];

    let openPosition: (TradePosition & {
      entrySpot: number;
      stopLossPrice: number;
      targetPrice: number;
      peakSpot?: number;
      troughSpot?: number;
    }) | null = null;

    let maxEquity = currentCapital;
    let maxDrawdownValue = 0;

    // Daily tracker state
    let currentDayStr = '';
    let openingRangeHigh = -Infinity;
    let openingRangeLow = Infinity;
    let openingRangeSet = false;
    let tradesTakenToday = 0;
    let slHitsToday = 0;
    let canTriggerBreakout = true;
    let pendingLimitPrice: number | null = null;
    let pendingLimitType: 'LONG' | 'SHORT' | null = null;
    let pendingLimitStrike: number | null = null;
    let breakoutFiveMinLow = -Infinity;
    let breakoutFiveMinHigh = Infinity;

    // 5-minute candle tracking state
    let fiveMinOpen: number | null = null;
    let fiveMinHigh = -Infinity;
    let fiveMinLow = Infinity;
    let fiveMinClose: number | null = null;
    let prevBlockId = -1;
    let blockStartCandleIndex = -1;

    // FVG (Fair Value Gap) entry state machine variables
    // prevCompletedBlock: rolling reference to the last CLOSED 5-min block (candle[n-2] at breakout time)
    let prevCompletedBlock: { open: number; high: number; low: number; close: number } | null = null;
    let fvgState: 'IDLE' | 'WAIT_NEXT_BLOCK' | 'WAIT_PULLBACK' = 'IDLE';
    let fvgDirection: 'LONG' | 'SHORT' | null = null;
    let fvgZoneLow = 0;   // lower bound of the confirmed FVG gap
    let fvgZoneHigh = 0;  // upper bound of the confirmed FVG gap
    // candle[n-2]: the block before the breakout block — stored at breakout detection
    let fvgCandleN2: { open: number; high: number; low: number; close: number } | null = null;

    // Time parser helper e.g. "09:30" -> 570
    const parseTimeToMinutes = (timeStr: string): number => {
      const parts = timeStr.split(':');
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    };

    const entryStartMinutes = parseTimeToMinutes(params.entryStartTime || '09:30');
    const entryEndMinutes = parseTimeToMinutes(params.entryEndTime || '14:30');
    const squareOffMinutes = parseTimeToMinutes(params.squareOffTime || '15:15');

    // Default tradeType to SPOT
    const tradeType = params.tradeType || 'SPOT';

    for (let i = 0; i < marketData.length; i++) {
      const candle = marketData[i];
      const ist = this.strategyService.getISTTime(candle.timestamp);

      // 1. Check if new day starts
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

        // Reset 5-minute candle state
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

      const timeMinutes = ist.hour * 60 + ist.minute;
      const marketOpenMinutes = 9 * 60 + 15; // 09:15 AM
      // Aligns strictly with standard chart range (e.g. 09:15-09:29 inclusive for 15-minute range)
      const rangeEndMinutes = marketOpenMinutes + params.openingRangeMinutes;

      const currentBlockId = this.getFiveMinBlockId(candle.timestamp);
      if (prevBlockId !== currentBlockId) {
        // Save the just-completed block to prevCompletedBlock BEFORE resetting (used for FVG candle[n-2] tracking)
        if (prevBlockId !== -1 && fiveMinClose !== null) {
          prevCompletedBlock = { open: fiveMinOpen!, high: fiveMinHigh, low: fiveMinLow, close: fiveMinClose };
        }
        fiveMinOpen = candle.open;
        fiveMinHigh = candle.high;
        fiveMinLow = candle.low;
        fiveMinClose = candle.close;
        prevBlockId = currentBlockId;
        blockStartCandleIndex = i;
      } else {
        fiveMinHigh = Math.max(fiveMinHigh!, candle.high);
        fiveMinLow = Math.min(fiveMinLow!, candle.low);
        fiveMinClose = candle.close;
      }

      const nextCandle = marketData[i + 1];
      const nextBlockId = nextCandle ? this.getFiveMinBlockId(nextCandle.timestamp) : -1;
      let isNewDayNext = false;
      if (nextCandle) {
        const nextIst = this.strategyService.getISTTime(nextCandle.timestamp);
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
        if (!openingRangeSet) {
          console.log(`[ORB Debug] [${ist.dateStr}] Opening Range established: High = ${openingRangeHigh.toFixed(2)}, Low = ${openingRangeLow.toFixed(2)}`);
        }
        openingRangeSet = true;
      }

      // 3. Monitor Active Position (runs on every 1-minute candle for realistic exits)
      if (openPosition) {
        // Trailing Stop Loss Logic
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

        // Fifty-Percent Target Cost-to-Cost Trailing Logic
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

        // Check Target
        if (openPosition.type === 'LONG' && candle.high > openPosition.targetPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.targetPrice;
          exitReason = 'Target';
        } else if (openPosition.type === 'SHORT' && candle.low < openPosition.targetPrice) {
          shouldExit = true;
          exitSpotPrice = openPosition.targetPrice;
          exitReason = 'Target';
        }

        // Check Stop Loss
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

        // Check Square-off Time
        if (!shouldExit && timeMinutes >= squareOffMinutes) {
          shouldExit = true;
          exitSpotPrice = candle.close;
          exitReason = 'Square-off';
        }

        if (shouldExit) {
          let tradePnl = 0;
          let exitPrice = exitSpotPrice;

          const rawCandle = candle as any;
          const hasOptions = rawCandle.options !== undefined || rawCandle.atmStrike !== undefined;

          let ceExitPrice = 0;
          let peExitPrice = 0;

          if (tradeType === 'OPTIONS' && hasOptions) {
            let ceExitField: 'open' | 'high' | 'low' | 'close' = 'close';
            let peExitField: 'open' | 'high' | 'low' | 'close' = 'close';

            if (exitReason === 'Target') {
              ceExitField = openPosition.type === 'LONG' ? 'high' : 'low';
              peExitField = openPosition.type === 'LONG' ? 'low' : 'high';
            } else if (exitReason === 'Stop Loss') {
              ceExitField = openPosition.type === 'LONG' ? 'low' : 'high';
              peExitField = openPosition.type === 'LONG' ? 'high' : 'low';
            }

            const ceExitPremium = this.getOptionPrice(candle, openPosition.strikePrice!, 'CE', ceExitField);
            const peExitPremium = this.getOptionPrice(candle, openPosition.strikePrice!, 'PE', peExitField);

            if (openPosition.type === 'LONG') {
              ceExitPrice = ceExitPremium - params.slippagePoints;
              peExitPrice = peExitPremium + params.slippagePoints;
              const cePnl = (ceExitPrice - openPosition.ceEntryPrice!) * lotSize * finalLongLots;
              const pePnl = (openPosition.peEntryPrice! - peExitPrice) * lotSize * finalShortLots;
              tradePnl = cePnl + pePnl - params.brokerageFlat;
              exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
            } else {
              ceExitPrice = ceExitPremium + params.slippagePoints;
              peExitPrice = peExitPremium - params.slippagePoints;
              const cePnl = (openPosition.ceEntryPrice! - ceExitPrice) * lotSize * finalShortLots;
              const pePnl = (peExitPrice - openPosition.peEntryPrice!) * lotSize * finalLongLots;
              tradePnl = cePnl + pePnl - params.brokerageFlat;
              exitPrice = peExitPrice - ceExitPrice * (finalShortLots / finalLongLots);
            }
          } else {
            // Spot index trading mode
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

          (openPosition as any).exitReason = exitReason;
          (openPosition as any).exitSpot = exitSpotPrice;

          console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] EXIT: ${openPosition.type} closed. Reason: ${exitReason}. Exit Spot: ${exitSpotPrice.toFixed(2)}, Exit Price: ${exitPrice.toFixed(2)}, Exit PnL: ₹${tradePnl.toFixed(2)} (CE Exit: ${ceExitPrice.toFixed(2)}, PE Exit: ${peExitPrice.toFixed(2)}). Current Capital: ₹${currentCapital.toFixed(2)}`);

          if (exitReason === 'Stop Loss') {
            slHitsToday++;
          }

          tradeHistory.push({ ...openPosition });
          openPosition = null;
        }
      }

      // 3.5 Monitor Pending Limit Order (if any)
      if (!openPosition && pendingLimitPrice !== null) {
        let filled = false;
        const currentSpot = pendingLimitPrice; // enter at the limit price!

        if (pendingLimitType === 'LONG') {
          if (candle.low <= pendingLimitPrice) {
            filled = true;
          }
        } else if (pendingLimitType === 'SHORT') {
          if (candle.high >= pendingLimitPrice) {
            filled = true;
          }
        }

        if (filled) {
          const quantity = lotSize * finalLongLots;
          const entryStrike = pendingLimitStrike!;
          
          let entryPrice = currentSpot;
          const rawCandle = candle as any;
          const hasOptions = rawCandle.options !== undefined || rawCandle.atmStrike !== undefined;

          let ceEntryPrice = 0;
          let peEntryPrice = 0;

          if (tradeType === 'OPTIONS' && hasOptions) {
            const ceEntryPremium = this.getOptionPrice(candle, entryStrike, 'CE', 'open');
            const peEntryPremium = this.getOptionPrice(candle, entryStrike, 'PE', 'open');

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
            if (pendingLimitType === 'LONG') {
              entryPrice += params.slippagePoints;
            } else {
              entryPrice -= params.slippagePoints;
            }
          }

          // Calculate Stop Loss using spot entry price (currentSpot)
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

          // Calculate Target using spot entry price (currentSpot)
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
            type: pendingLimitType!,
            quantity: quantity,
            status: 'OPEN',
            entrySpot: currentSpot,
            stopLossPrice: stopLossPrice,
            targetPrice: targetPrice,
            strikePrice: entryStrike,
            ceEntryPrice: ceEntryPrice,
            peEntryPrice: peEntryPrice,
            longOptionLots: finalLongLots,
            shortOptionLots: finalShortLots
          };

          console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] ENTRY (RETEST): ${openPosition.type} triggered. Limit Spot: ${currentSpot.toFixed(2)}, Target: ${targetPrice.toFixed(2)}, SL: ${stopLossPrice.toFixed(2)}. Option Legs -> Strike: ${entryStrike}, CE Entry Price: ${ceEntryPrice.toFixed(2)}, PE Entry Price: ${peEntryPrice.toFixed(2)}`);

          pendingLimitPrice = null;
          pendingLimitType = null;
          pendingLimitStrike = null;
          tradesTakenToday++;

          // Immediately check if the newly opened trade exits on this same candle
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
            let ceExitPrice = 0;
            let peExitPrice = 0;

            if (tradeType === 'OPTIONS' && hasOptions) {
              let ceExitField: 'open' | 'high' | 'low' | 'close' = 'close';
              let peExitField: 'open' | 'high' | 'low' | 'close' = 'close';

              if (exitReason === 'Target') {
                ceExitField = openPosition.type === 'LONG' ? 'high' : 'low';
                peExitField = openPosition.type === 'LONG' ? 'low' : 'high';
              } else if (exitReason === 'Stop Loss') {
                ceExitField = openPosition.type === 'LONG' ? 'low' : 'high';
                peExitField = openPosition.type === 'LONG' ? 'high' : 'low';
              }

              const ceExitPremium = this.getOptionPrice(candle, openPosition.strikePrice!, 'CE', ceExitField);
              const peExitPremium = this.getOptionPrice(candle, openPosition.strikePrice!, 'PE', peExitField);

              if (openPosition.type === 'LONG') {
                ceExitPrice = ceExitPremium - params.slippagePoints;
                peExitPrice = peExitPremium + params.slippagePoints;
                const cePnl = (ceExitPrice - openPosition.ceEntryPrice!) * lotSize * finalLongLots;
                const pePnl = (openPosition.peEntryPrice! - peExitPrice) * lotSize * finalShortLots;
                tradePnl = cePnl + pePnl - params.brokerageFlat;
                exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
              } else {
                ceExitPrice = ceExitPremium + params.slippagePoints;
                peExitPrice = peExitPremium - params.slippagePoints;
                const cePnl = (openPosition.ceEntryPrice! - ceExitPrice) * lotSize * finalShortLots;
                const pePnl = (peExitPrice - openPosition.peEntryPrice!) * lotSize * finalLongLots;
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
            openPosition.ceExitPrice = ceExitPrice;
            openPosition.peExitPrice = peExitPrice;
            (openPosition as any).exitReason = exitReason;
            (openPosition as any).exitSpot = exitSpotPrice;

            console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] EXIT: ${openPosition.type} closed. Reason: ${exitReason}. Exit Spot: ${exitSpotPrice.toFixed(2)}, Exit Price: ${exitPrice.toFixed(2)}, Exit PnL: ₹${tradePnl.toFixed(2)} (CE Exit: ${ceExitPrice.toFixed(2)}, PE Exit: ${peExitPrice.toFixed(2)}). Current Capital: ₹${currentCapital.toFixed(2)}`);

            if (exitReason === 'Stop Loss') {
              slHitsToday++;
            }

            tradeHistory.push({ ...openPosition });
            openPosition = null;
          }
        } else {
          // Check for failure/cancellation
          let cancel = false;
          if (pendingLimitType === 'LONG') {
            if (candle.close < openingRangeHigh) {
              cancel = true;
            }
          } else if (pendingLimitType === 'SHORT') {
            if (candle.close > openingRangeLow) {
              cancel = true;
            }
          }

          if (cancel) {
            console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] RETEST limit order cancelled: Price closed inside range (Close: ${candle.close.toFixed(2)}, Range: ${openingRangeLow.toFixed(2)} - ${openingRangeHigh.toFixed(2)}).`);
            pendingLimitPrice = null;
            pendingLimitType = null;
            pendingLimitStrike = null;
            canTriggerBreakout = true;
          }
        }
      }      // Check if price re-entered range (must be checked on block close when not in a trade)
      if (isEndOfBlock && openingRangeSet) {
        if (!openPosition && !canTriggerBreakout && fiveMinClose !== null && fiveMinClose >= openingRangeLow && fiveMinClose <= openingRangeHigh) {
          canTriggerBreakout = true;
          console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Price re-entered the range (Close: ${fiveMinClose.toFixed(2)}, Range: ${openingRangeLow.toFixed(2)} - ${openingRangeHigh.toFixed(2)}). Breakout trigger re-enabled.`);
        }
      }

      // ── FVG State Machine: block-close transitions ──────────────────────────
      // Runs AFTER the range re-entry check, BEFORE the normal breakout detection.
      // Handles: WAIT_NEXT_BLOCK → WAIT_PULLBACK (zone confirmation) and
      //          WAIT_PULLBACK → entry (confirmation candle) or IDLE (cancellation).
      if (params.entryType === 'FVG' && isEndOfBlock && openingRangeSet && !openPosition) {

        // Cancellation rule: if price closes back inside ORB range, reset FVG setup.
        if (fvgState !== 'IDLE' && fiveMinClose! >= openingRangeLow && fiveMinClose! <= openingRangeHigh) {
          console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] FVG setup CANCELLED — price closed back inside ORB range (Close: ${fiveMinClose!.toFixed(2)}, Range: ${openingRangeLow.toFixed(2)}-${openingRangeHigh.toFixed(2)}).`);
          fvgState = 'IDLE';
          fvgCandleN2 = null;
          canTriggerBreakout = true;
        }

        // WAIT_NEXT_BLOCK → WAIT_PULLBACK: the block after the breakout just closed.
        // Now we can compute the FVG zone: gap between candle[n-2] and candle[n].
        else if (fvgState === 'WAIT_NEXT_BLOCK') {
          if (fvgCandleN2 === null) {
            // No historical block available (breakout on first block after range) — FVG invalid.
            console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] No candle[n-2] available. FVG invalid — resetting.`);
            fvgState = 'IDLE';
          } else if (fvgDirection === 'LONG') {
            // Bullish FVG gap: candle[n-2].high  ↔  candle[n].low
            // For a valid gap: candle[n].low must be strictly above candle[n-2].high
            if (fiveMinLow > fvgCandleN2.high) {
              fvgZoneLow = fvgCandleN2.high;
              fvgZoneHigh = fiveMinLow;
              fvgState = 'WAIT_PULLBACK';
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Bullish FVG zone confirmed: ${fvgZoneLow.toFixed(2)} – ${fvgZoneHigh.toFixed(2)}. Waiting for pullback + bullish confirmation candle.`);
            } else {
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] No bullish gap (n2.high=${fvgCandleN2.high.toFixed(2)}, n.low=${fiveMinLow.toFixed(2)}). FVG invalid.`);
              fvgState = 'IDLE';
              fvgCandleN2 = null;
            }
          } else if (fvgDirection === 'SHORT') {
            // Bearish FVG gap: candle[n].high  ↔  candle[n-2].low
            // For a valid gap: candle[n].high must be strictly below candle[n-2].low
            if (fvgCandleN2.low > fiveMinHigh) {
              fvgZoneLow = fiveMinHigh;
              fvgZoneHigh = fvgCandleN2.low;
              fvgState = 'WAIT_PULLBACK';
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Bearish FVG zone confirmed: ${fvgZoneLow.toFixed(2)} – ${fvgZoneHigh.toFixed(2)}. Waiting for pullback + bearish confirmation candle.`);
            } else {
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] No bearish gap (n.high=${fiveMinHigh.toFixed(2)}, n2.low=${fvgCandleN2.low.toFixed(2)}). FVG invalid.`);
              fvgState = 'IDLE';
              fvgCandleN2 = null;
            }
          }
        }

        // WAIT_PULLBACK: check if this 5-min block is the confirmation candle.
        // Conditions: block must TOUCH the FVG zone AND close in the direction of the trade.
        else if (fvgState === 'WAIT_PULLBACK') {
          const touchedFVG = fiveMinLow <= fvgZoneHigh && fiveMinHigh >= fvgZoneLow;
          const isBullishBlock = fiveMinClose! > fiveMinOpen!;
          const isBearishBlock = fiveMinClose! < fiveMinOpen!;
          const dailyLimitFvg = (slHitsToday > 0 && params.maxTradesOnSLHit !== undefined && params.maxTradesOnSLHit > 0)
            ? params.maxTradesOnSLHit : (params.maxTradesPerDay || 1);
          const dailyLimitOk = tradesTakenToday < dailyLimitFvg;
          const blockTimeOk = timeMinutes < squareOffMinutes;

          if (fvgDirection === 'LONG' && touchedFVG && isBullishBlock && dailyLimitOk && blockTimeOk) {
            // Bullish confirmation: enter LONG at next candle open
            const fvgEntryCandleIndex = i + 1;
            if (fvgEntryCandleIndex < marketData.length) {
              const fvgEntryCandle = marketData[fvgEntryCandleIndex];
              const entrySpot = fvgEntryCandle.open;
              const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
              const hasOptionsFvg = (fvgEntryCandle as any).options !== undefined || (fvgEntryCandle as any).atmStrike !== undefined;

              let entryPriceWithSlip = entrySpot + params.slippagePoints;
              let ceEntryPrice = 0;
              let peEntryPrice = 0;

              if (params.tradeType === 'OPTIONS' && hasOptionsFvg) {
                const ceEntryPremium = this.getOptionPrice(fvgEntryCandle as any, entryStrikeFvg, 'CE', 'open');
                const peEntryPremium = this.getOptionPrice(fvgEntryCandle as any, entryStrikeFvg, 'PE', 'open');
                ceEntryPrice = ceEntryPremium + params.slippagePoints;
                peEntryPrice = peEntryPremium - params.slippagePoints;
                entryPriceWithSlip = ceEntryPrice - peEntryPrice * (finalShortLots / finalLongLots);
              }

              // SL and TP in spot terms (triggers); P&L computed via option prices in exit logic
              const slPrice = fiveMinLow;  // SL = below confirmation candle low
              const slDist = (entrySpot + params.slippagePoints) - slPrice;
              const tpPrice = (entrySpot + params.slippagePoints) + (2 * slDist);  // TP = 2× SL distance

              openPosition = {
                entryTime: fvgEntryCandle.timestamp,
                entryPrice: entryPriceWithSlip,
                type: 'LONG' as const,
                quantity: lotSize * finalLongLots,
                status: 'OPEN' as const,
                entrySpot: entrySpot,
                stopLossPrice: slPrice,
                targetPrice: tpPrice,
                strikePrice: entryStrikeFvg,
                ceEntryPrice,
                peEntryPrice,
                longOptionLots: finalLongLots,
                shortOptionLots: finalShortLots
              };
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] ENTRY LONG. FVG confirm candle: O=${fiveMinOpen!.toFixed(2)} H=${fiveMinHigh.toFixed(2)} L=${fiveMinLow.toFixed(2)} C=${fiveMinClose!.toFixed(2)}. Entry: ${entryPriceWithSlip.toFixed(2)}, SL: ${slPrice.toFixed(2)}, TP: ${tpPrice.toFixed(2)} (FVG zone: ${fvgZoneLow.toFixed(2)}-${fvgZoneHigh.toFixed(2)})`);
              fvgState = 'IDLE';
              fvgCandleN2 = null;
              canTriggerBreakout = false;
              tradesTakenToday++;
            }
          } else if (fvgDirection === 'SHORT' && touchedFVG && isBearishBlock && dailyLimitOk && blockTimeOk) {
            // Bearish confirmation: enter SHORT at next candle open
            const fvgEntryCandleIndex = i + 1;
            if (fvgEntryCandleIndex < marketData.length) {
              const fvgEntryCandle = marketData[fvgEntryCandleIndex];
              const entrySpot = fvgEntryCandle.open;
              const entryStrikeFvg = Math.round(entrySpot / 50) * 50;
              const hasOptionsFvg = (fvgEntryCandle as any).options !== undefined || (fvgEntryCandle as any).atmStrike !== undefined;

              let entryPriceWithSlip = entrySpot - params.slippagePoints;
              let ceEntryPrice = 0;
              let peEntryPrice = 0;

              if (params.tradeType === 'OPTIONS' && hasOptionsFvg) {
                const ceEntryPremium = this.getOptionPrice(fvgEntryCandle as any, entryStrikeFvg, 'CE', 'open');
                const peEntryPremium = this.getOptionPrice(fvgEntryCandle as any, entryStrikeFvg, 'PE', 'open');
                ceEntryPrice = ceEntryPremium - params.slippagePoints;
                peEntryPrice = peEntryPremium + params.slippagePoints;
                entryPriceWithSlip = peEntryPrice - ceEntryPrice * (finalShortLots / finalLongLots);
              }

              // SL and TP in spot terms (triggers); P&L computed via option prices in exit logic
              const slPrice = fiveMinHigh;  // SL = above confirmation candle high
              const slDist = slPrice - (entrySpot - params.slippagePoints);
              const tpPrice = (entrySpot - params.slippagePoints) - (2 * slDist);  // TP = 2× SL distance

              openPosition = {
                entryTime: fvgEntryCandle.timestamp,
                entryPrice: entryPriceWithSlip,
                type: 'SHORT' as const,
                quantity: lotSize * finalLongLots,
                status: 'OPEN' as const,
                entrySpot: entrySpot,
                stopLossPrice: slPrice,
                targetPrice: tpPrice,
                strikePrice: entryStrikeFvg,
                ceEntryPrice,
                peEntryPrice,
                longOptionLots: finalLongLots,
                shortOptionLots: finalShortLots
              };
              console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] ENTRY SHORT. FVG confirm candle: O=${fiveMinOpen!.toFixed(2)} H=${fiveMinHigh.toFixed(2)} L=${fiveMinLow.toFixed(2)} C=${fiveMinClose!.toFixed(2)}. Entry: ${entryPriceWithSlip.toFixed(2)}, SL: ${slPrice.toFixed(2)}, TP: ${tpPrice.toFixed(2)} (FVG zone: ${fvgZoneLow.toFixed(2)}-${fvgZoneHigh.toFixed(2)})`);
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
        const dailyLimit = (slHitsToday > 0 && params.maxTradesOnSLHit !== undefined && params.maxTradesOnSLHit > 0)
          ? params.maxTradesOnSLHit
          : (params.maxTradesPerDay || 1);
        if (tradesTakenToday >= dailyLimit) {
          if (fiveMinClose! > openingRangeHigh || fiveMinClose! < openingRangeLow) {
            console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout detected but skipped because daily limit was reached: ${tradesTakenToday} taken today, daily limit: ${dailyLimit}.`);
          }
        } else {
          if (canTriggerBreakout) {
            let triggerType: 'LONG' | 'SHORT' | null = null;

            // Ensure breakout candle has a strong body (body must be >= total wicks, matching Python filter)
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
              if (fiveMinClose! > openingRangeHigh) {
                const triggerDirection = 'LONG';
                if (params.direction === 'BOTH' || params.direction === triggerDirection) {
                  triggerType = params.entryType === 'REVERSION' ? 'SHORT' : 'LONG';
                  console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout HIGH: 1min close (${fiveMinClose!.toFixed(2)}) > Range High (${openingRangeHigh.toFixed(2)}). Triggering ${triggerType} (Entry Type: ${params.entryType}).`);
                } else {
                  console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout HIGH at ${fiveMinClose!.toFixed(2)} but ignored due to direction setting (${params.direction}).`);
                }
              } else if (fiveMinClose! < openingRangeLow) {
                const triggerDirection = 'SHORT';
                if (params.direction === 'BOTH' || params.direction === triggerDirection) {
                  triggerType = params.entryType === 'REVERSION' ? 'LONG' : 'SHORT';
                  console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout LOW: 1min close (${fiveMinClose!.toFixed(2)}) < Range Low (${openingRangeLow.toFixed(2)}). Triggering ${triggerType} (Entry Type: ${params.entryType}).`);
                } else {
                  console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout LOW at ${fiveMinClose!.toFixed(2)} but ignored due to direction setting (${params.direction}).`);
                }
              }
            } else {
              if (fiveMinClose! > openingRangeHigh || fiveMinClose! < openingRangeLow) {
                console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout detected at close ${fiveMinClose!.toFixed(2)} but hasBody filter FAILED (Body: ${Math.abs(fiveMinClose! - fiveMinOpen!).toFixed(2)}, Open: ${fiveMinOpen!.toFixed(2)}, Close: ${fiveMinClose!.toFixed(2)}, High: ${fiveMinHigh.toFixed(2)}, Low: ${fiveMinLow.toFixed(2)}).`);
              }
            }

            if (triggerType) {
              const entryStrike = Math.round(fiveMinClose! / 50) * 50;

              if (params.entryType === 'FVG') {
                // Breakout detected in FVG mode: store candle[n-2] reference and await next block to confirm FVG zone.
                // Note: prevCompletedBlock = candle[n-2] at this moment (saved when current block started).
                fvgDirection = triggerType;
                fvgCandleN2 = prevCompletedBlock ? { ...prevCompletedBlock } : null;
                fvgState = 'WAIT_NEXT_BLOCK';
                canTriggerBreakout = false;
                console.log(`[FVG] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Breakout ${triggerType} detected. Storing candle[n-2] (H: ${fvgCandleN2?.high.toFixed(2) ?? 'N/A'}, L: ${fvgCandleN2?.low.toFixed(2) ?? 'N/A'}). Awaiting next block close to confirm FVG zone.`);
              } else if (params.entryType === 'RETEST') {
                pendingLimitPrice = triggerType === 'LONG' ? openingRangeHigh : openingRangeLow;
                pendingLimitType = triggerType;
                pendingLimitStrike = entryStrike;
                breakoutFiveMinLow = fiveMinLow;
                breakoutFiveMinHigh = fiveMinHigh;
                canTriggerBreakout = false;
                console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] RETEST pending limit set at ${pendingLimitPrice.toFixed(2)} for ${pendingLimitType}. (Breakout Close: ${fiveMinClose!.toFixed(2)})`);
              } else {
                // Enter at the open of the candle immediately following the breakout block to remove look-ahead bias
                const entryCandleIndex = i + 1;
                if (entryCandleIndex < marketData.length) {
                  const entryCandle = marketData[entryCandleIndex];

                // Prevent overlapping entries if the last trade was still open at this entry's timestamp
                const lastTrade = tradeHistory[tradeHistory.length - 1];
                const isOverlap = lastTrade && lastTrade.exitTime && lastTrade.exitTime.getTime() > entryCandle.timestamp.getTime();

                if (isOverlap) {
                  console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] Skip trigger: Overlapping with previous trade (Last trade exit: ${lastTrade.exitTime}, New entry candle time: ${entryCandle.timestamp}).`);
                } else {
              const quantity = lotSize * finalLongLots;
              const breakoutCandle = marketData[blockStartCandleIndex]; // to read option premium of breakout candle close
              const breakoutRaw = breakoutCandle as any;

              let entryPrice = entryCandle.open;
              const rawCandle = entryCandle as any;
              const hasOptions = rawCandle.options !== undefined || rawCandle.atmStrike !== undefined;
              const entryStrike = Math.round(fiveMinClose! / 50) * 50;

              let ceEntryPrice = 0;
              let peEntryPrice = 0;

              if (tradeType === 'OPTIONS' && hasOptions) {
                const ceEntryPremium = this.getOptionPrice(entryCandle, entryStrike, 'CE', 'open');
                const peEntryPremium = this.getOptionPrice(entryCandle, entryStrike, 'PE', 'open');

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
                // Spot mode
                if (triggerType === 'LONG') {
                  entryPrice += params.slippagePoints;
                } else {
                  entryPrice -= params.slippagePoints;
                }
              }

            // Calculate Stop Loss using spot entry price
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

            // Calculate Target using spot entry price
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
              quantity: quantity,
              status: 'OPEN',
              entrySpot: entryCandle.open,
              stopLossPrice: stopLossPrice,
              targetPrice: targetPrice,
              strikePrice: entryStrike,
              ceEntryPrice: ceEntryPrice,
              peEntryPrice: peEntryPrice,
              longOptionLots: finalLongLots,
              shortOptionLots: finalShortLots
            };

            console.log(`[ORB Debug] [${ist.dateStr} ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}] ENTRY: ${openPosition.type} triggered. Spot Open: ${entryCandle.open.toFixed(2)}, Target: ${targetPrice.toFixed(2)}, SL: ${stopLossPrice.toFixed(2)}. Option Legs -> Strike: ${entryStrike}, CE Entry Price: ${ceEntryPrice.toFixed(2)}, PE Entry Price: ${peEntryPrice.toFixed(2)}`);

            canTriggerBreakout = false;
            tradesTakenToday++;

            // Retroactively check for exits on the candles within this block (from entry index to current index i)
            for (let j = entryCandleIndex; j <= i; j++) {
              const checkCandle = marketData[j];
              
              // Trailing Stop Loss Logic for Retroactive Loop
              if (params.trailingStopLoss && params.trailingStopLoss > 0) {
                if (openPosition.type === 'LONG') {
                  const currentPeak = openPosition.peakSpot !== undefined ? openPosition.peakSpot : openPosition.entrySpot;
                  if (checkCandle.high > currentPeak) {
                    openPosition.peakSpot = checkCandle.high;
                    const newSL = checkCandle.high - params.trailingStopLoss;
                    if (newSL > openPosition.stopLossPrice) {
                      openPosition.stopLossPrice = newSL;
                    }
                  }
                } else {
                  const currentTrough = openPosition.troughSpot !== undefined ? openPosition.troughSpot : openPosition.entrySpot;
                  if (checkCandle.low < currentTrough) {
                    openPosition.troughSpot = checkCandle.low;
                    const newSL = checkCandle.low + params.trailingStopLoss;
                    if (newSL < openPosition.stopLossPrice) {
                      openPosition.stopLossPrice = newSL;
                    }
                  }
                }
              }

              // Fifty-Percent Target Cost-to-Cost Trailing Logic
              if (params.trailToCostAtFiftyPercentTarget && !openPosition.isSlMovedToCost) {
                if (openPosition.type === 'LONG') {
                  const halfwayTarget = openPosition.entrySpot + 0.5 * (openPosition.targetPrice - openPosition.entrySpot);
                  if (checkCandle.high >= halfwayTarget) {
                    openPosition.stopLossPrice = openPosition.entrySpot;
                    openPosition.isSlMovedToCost = true;
                  }
                } else {
                  const halfwayTarget = openPosition.entrySpot - 0.5 * (openPosition.entrySpot - openPosition.targetPrice);
                  if (checkCandle.low <= halfwayTarget) {
                    openPosition.stopLossPrice = openPosition.entrySpot;
                    openPosition.isSlMovedToCost = true;
                  }
                }
              }

              const checkIst = this.strategyService.getISTTime(checkCandle.timestamp);
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
                let exitPrice = exitSpotPrice;

                const checkRaw = checkCandle as any;
                const checkHasOptions = checkRaw.options !== undefined || checkRaw.atmStrike !== undefined;

                let ceExitPrice = 0;
                let peExitPrice = 0;

                if (tradeType === 'OPTIONS' && checkHasOptions) {
                  let ceExitField: 'open' | 'high' | 'low' | 'close' = 'close';
                  let peExitField: 'open' | 'high' | 'low' | 'close' = 'close';

                  if (exitReason === 'Target') {
                    ceExitField = openPosition.type === 'LONG' ? 'high' : 'low';
                    peExitField = openPosition.type === 'LONG' ? 'low' : 'high';
                  } else if (exitReason === 'Stop Loss') {
                    ceExitField = openPosition.type === 'LONG' ? 'low' : 'high';
                    peExitField = openPosition.type === 'LONG' ? 'high' : 'low';
                  }

                  const ceExitPremium = this.getOptionPrice(checkCandle, openPosition.strikePrice!, 'CE', ceExitField);
                  const peExitPremium = this.getOptionPrice(checkCandle, openPosition.strikePrice!, 'PE', peExitField);

                  if (openPosition.type === 'LONG') {
                    ceExitPrice = ceExitPremium - params.slippagePoints;
                    peExitPrice = peExitPremium + params.slippagePoints;
                    const cePnl = (ceExitPrice - openPosition.ceEntryPrice!) * lotSize * finalLongLots;
                    const pePnl = (openPosition.peEntryPrice! - peExitPrice) * lotSize * finalShortLots;
                    tradePnl = cePnl + pePnl - params.brokerageFlat;
                    exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
                  } else {
                    ceExitPrice = ceExitPremium + params.slippagePoints;
                    peExitPrice = peExitPremium - params.slippagePoints;
                    const cePnl = (openPosition.ceEntryPrice! - ceExitPrice) * lotSize * finalShortLots;
                    const pePnl = (peExitPrice - openPosition.peEntryPrice!) * lotSize * finalLongLots;
                    tradePnl = cePnl + pePnl - params.brokerageFlat;
                    exitPrice = peExitPrice - ceExitPrice * (finalShortLots / finalLongLots);
                  }
                } else {
                  // Spot exit
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
                openPosition.exitTime = checkCandle.timestamp;
                openPosition.exitPrice = exitPrice;
                openPosition.status = 'CLOSED';
                openPosition.pnl = tradePnl;
                openPosition.ceExitPrice = ceExitPrice;
                openPosition.peExitPrice = peExitPrice;
                (openPosition as any).exitReason = exitReason;
                (openPosition as any).exitSpot = exitSpotPrice;

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
      }
    }
    }
  }

      // 5. Track daily/minute equity and drawdowns
      let currentEquity = currentCapital;
      if (openPosition) {
        // Current open P&L using current candle's spot price
        const currentSpot = candle.close;
        const rawCandle = candle as any;
        const hasOptions = rawCandle.options !== undefined || rawCandle.atmStrike !== undefined;

        let openPnl = 0;
        if (tradeType === 'OPTIONS' && hasOptions) {
          const cePrice = this.getOptionPrice(candle, openPosition.strikePrice!, 'CE', 'close');
          const pePrice = this.getOptionPrice(candle, openPosition.strikePrice!, 'PE', 'close');

          if (openPosition.type === 'LONG') {
            const cePnl = (cePrice - openPosition.ceEntryPrice!) * lotSize * finalLongLots;
            const pePnl = (openPosition.peEntryPrice! - pePrice) * lotSize * finalShortLots;
            openPnl = cePnl + pePnl - params.brokerageFlat;
          } else {
            const cePnl = (openPosition.ceEntryPrice! - cePrice) * lotSize * finalShortLots;
            const pePnl = (pePrice - openPosition.peEntryPrice!) * lotSize * finalLongLots;
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

      equityCurve.push({ time: candle.timestamp, equity: currentEquity });

      if (currentEquity > maxEquity) {
        maxEquity = currentEquity;
      }
      const drawdown = maxEquity - currentEquity;
      if (drawdown > maxDrawdownValue) {
        maxDrawdownValue = drawdown;
      }
    }

    // Force close open position at the very end of data
    if (openPosition) {
      const lastCandle = marketData[marketData.length - 1];
      const lastRaw = lastCandle as any;
      const lastHasOptions = lastRaw.options !== undefined || lastRaw.atmStrike !== undefined;
      
      let exitPrice = lastCandle.close;
      let tradePnl = 0;
      let ceExitPrice = 0;
      let peExitPrice = 0;

      if (tradeType === 'OPTIONS' && lastHasOptions) {
        const ceExitPremium = this.getOptionPrice(lastCandle, openPosition.strikePrice!, 'CE', 'close');
        const peExitPremium = this.getOptionPrice(lastCandle, openPosition.strikePrice!, 'PE', 'close');

        if (openPosition.type === 'LONG') {
          ceExitPrice = ceExitPremium - params.slippagePoints;
          peExitPrice = peExitPremium + params.slippagePoints;
          const cePnl = (ceExitPrice - openPosition.ceEntryPrice!) * lotSize * finalLongLots;
          const pePnl = (openPosition.peEntryPrice! - peExitPrice) * lotSize * finalShortLots;
          tradePnl = cePnl + pePnl - params.brokerageFlat;
          exitPrice = ceExitPrice - peExitPrice * (finalShortLots / finalLongLots);
        } else {
          ceExitPrice = ceExitPremium + params.slippagePoints;
          peExitPrice = peExitPremium - params.slippagePoints;
          const cePnl = (openPosition.ceEntryPrice! - ceExitPrice) * lotSize * finalShortLots;
          const pePnl = (peExitPrice - openPosition.peEntryPrice!) * lotSize * finalLongLots;
          tradePnl = cePnl + pePnl - params.brokerageFlat;
          exitPrice = peExitPrice - ceExitPrice * (finalShortLots / finalLongLots);
        }
      } else {
        let finalExitPrice = lastCandle.close;
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
      openPosition.exitTime = lastCandle.timestamp;
      openPosition.exitPrice = exitPrice;
      openPosition.status = 'CLOSED';
      openPosition.pnl = tradePnl;
      openPosition.ceExitPrice = ceExitPrice;
      openPosition.peExitPrice = peExitPrice;
      (openPosition as any).exitReason = 'Forced Close';
      (openPosition as any).exitSpot = lastCandle.close;

      tradeHistory.push({ ...openPosition });
    }

    // Calculate final metrics
    const winningTrades = tradeHistory.filter(t => t.pnl && t.pnl > 0);
    const losingTrades = tradeHistory.filter(t => t.pnl && t.pnl <= 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLoss = losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl || 0), 0);

    const avgWin = winningTrades.length > 0 ? (grossProfit / winningTrades.length) : 0;
    const avgLoss = losingTrades.length > 0 ? (grossLoss / losingTrades.length) : 0;
    const winLossRatio = avgLoss > 0 ? (avgWin / avgLoss) : avgWin;
    const recoveryFactor = maxDrawdownValue > 0 ? (currentCapital - config.initialCapital) / maxDrawdownValue : 0;

    let maxConsecWins = 0;
    let maxConsecLosses = 0;
    let currentConsecWins = 0;
    let currentConsecLosses = 0;

    tradeHistory.forEach(t => {
      if (t.pnl && t.pnl > 0) {
        currentConsecWins++;
        currentConsecLosses = 0;
        if (currentConsecWins > maxConsecWins) maxConsecWins = currentConsecWins;
      } else {
        currentConsecLosses++;
        currentConsecWins = 0;
        if (currentConsecLosses > maxConsecLosses) maxConsecLosses = currentConsecLosses;
      }
    });

    const metrics: BacktestMetrics = {
      totalTrades: tradeHistory.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: tradeHistory.length > 0 ? (winningTrades.length / tradeHistory.length) * 100 : 0,
      grossProfit,
      grossLoss,
      netProfit: currentCapital - config.initialCapital,
      maxDrawdown: maxDrawdownValue,
      maxDrawdownPercent: (maxDrawdownValue / config.initialCapital) * 100,
      finalCapital: currentCapital,
      avgWin,
      avgLoss,
      winLossRatio,
      recoveryFactor,
      maxConsecutiveWins: maxConsecWins,
      maxConsecutiveLosses: maxConsecLosses
    };

    return {
      config,
      metrics,
      trades: tradeHistory,
      equityCurve
    };
  }

  private getOptionPrice(candle: Candle, strike: number, type: 'CE' | 'PE', field: 'open' | 'high' | 'low' | 'close'): number {
    const rawCandle = candle as any;
    const strikeStr = String(strike);
    if (rawCandle.options && rawCandle.options[strikeStr] && rawCandle.options[strikeStr][type]) {
      return rawCandle.options[strikeStr][type][field];
    }
    
    // Fallback: Spot-based intrinsic value replication
    if (type === 'CE') {
      const spotVal = candle[field];
      return Math.max(0, spotVal - strike);
    } else {
      // For Put options, high premium matches spot low, low premium matches spot high
      let spotVal = candle[field];
      if (field === 'high') spotVal = candle.low;
      else if (field === 'low') spotVal = candle.high;
      return Math.max(0, strike - spotVal);
    }
  }

  /**
   * Helper to simulate market slippage
   */
  private applySlippage(price: number, action: 'BUY' | 'SELL', slippagePercent: number = 0): number {
    if (slippagePercent === 0) return price;
    
    const slippageAmount = price * (slippagePercent / 100);
    // Slippage means you pay MORE when buying, and receive LESS when selling
    if (action === 'BUY') {
        return price + slippageAmount;
    } else {
        return price - slippageAmount;
    }
  }

}
