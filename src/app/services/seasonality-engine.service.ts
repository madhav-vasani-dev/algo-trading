import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { UpstoxInstrument, Candle, SeasonalityResult, SeasonalityYearData, SeasonalityDataPoint, SeasonalityPeriodMetrics } from '../models/backtest.models';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import { UpstoxService } from './upstox.service';

@Injectable({
  providedIn: 'root'
})
export class SeasonalityEngineService {

  private readonly INSTRUMENT_CSV_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz';
  
  // Cache the full list so we don't re-download the massive CSV on every component load
  private allInstruments: UpstoxInstrument[] = [];

    constructor(private http: HttpClient, private upstox: UpstoxService) { }

  /**
   * Fetches the maximum available daily data for a given instrument.
   * Bypasses the 1-year Upstox limit by making multiple sequential calls backwards in time until Upstox returns empty.
   */
  async fetchDeepHistoricalData(instrumentKey: string, maxYears: number = 20): Promise<Candle[]> {
      const token = await this.upstox.getValidToken();
    if (!token) throw new Error("No Upstox token found. Please connect Broker Account.");

    let allCandles: Candle[] = [];
    
    // We start from today
    let currentEndDate = new Date();
    
    // Use the provided maxYears cap (default 20) to limit how far back we fetch.
    // Most NSE stocks have meaningful data for ~15-25 years.
    const MAX_YEARS_SAFEGUARD = maxYears; 
    
    for (let i = 0; i < MAX_YEARS_SAFEGUARD; i++) {
        // Calculate the start date for this 1-year chunk (strictly 1 year to avoid Upstox limits)
        let currentStartDate = new Date(currentEndDate);
        currentStartDate.setFullYear(currentStartDate.getFullYear() - 1);

        const toDateStr = this.formatDate(currentEndDate);
        const fromDateStr = this.formatDate(currentStartDate);

        try {
            console.log(`[SeasonalityEngine] Fetching ${instrumentKey} Chunk ${i+1}: ${fromDateStr} to ${toDateStr}`);

            // Localhost: relative path goes through Angular dev proxy (/v3 → api.upstox.com)
            // Production: must use the full absolute URL (no proxy server on GitHub Pages)
            const isLocal = window.location.hostname === 'localhost';
            const base = isLocal ? '' : 'https://api.upstox.com';
            // v3 format: /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}
            // unit = 'days', interval = '1' (v2 used a single 'day' parameter)
            const url = `${base}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/days/1/${toDateStr}/${fromDateStr}`;
            const response = await axios.get(url, {
              headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
              }
            });

            if (response.data && response.data.status === 'success' && response.data.data) {
                const chunkData = response.data.data.candles;
                
                if (!chunkData || chunkData.length === 0) {
                     console.log(`[SeasonalityEngine] Hit the start of data history before ${toDateStr}. Total years fetched: ${i}`);
                     break; // Stock probably didn't exist before this (IPO date reached)
                }

                const parsedChunk = this.parseUpstoxCandles(chunkData);
                allCandles = allCandles.concat(parsedChunk);

                // Set the end date for the NEXT loop to be 1 day before the start date of THIS loop
                currentEndDate = new Date(currentStartDate);
                currentEndDate.setDate(currentEndDate.getDate() - 1);
            } else {
                 console.error('[SeasonalityEngine] API Error in chunk:', response.data);
                 break;
            }

        } catch (error: any) {
             console.error(`[SeasonalityEngine] Error fetching chunk ${i}:`, error.message);
             // If we hit an error (e.g. rate limits or 404 for too old), stop fetching but return what we have so far
             break; 
        }
    }

