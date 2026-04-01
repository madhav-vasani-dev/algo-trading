import { Component, OnInit, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SeasonalityEngineService } from '../../../services/seasonality-engine.service';
import { UpstoxInstrument, SeasonalityResult, Candle, BestPeriodEntry, ScreenerStock } from '../../../models/backtest.models';
import { SECTOR_MAPPING, SECTORS } from '../../../data/sectors';
import { INDEX_MAPPING, INDEX_NAMES, SECTOR_TO_INDEX } from '../../../data/indices';
import { INDEX_CONSTITUENTS } from '../../../data/index-constituents';

@Component({
  selector: 'app-seasonality',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './seasonality.component.html',
  styleUrl: './seasonality.component.scss'
})
export class SeasonalityComponent implements OnInit {

  isLoadingInstruments = true;
  errorMessage = '';

  // Instrument Selection
  sectors = SECTORS;
  selectedSector = '';
  allStocks: UpstoxInstrument[] = [];
  filteredStocks: UpstoxInstrument[] = [];
  selectedStocks: UpstoxInstrument[] = [];
  searchText = '';

  // Table Configuration
  tableView: 'day' | 'week' | 'month' = 'month';
  isCalculating = false;

  // Cache to store the massive daily payload so switching views is instant
  private cachedCandles = new Map<string, Candle[]>();

  // Results
  results: SeasonalityResult[] = [];

  // Best periods cache (avoids recalculation on every change detection cycle)
  bestPeriodsCache = new Map<string, { bullish: BestPeriodEntry[], bearish: BestPeriodEntry[] }>();

  // Index data
  indexNames = INDEX_NAMES;
  selectedIndex = '';
  indexResult: SeasonalityResult | null = null;
  indexBestPeriods: { bullish: BestPeriodEntry[], bearish: BestPeriodEntry[] } | null = null;

  // Dropdown UI states
  isSectorDropdownOpen = false;
  isPeriodDropdownOpen = false;
  isIndexDropdownOpen = false;

  // Progress tracking
  fetchProgress = '';

  // ── Screener (Feature 3) ──────────────────────────────
  screenerIndex = '';
  screenerPeriod: 'month' | 'week' | 'day' = 'month';
  screenerPeriodIndex = 0;
  screenerTab: 'bullish' | 'bearish' = 'bullish';
  screenerBullish: ScreenerStock[] = [];
  screenerBearish: ScreenerStock[] = [];
  isScreenerRunning = false;
  screenerHasRun = false;
  screenerError = '';
  screenerProgress = '';

  // Screener dropdown states
  isScreenerIndexDropdownOpen = false;
  isScreenerPeriodDropdownOpen = false;
  isScreenerPeriodIndexDropdownOpen = false;

  // Labels for period selection
  monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  weekLabels: string[] = [];
  dayLabels: string[] = [];

  constructor(
    private seasonalityEngine: SeasonalityEngineService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone
  ) {
    for (let i = 1; i <= 52; i++) this.weekLabels.push(`Week ${i}`);
    for (let i = 0; i < 366; i++) {
      const d = new Date(2024, 0, i + 1);
      const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      this.dayLabels.push(`${mn[d.getMonth()]} ${d.getDate()}`);
    }
  }

  ngOnInit(): void {
    this.loadInstruments();
  }

  async loadInstruments() {
    this.isLoadingInstruments = true;
    try {
      this.allStocks = await this.seasonalityEngine.getEquityInstruments();
      if (this.allStocks.length === 0) {
          throw new Error("Failed to parse instrument list (0 stocks loaded).");
      }
      this.filteredStocks = this.allStocks.slice(0, 100);
    } catch (error: any) {
      this.errorMessage = error.message;
    } finally {
      this.isLoadingInstruments = false;
      this.cdr.detectChanges();
    }
  }

