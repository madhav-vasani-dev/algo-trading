import { Injectable } from '@angular/core';
import { Candle, TradeSignal } from '../models/backtest.models';

@Injectable({
  providedIn: 'root'
})
export class StrategyLogicService {

  constructor() { }

  /**
   * Evaluates a moving average crossover strategy.
   * @param currentCandle The latest candle to evaluate
   * @param historicalCandles Array of all previous candles up to this point
   * @param params Configuration parameters { shortWindow, longWindow }
   */
  public evaluateMovingAverageCrossover(
    currentCandle: Candle, 
    historicalCandles: Candle[], 
    params: { shortWindow: number, longWindow: number }
  ): TradeSignal {
    
    if (historicalCandles.length < params.longWindow) {
      return { type: 'HOLD', price: 0, reason: 'Not enough data for Long MA' };
    }

    const shortMA = this.calculateSMA(historicalCandles, params.shortWindow);
    const longMA = this.calculateSMA(historicalCandles, params.longWindow);
    
    // To check for a crossover, we also need the MA from the *previous* candle
    const prevCandles = historicalCandles.slice(0, -1);
    const prevShortMA = this.calculateSMA(prevCandles, params.shortWindow);
    const prevLongMA = this.calculateSMA(prevCandles, params.longWindow);

    // Golden Cross: Short MA crosses *above* Long MA
    if (prevShortMA <= prevLongMA && shortMA > longMA) {
      return { 
        type: 'BUY', 
        price: currentCandle.close, 
        reason: `Golden Cross (Short: ${shortMA.toFixed(2)} > Long: ${longMA.toFixed(2)})` 
      };
    }

    // Death Cross: Short MA crosses *below* Long MA
    if (prevShortMA >= prevLongMA && shortMA < longMA) {
      return { 
        type: 'SELL', 
        price: currentCandle.close, 
        reason: `Death Cross (Short: ${shortMA.toFixed(2)} < Long: ${longMA.toFixed(2)})` 
      };
    }

    return { type: 'HOLD', price: 0, reason: 'No crossover detected' };
  }

  /**
   * Helper function to calculate Simple Moving Average
   */
  private calculateSMA(data: Candle[], period: number): number {
    if (data.length < period) return 0;
    
    const slice = data.slice(data.length - period);
    const sum = slice.reduce((acc, candle) => acc + candle.close, 0);
    return sum / period;
  }

  /**
   * Helper function to convert Date objects to Indian Standard Time (IST, UTC+5:30)
   * components regardless of the user's browser/system timezone.
   */
  public getISTTime(date: Date): { hour: number; minute: number; dateStr: string; timeStr: string } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });

    const parts = formatter.formatToParts(date);
    const partsMap = parts.reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {} as Record<string, string>);

    const hour = parseInt(partsMap['hour'], 10);
    const minute = parseInt(partsMap['minute'], 10);
    const dateStr = `${partsMap['year']}-${partsMap['month']}-${partsMap['day']}`;
    const timeStr = `${partsMap['hour']}:${partsMap['minute']}`;
    
    return { hour, minute, dateStr, timeStr };
  }
}