    // Upstox returns newest to oldest within each chunk, and our chunks are newest to oldest.
    // So the entire array is newest-to-oldest. We reverse it so it's chronological (oldest to newest)
    allCandles.reverse();
    return allCandles;
  }

  // ... (formatDate, calculateSeasonality, parseUpstoxCandles remain unchanged)

  private formatDate(date: Date): string {
    const d = new Date(date);
    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    const year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    return [year, month, day].join('-');
  }

  /**
   * Calculates the percentage change for each Month or Week across multiple years.
   * Assumes 'candles' is sorted chronologically (oldest to newest).
   */
    calculateSeasonality(instrument: UpstoxInstrument, candles: Candle[], period: 'month' | 'week' | 'day'): SeasonalityResult {
     
     // Map to group data by Year
     // Inside each year, map to group data by Period (Month Index 0-11, or Week Number 1-52)
     const yearlyGroups = new Map<number, Map<number, Candle[]>>();

     for (const candle of candles) {
         const year = candle.timestamp.getFullYear();
         
         let periodKey: number;
         if (period === 'month') {
             periodKey = candle.timestamp.getMonth(); // 0-11
         } else if (period === 'week') {
             // Calculate ISO Week number (1-53)
             const tempDate = new Date(candle.timestamp.getTime());
             tempDate.setHours(0, 0, 0, 0);
             tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
             const week1 = new Date(tempDate.getFullYear(), 0, 4);
             periodKey = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
         } else {
             const start = new Date(year, 0, 0);
             const diff = candle.timestamp.getTime() - start.getTime();
             periodKey = Math.round(diff / 86400000); // 1-366
         }

         if (!yearlyGroups.has(year)) {
             yearlyGroups.set(year, new Map());
         }

         const periodsForYear = yearlyGroups.get(year)!;
         if (!periodsForYear.has(periodKey)) {
             periodsForYear.set(periodKey, []);
         }

         periodsForYear.get(periodKey)!.push(candle);
     }

     const resultYears: SeasonalityYearData[] = [];

     const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

     // Iterate over each year to calculate the percentage difference between the first open and last close of each period
     for (const [year, periodsMap] of Array.from(yearlyGroups.entries()).sort((a, b) => a[0] - b[0])) {
         
         const dataPoints: SeasonalityDataPoint[] = [];
         
         // Fix the number of periods (12 months, 52 weeks, 366 days) so the UI grid is uniform
         const maxPeriods = period === 'month' ? 12 : period === 'week' ? 52 : 366;
         
         for (let p = 0; p < maxPeriods; p++) {
             // For weeks and days, the key is 1-indexed. For months, it's 0-indexed.
             const lookupKey = period === 'month' ? p : p + 1;
             const periodCandles = periodsMap.get(lookupKey);
             
             let label = '';
             if (period === 'month') {
                 label = monthNames[p];
             } else if (period === 'week') {
                 // For weeks (1-52), calculate which month it roughly falls into (every ~4.3 weeks is a month)
                 const approximateMonthIndex = Math.min(11, Math.floor(p / 4.33));
                 label = `${monthNames[approximateMonthIndex]} W${p + 1}`;
             } else {
                 // Map the 0-365 day index to a calendar date using a leap year anchor (2024)
                 const dummyDate = new Date(2024, 0, p + 1);
                 label = `${monthNames[dummyDate.getMonth()]} ${dummyDate.getDate()}`;
             }

             if (!periodCandles || periodCandles.length === 0) {
                 // No trading data for this period (e.g. holidays or stock didn't exist yet)
                 dataPoints.push({
                     periodLabel: label,
                     startPrice: 0,
                     endPrice: 0,
                     percentageChange: 0 
                     // Alternatively, we could use undefined, but 0 is easier for math unless we want to render "N/A"
                     // In the UI we will check if startPrice === 0 to render an empty cell.
                 });
             } else {
                  // CLOSE-TO-CLOSE (industry standard - matches MoneyControl/Chartink):
                  // % change = (this period last close - prev period last close) / prev period last close
                  const sorted = periodCandles.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                  const endPrice = sorted[sorted.length - 1].close;

                  // Find previous period closing price
                  let prevClose = 0;
                  if (p === 0) {
                      const prevYearMap = yearlyGroups.get(year - 1);
                      if (prevYearMap) {
                          const prevPeriodKey = period === 'month' ? 11 : period === 'week' ? 52 : 366;
                          const prevCandles = prevYearMap.get(prevPeriodKey);
                          if (prevCandles && prevCandles.length > 0) {
                              const ps = prevCandles.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                              prevClose = ps[ps.length - 1].close;
                          }
                      }
                  } else {
                      const prevKey = period === 'month' ? p - 1 : p;
                      const prevCandles = periodsMap.get(prevKey);
                      if (prevCandles && prevCandles.length > 0) {
                          const ps = prevCandles.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                          prevClose = ps[ps.length - 1].close;
                      }
                  }

                  if (prevClose === 0) {
                      dataPoints.push({ periodLabel: label, startPrice: 0, endPrice: 0, percentageChange: 0 });
                  } else {
                      const pctChange = ((endPrice - prevClose) / prevClose) * 100;
                      dataPoints.push({ periodLabel: label, startPrice: prevClose, endPrice: endPrice, percentageChange: pctChange });
                  }
              }
         }

         let yearlyReturn = 0;
         const allCandlesThisYear = Array.from(periodsMap.values()).flat().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
         if (allCandlesThisYear.length > 0) {
             const yearEndPrice = allCandlesThisYear[allCandlesThisYear.length - 1].close;

             let prevYearEndPrice = 0;
             const prevYearMap = yearlyGroups.get(year - 1);
             if (prevYearMap) {
                 const allCandlesPrevYear = Array.from(prevYearMap.values()).flat().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                 if (allCandlesPrevYear.length > 0) {
                     prevYearEndPrice = allCandlesPrevYear[allCandlesPrevYear.length - 1].close;
                 }
             }

             if (prevYearEndPrice > 0) {
                 yearlyReturn = ((yearEndPrice - prevYearEndPrice) / prevYearEndPrice) * 100;
             } else {
                 const yearStartPrice = allCandlesThisYear[0].open;
                 yearlyReturn = ((yearEndPrice - yearStartPrice) / yearStartPrice) * 100;
             }
         }

         resultYears.push({
             year: year,
             dataPoints: dataPoints,
             yearlyReturn: yearlyReturn
         });
     }

     // Now calculate the aggregated Period Metrics (Avg, Win %, Loss %) for the columns
     const periodMetrics: SeasonalityPeriodMetrics[] = [];
        const maxPeriods = period === 'month' ? 12 : period === 'week' ? 52 : 366;
     
     for (let p = 0; p < maxPeriods; p++) {
         let sumPercentage = 0;
         let positiveCount = 0;
         let negativeCount = 0;
         let validYearsCount = 0;

         // Grab the label from the first year's pre-computed dataPoints (already has the correct label string)
         const label = resultYears[0]?.dataPoints[p]?.periodLabel ?? '';
         
         // Extract vertical column data across all years
         for (const yearObj of resultYears) {
             const dp = yearObj.dataPoints[p];
             if (dp.startPrice > 0) {
                 validYearsCount++;
                 sumPercentage += dp.percentageChange;
                 if (dp.percentageChange >= 0) positiveCount++;
                 if (dp.percentageChange < 0) negativeCount++;
             }
         }

         const avgReturn = validYearsCount > 0 ? (sumPercentage / validYearsCount) : 0;
         const winRate = validYearsCount > 0 ? (positiveCount / validYearsCount) * 100 : 0;
         const lossRate = validYearsCount > 0 ? (negativeCount / validYearsCount) * 100 : 0;

         periodMetrics.push({
             periodLabel: label,
             averageReturn: avgReturn,
             positiveProbability: winRate,
             negativeProbability: lossRate
         });
     }

     return {
         instrument: instrument,
         yearsData: resultYears,
         periodMetrics: periodMetrics
     };
  }

  private parseUpstoxCandles(rawCandles: any[][]): Candle[] {
    return rawCandles.map(row => ({
      timestamp: new Date(row[0]),
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      volume: parseInt(row[5], 10),
      openInterest: row.length > 6 ? parseInt(row[6], 10) : undefined
    }));
  }

  /**
   * Fetches the NSE equity instrument list.
   * - Localhost: uses the Angular dev proxy → Upstox CDN (no CORS)
   * - Production: fetches /algo-trading/instruments.json which is a static asset
   *   generated at deploy time by scripts/fetch-instruments.js — same-origin, zero CORS.
   */
  async getEquityInstruments(): Promise<UpstoxInstrument[]> {
    if (this.allInstruments.length > 0) {
      return this.allInstruments;
    }

      try {
        const isLocal = window.location.hostname === 'localhost';
          let instruments: UpstoxInstrument[];

          if (isLocal) {
              // Dev proxy rewrites /upstox-assets → https://assets.upstox.com (no CORS)
              const proxyUrl = '/upstox-assets/market-quote/instruments/exchange/NSE.json.gz';
              console.log('[SeasonalityEngine] Fetching instruments via dev proxy...');
              const gzipBlob = await firstValueFrom(this.http.get(proxyUrl, { responseType: 'blob' }));
              const stream = gzipBlob.stream().pipeThrough(new DecompressionStream('gzip'));
              const jsonText = await new Response(stream).text();
              const allRaw: any[] = JSON.parse(jsonText);
              instruments = this.mapInstruments(
                  allRaw.filter(i => i.segment === 'NSE_EQ' &&
                      (i.instrument_type === 'EQ' || i.instrument_type === 'BE' || i.instrument_type === 'SM'))
              );
          } else {
              // Production: instruments.json is pre-generated by scripts/fetch-instruments.js
              // and deployed as a static file on GitHub Pages — same origin, no CORS needed.
              const url = '/algo-trading/instruments.json';
              console.log('[SeasonalityEngine] Fetching instruments from same-origin static file...');
              instruments = await firstValueFrom(this.http.get<UpstoxInstrument[]>(url));
      }

          console.log(`[SeasonalityEngine] Loaded ${instruments.length} NSE equity instruments.`);
          this.allInstruments = instruments;
          return instruments;

      } catch (error: any) {
          console.error('[SeasonalityEngine] Failed to fetch instruments:', error?.message);
          throw new Error('Failed to load instrument list. Please check your network and try again.');
    }
  }

    /** Maps raw NSE.json items to UpstoxInstrument objects */
    private mapInstruments(raw: any[]): UpstoxInstrument[] {
        return raw.map(item => ({
            instrument_key: item.instrument_key ?? '',
            exchange_token: item.exchange_token ?? '',
            tradingsymbol: item.trading_symbol ?? item.tradingsymbol ?? '',
            name: item.name ?? '',
            last_price: item.last_price ?? 0,
            expiry: item.expiry ?? '',
            strike: String(item.strike_price ?? ''),
            tick_size: String(item.tick_size ?? ''),
            lot_size: String(item.lot_size ?? ''),
            instrument_type: item.instrument_type ?? '',
            option_type: item.option_type ?? '',
            exchange: item.exchange ?? ''
        }));
  }
}