  onSearchChange() {
    if (!this.searchText) {
      this.filteredStocks = [];
      return;
    }
    const query = this.searchText.toLowerCase();
    const selectedKeys = new Set(this.selectedStocks.map(s => s.instrument_key));
    this.filteredStocks = this.allStocks
      .filter(stock =>
        !selectedKeys.has(stock.instrument_key) &&
        (stock.tradingsymbol.toLowerCase().includes(query) ||
         stock.name.toLowerCase().includes(query))
      )
      .slice(0, 100);
  }

  toggleSelection(stock: UpstoxInstrument) {
    const index = this.selectedStocks.findIndex(s => s.instrument_key === stock.instrument_key);
    if (index > -1) {
      this.selectedStocks.splice(index, 1);
      this.cachedCandles.delete(stock.instrument_key);
    } else {
      this.selectedStocks.push(stock);
      this.searchText = '';
      this.filteredStocks = [];
    }
  }

  isSelected(stock: UpstoxInstrument): boolean {
    return this.selectedStocks.some(s => s.instrument_key === stock.instrument_key);
  }

  removeSelected(stock: UpstoxInstrument) {
     this.selectedStocks = this.selectedStocks.filter(s => s.instrument_key !== stock.instrument_key);
     this.cachedCandles.delete(stock.instrument_key);
    if (this.selectedSector) {
      this.selectedSector = '';
    }
  }

  onSectorChange() {
    this.selectedStocks = [];
    if (!this.selectedSector) return;
    const symbols = SECTOR_MAPPING[this.selectedSector];
    this.selectedStocks = this.allStocks.filter(s => symbols.includes(s.tradingsymbol));

    // Auto-select closest index for this sector
    this.selectedIndex = SECTOR_TO_INDEX[this.selectedSector] || 'NIFTY 50';
  }

  selectSector(sector: string) {
    this.selectedSector = sector;
    this.isSectorDropdownOpen = false;
    this.onSectorChange();
  }

  selectPeriod(period: 'day' | 'week' | 'month') {
    this.tableView = period;
    this.isPeriodDropdownOpen = false;
    this.onViewChange();
  }

  selectIndex(index: string) {
    this.selectedIndex = index;
    this.isIndexDropdownOpen = false;
  }

  closeDropdowns() {
    this.isSectorDropdownOpen = false;
    this.isPeriodDropdownOpen = false;
    this.isIndexDropdownOpen = false;
    this.isScreenerIndexDropdownOpen = false;
    this.isScreenerPeriodDropdownOpen = false;
    this.isScreenerPeriodIndexDropdownOpen = false;
    this.searchText = '';
    this.filteredStocks = [];
  }

  // ── Screener Dropdown helpers ────────────────────────
  selectScreenerIndex(index: string) {
    this.screenerIndex = index;
    this.isScreenerIndexDropdownOpen = false;
  }

  selectScreenerPeriod(period: 'month' | 'week' | 'day') {
    this.screenerPeriod = period;
    this.screenerPeriodIndex = 0;
    this.isScreenerPeriodDropdownOpen = false;
  }

  selectScreenerPeriodIndex(idx: number) {
    this.screenerPeriodIndex = idx;
    this.isScreenerPeriodIndexDropdownOpen = false;
  }

  get screenerPeriodLabels(): string[] {
    if (this.screenerPeriod === 'month') return this.monthLabels;
    if (this.screenerPeriod === 'week') return this.weekLabels;
    return this.dayLabels;
  }

  get currentScreenerPeriodLabel(): string {
    return this.screenerPeriodLabels[this.screenerPeriodIndex] || '';
  }

  /**
   * Fetches candle data for a single stock, using cache if available.
   * Uses NgZone.run to ensure Angular picks up changes after axios calls.
   */
  private async fetchStockCandles(stock: UpstoxInstrument): Promise<Candle[] | null> {
    let candles = this.cachedCandles.get(stock.instrument_key);
    if (candles) return candles;

    candles = await this.seasonalityEngine.fetchDeepHistoricalData(stock.instrument_key);
    if (!candles || candles.length === 0) return null;

    this.cachedCandles.set(stock.instrument_key, candles);
    return candles;
  }

  /**
   * Main analysis — fetches data and calculates heatmaps.
   * Wrapped in NgZone.run so Angular detects all state changes.
   */
  async generateAnalysis() {
    if (this.selectedStocks.length === 0) return;

    this.isCalculating = true;
    this.errorMessage = '';
    this.results = [];
    this.indexResult = null;
    this.indexBestPeriods = null;
    this.bestPeriodsCache.clear();
    this.fetchProgress = '';
    this.cdr.detectChanges();

    try {
      const total = this.selectedStocks.length;

      for (let i = 0; i < total; i++) {
        const stock = this.selectedStocks[i];

        // Update progress in the UI
        this.ngZone.run(() => {
          this.fetchProgress = `Fetching ${stock.tradingsymbol} (${i + 1}/${total})...`;
          this.cdr.detectChanges();
        });

        const candles = await this.fetchStockCandles(stock);
        if (!candles) continue;

        const result = this.seasonalityEngine.calculateSeasonality(stock, candles, this.tableView);
        if (result) {
          this.results.push(result);
          // Cache best periods
          this.bestPeriodsCache.set(stock.instrument_key, this.computeBestPeriods(result));
        }
      }

      // Fetch index data if selected
      if (this.selectedIndex) {
        this.ngZone.run(() => {
          this.fetchProgress = `Fetching ${this.selectedIndex} index data...`;
          this.cdr.detectChanges();
        });
        await this.fetchIndexData();
      }

    } catch (error: any) {
       this.errorMessage = 'Analysis Failed: ' + error.message;
       console.error(error);
    } finally {
      // Use NgZone.run to guarantee Angular detects the final state change
      this.ngZone.run(() => {
        this.isCalculating = false;
        this.fetchProgress = '';
        this.cdr.detectChanges();
      });
    }
  }

  /**
   * Fetch index historical data and compute its seasonality
   */
  private async fetchIndexData() {
    const indexKey = INDEX_MAPPING[this.selectedIndex];
    if (!indexKey) return;

    try {
      let candles = this.cachedCandles.get(indexKey);
      if (!candles) {
        candles = await this.seasonalityEngine.fetchDeepHistoricalData(indexKey, 20);
        if (!candles || candles.length === 0) return;
        this.cachedCandles.set(indexKey, candles);
      }

      const pseudoInstrument: UpstoxInstrument = {
        instrument_key: indexKey, exchange_token: '',
        tradingsymbol: this.selectedIndex, name: this.selectedIndex,
        last_price: 0, expiry: '', strike: '', tick_size: '', lot_size: '',
        instrument_type: 'INDEX', option_type: '', exchange: 'NSE'
      };

      this.indexResult = this.seasonalityEngine.calculateSeasonality(pseudoInstrument, candles, this.tableView);
      if (this.indexResult) {
        this.indexBestPeriods = this.computeBestPeriods(this.indexResult);
      }
    } catch (err: any) {
      console.error('[Seasonality] Index fetch error:', err.message);
    }
  }

  /**
   * Instantly flips the UI view by recalculating from cached candle arrays.
   */
  onViewChange() {
      if (this.cachedCandles.size === 0 || this.selectedStocks.length === 0) return;

      this.isCalculating = true;
      this.cdr.detectChanges();

      // Use setTimeout so the spinner has a chance to render before blocking the main thread
      setTimeout(() => {
          this.results = this.selectedStocks
            .map(stock => {
              const candles = this.cachedCandles.get(stock.instrument_key);
              if (!candles) return null;
              return this.seasonalityEngine.calculateSeasonality(stock, candles, this.tableView);
            })
            .filter((r): r is SeasonalityResult => r !== null);

          // Rebuild best-periods cache
          this.bestPeriodsCache.clear();
          for (const result of this.results) {
            this.bestPeriodsCache.set(result.instrument.instrument_key, this.computeBestPeriods(result));
          }

          // Recalculate index
          if (this.selectedIndex && this.indexResult) {
            const indexKey = INDEX_MAPPING[this.selectedIndex];
            const indexCandles = this.cachedCandles.get(indexKey);
            if (indexCandles) {
              const pseudoInstrument: UpstoxInstrument = {
                instrument_key: indexKey, exchange_token: '',
                tradingsymbol: this.selectedIndex, name: this.selectedIndex,
                last_price: 0, expiry: '', strike: '', tick_size: '', lot_size: '',
                instrument_type: 'INDEX', option_type: '', exchange: 'NSE'
              };
              this.indexResult = this.seasonalityEngine.calculateSeasonality(pseudoInstrument, indexCandles, this.tableView);
              if (this.indexResult) {
                this.indexBestPeriods = this.computeBestPeriods(this.indexResult);
              }
            }
          }

          this.isCalculating = false;
          this.cdr.detectChanges();
      }, 50);
  }

  // ── Feature 1: Best Periods ─────────────────────────

  /**
   * Returns cached best periods for a result (avoids recomputation on every CD cycle).
   */
  getBestPeriods(result: SeasonalityResult): { bullish: BestPeriodEntry[], bearish: BestPeriodEntry[] } {
    const cached = this.bestPeriodsCache.get(result.instrument.instrument_key);
    if (cached) return cached;

    const computed = this.computeBestPeriods(result);
    this.bestPeriodsCache.set(result.instrument.instrument_key, computed);
    return computed;
  }

  /**
   * Computes periods where positive probability >= 75% (bullish)
   * or negative probability >= 75% (bearish).
   */
  private computeBestPeriods(result: SeasonalityResult): { bullish: BestPeriodEntry[], bearish: BestPeriodEntry[] } {
    const bullish: BestPeriodEntry[] = [];
    const bearish: BestPeriodEntry[] = [];

    result.periodMetrics.forEach((m, i) => {
      const entry: BestPeriodEntry = {
        periodLabel: m.periodLabel,
        periodIndex: i,
        averageReturn: m.averageReturn,
        positiveProbability: m.positiveProbability,
        negativeProbability: m.negativeProbability
      };

      if (m.positiveProbability >= 75) bullish.push(entry);
      if (m.negativeProbability >= 75) bearish.push(entry);
    });

    bullish.sort((a, b) => b.positiveProbability - a.positiveProbability);
    bearish.sort((a, b) => b.negativeProbability - a.negativeProbability);

    return { bullish, bearish };
  }

  // ── Feature 3: Screener ─────────────────────────────
  async runScreener() {
    if (!this.screenerIndex) return;

    this.isScreenerRunning = true;
    this.screenerHasRun = false;
    this.screenerError = '';
    this.screenerBullish = [];
    this.screenerBearish = [];
    this.screenerProgress = '';
    this.cdr.detectChanges();

    try {
      const stocks = this.getIndexStocks(this.screenerIndex);

      if (stocks.length === 0) {
        this.screenerError = `No stocks mapped for ${this.screenerIndex}. Try a sector-specific index.`;
        this.isScreenerRunning = false;
        this.cdr.detectChanges();
        return;
      }

      const allResults: SeasonalityResult[] = [];
      const total = stocks.length;

      // Process stocks ONE AT A TIME to stay within Upstox API rate limits.
      // The service layer adds 250ms throttle + exponential backoff on 429s,
      // but sequential processing avoids multiplying concurrent load.
      for (let i = 0; i < total; i++) {
        const stock = stocks[i];

        // Update progress with current stock name
        this.ngZone.run(() => {
          this.screenerProgress = `Scanning ${stock.tradingsymbol} (${i + 1}/${total})...`;
          this.cdr.detectChanges();
        });

        try {
          const candles = await this.fetchStockCandles(stock);
          if (!candles) continue;
          const result = this.seasonalityEngine.calculateSeasonality(stock, candles, this.screenerPeriod);
          if (result) allResults.push(result);
        } catch (err: any) {
          console.warn(`[Screener] Skipping ${stock.tradingsymbol}: ${err.message}`);
        // Continue with next stock instead of aborting the entire screener
        }
      }

      // Filter for the specific period index
      const pIdx = this.screenerPeriodIndex;

      for (const result of allResults) {
        const metric = result.periodMetrics[pIdx];
        if (!metric) continue;

        const latestYear = result.yearsData[result.yearsData.length - 1];
        const periodToDate = latestYear?.dataPoints[pIdx]?.percentageChange ?? 0;

        const candles = this.cachedCandles.get(result.instrument.instrument_key);
        const currentPrice = candles && candles.length > 0 ? candles[candles.length - 1].close : 0;

        const allReturns = result.yearsData
          .map(y => y.dataPoints[pIdx]?.percentageChange)
          .filter((v): v is number => v !== undefined && v !== 0);

        const positiveReturns = allReturns.filter(v => v > 0);

        const maxPos = positiveReturns.length > 0 ? Math.max(...positiveReturns) : 0;
        const avgPos = positiveReturns.length > 0 ? positiveReturns.reduce((a, b) => a + b, 0) / positiveReturns.length : 0;
        const minPos = positiveReturns.length > 0 ? Math.min(...positiveReturns) : 0;

        const stockEntry: ScreenerStock = {
          instrument: result.instrument,
          positiveProbability: metric.positiveProbability,
          negativeProbability: metric.negativeProbability,
          periodToDate,
          maxPositive: maxPos,
          avgPositive: avgPos,
          minPositive: minPos,
          currentPrice
        };

        if (metric.positiveProbability >= 75) this.screenerBullish.push(stockEntry);
        if (metric.negativeProbability >= 75) this.screenerBearish.push(stockEntry);
      }

      this.screenerBullish.sort((a, b) => b.positiveProbability - a.positiveProbability);
      this.screenerBearish.sort((a, b) => b.negativeProbability - a.negativeProbability);

    } catch (err: any) {
      this.screenerError = 'Screener failed: ' + err.message;
      console.error(err);
    } finally {
      this.ngZone.run(() => {
        this.isScreenerRunning = false;
        this.screenerHasRun = true;
        this.screenerProgress = '';
        this.cdr.detectChanges();
      });
    }
  }

  /**
   * Gets constituent stocks for an index from our available instrument list.
   */
  private getIndexStocks(indexName: string): UpstoxInstrument[] {
    const symbols = INDEX_CONSTITUENTS[indexName];
    if (!symbols || symbols.length === 0) return [];
    const symbolSet = new Set(symbols);
    return this.allStocks.filter(s => symbolSet.has(s.tradingsymbol));
  }

  getCellStyle(percent: number, startPrice: number): any {
     if (startPrice === 0) return { 'background-color': '#f9fafb', 'color': '#9ca3af' };

     if (percent >= 15) return { 'background-color': '#16a34a', 'color': 'white', 'font-weight': 'bold' };
     if (percent >= 10) return { 'background-color': '#22c55e', 'color': 'white', 'font-weight': 'bold' };
     if (percent >= 5)  return { 'background-color': '#86efac', 'color': '#14532d', 'font-weight': '600' };
     if (percent > 0)   return { 'background-color': '#dcfce3', 'color': '#166534' };

     if (percent <= -15) return { 'background-color': '#dc2626', 'color': 'white', 'font-weight': 'bold' };
     if (percent <= -10) return { 'background-color': '#ef4444', 'color': 'white', 'font-weight': 'bold' };
     if (percent <= -5)  return { 'background-color': '#fca5a5', 'color': '#7f1d1d', 'font-weight': '600' };
     if (percent < 0)    return { 'background-color': '#fee2e2', 'color': '#991b1b' };

     return { 'background-color': '#f3f4f6', 'color': '#4b5563' };
  }
}
