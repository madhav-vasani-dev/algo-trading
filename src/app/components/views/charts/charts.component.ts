import { Component, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChartModule } from 'primeng/chart';
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  ColorType, 
  Time, 
  CandlestickSeries, 
  LineSeries, 
  HistogramSeries 
} from 'lightweight-charts';

export interface OptionValue {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionStrikeData {
  CE: OptionValue;
  PE: OptionValue;
}

export interface FutureValue {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number;
}

export interface MergedCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atmStrike: number;
  callClose: number;
  putClose: number;
  future?: FutureValue;
  options: Record<string, OptionStrikeData>;
}

export interface DatasetIndex {
  months: string[];
  daysByMonth: Record<string, string[]>;
  summaryByDay: Record<string, any>;
}

@Component({
  selector: 'app-charts',
  standalone: true,
  imports: [CommonModule, FormsModule, ChartModule],
  templateUrl: './charts.component.html',
  styleUrls: ['./charts.component.scss']
})
export class ChartsComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mainChartContainer', { static: false }) mainChartContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('volumeChartContainer', { static: false }) volumeChartContainer!: ElementRef<HTMLDivElement>;

  // Available Symbols
  availableSymbols = [
    { label: 'Nifty 50', value: 'nifty_1min' },
    { label: 'BankNifty', value: 'banknifty_1min' }
  ];
  selectedSymbol: string = 'nifty_1min';

  // Dataset Index
  datasetIndex: DatasetIndex | null = null;
  availableMonths: string[] = [];
  selectedMonth: string = '';
  availableDays: string[] = [];
  selectedDay: string = ''; // Specific trading day YYYY-MM-DD

  // Timeframe options
  availableTimeframes = [
    { label: '1M', value: 1 },
    { label: '3M', value: 3 },
    { label: '5M', value: 5 },
    { label: '15M', value: 15 },
    { label: '30M', value: 30 },
    { label: '1H', value: 60 }
  ];
  selectedTimeframeMinutes: number = 1;

  // View Engine: PrimeNG Chart.js vs Lightweight Canvas
  chartEngine: 'PRIMENG' | 'LIGHTWEIGHT' = 'PRIMENG';

  // View modes
  viewMode: 'SPOT' | 'FUTURE' | 'SPOT_VS_FUTURE' | 'ATM_OPTIONS' | 'OPTION_STRIKE' = 'SPOT';
  selectedStrike: number = 0;
  availableStrikes: number[] = [];
  optionType: 'CE' | 'PE' | 'BOTH' = 'BOTH';

  // Data
  rawDayCandles: MergedCandle[] = [];
  filteredCandles: MergedCandle[] = [];
  isLoading: boolean = false;
  errorMessage: string = '';

  // PrimeNG Chart.js Data & Options
  primengMainData: any;
  primengMainOptions: any;
  primengSubData: any;
  primengSubOptions: any;

  // Stats
  hoveredCandle: MergedCandle | null = null;
  dayStats = {
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    change: 0,
    changePct: 0,
    totalVolume: 0,
    maxOI: 0,
    basis: 0,
    atmStrike: 0,
    straddlePremium: 0
  };

  // Lightweight Charts Instances
  private mainChart?: IChartApi;
  private volumeChart?: IChartApi;
  private spotCandleSeries?: ISeriesApi<'Candlestick'>;
  private futCandleSeries?: ISeriesApi<'Candlestick'>;
  private futLineSeries?: ISeriesApi<'Line'>;
  private spotLineSeries?: ISeriesApi<'Line'>;
  private callSeries?: ISeriesApi<'Line'>;
  private putSeries?: ISeriesApi<'Line'>;
  private optionCeCandleSeries?: ISeriesApi<'Candlestick'>;
  private volumeSeries?: ISeriesApi<'Histogram'>;
  private oiSeries?: ISeriesApi<'Line'>;

  private resizeObserver?: ResizeObserver;

  ngOnInit(): void {
    this.initPrimeNgChartOptions();
    this.loadDatasetIndex();
  }

  ngAfterViewInit(): void {
    if (this.chartEngine === 'LIGHTWEIGHT') {
      setTimeout(() => this.initLightweightCharts(), 100);
    }
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.mainChart) try { this.mainChart.remove(); } catch (e) {}
    if (this.volumeChart) try { this.volumeChart.remove(); } catch (e) {}
  }

  /**
   * Returns OHLC object for the currently selected View Mode
   * (Spot, Future, or Strike Option) for live ribbon hover display.
   */
  get activeOHLC() {
    const candle = this.hoveredCandle || (this.filteredCandles.length > 0 ? this.filteredCandles[this.filteredCandles.length - 1] : null);
    if (!candle) return { label: 'Spot', open: 0, high: 0, low: 0, close: 0 };

    if (this.viewMode === 'FUTURE' && candle.future) {
      return {
        label: 'Future',
        open: candle.future.open,
        high: candle.future.high,
        low: candle.future.low,
        close: candle.future.close
      };
    } else if (this.viewMode === 'OPTION_STRIKE' && candle.options && candle.options[String(this.selectedStrike)]) {
      const opt = candle.options[String(this.selectedStrike)];
      const target = (this.optionType === 'PE') ? opt.PE : opt.CE;
      if (target) {
        return {
          label: `${this.selectedStrike} ${this.optionType === 'PE' ? 'PE' : 'CE'}`,
          open: target.open,
          high: target.high,
          low: target.low,
          close: target.close
        };
      }
    }

    return {
      label: 'Spot',
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    };
  }

  private async fetchJsonData(relPath: string): Promise<any> {
    const ts = Date.now();
    const candidatePaths = [
      `/data/${this.selectedSymbol}/${relPath}?v=${ts}`,
      `data/${this.selectedSymbol}/${relPath}?v=${ts}`,
      `./data/${this.selectedSymbol}/${relPath}?v=${ts}`,
      `/algo-trading/data/${this.selectedSymbol}/${relPath}?v=${ts}`
    ];

    let lastErr = '';
    for (const p of candidatePaths) {
      try {
        const res = await fetch(p);
        if (res.ok) {
          const text = await res.text();
          if (text && !text.trim().startsWith('<')) {
            return JSON.parse(text);
          } else {
            lastErr = 'Dev server returned HTML fallback instead of JSON asset';
          }
        }
      } catch (e: any) {
        lastErr = e.message;
      }
    }
    throw new Error(`Data file not loaded (${lastErr || '404 Not Found'}). Please restart dev server ('npm start').`);
  }

  private getIstSeconds(timestampStr: string): number {
    if (!timestampStr) return 0;
    const parts = timestampStr.split('T');
    const datePart = parts[0];
    const timePart = parts[1] ? parts[1].split('+')[0].split('-')[0] : '00:00:00';
    const [y, m, d] = datePart.split('-').map(Number);
    const [h, min, sec] = timePart.split(':').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d, h, min, sec || 0) / 1000);
  }

  formatDisplayTime(ts?: string): string {
    if (!ts) return '';
    const parts = ts.split('T');
    const d = parts[0];
    const t = parts[1] ? parts[1].split('+')[0] : '';
    return `${d} ${t}`;
  }

  private initPrimeNgChartOptions() {
    const textColor = '#94a3b8';
    const textColorSecondary = '#64748b';

    this.primengMainOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 150 },
      plugins: {
        legend: {
          labels: { color: textColor, font: { family: 'monospace', size: 12 } }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#0f172a',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: '#475569',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          ticks: { color: textColorSecondary, maxTicksLimit: 14, font: { size: 10 } },
          grid: { color: 'rgba(51, 65, 85, 0.3)' }
        },
        y: {
          ticks: { color: textColorSecondary, font: { size: 10 } },
          grid: { color: 'rgba(51, 65, 85, 0.3)' }
        }
      }
    };

    this.primengSubOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 150 },
      plugins: {
        legend: { labels: { color: textColor, font: { family: 'monospace', size: 11 } } },
        tooltip: { mode: 'index', intersect: false, backgroundColor: '#0f172a' }
      },
      scales: {
        x: { ticks: { color: textColorSecondary, maxTicksLimit: 14, font: { size: 10 } }, grid: { color: 'rgba(51, 65, 85, 0.3)' } },
        y: { ticks: { color: textColorSecondary, font: { size: 10 } }, grid: { color: 'rgba(51, 65, 85, 0.3)' } }
      }
    };
  }

  async loadDatasetIndex() {
    this.isLoading = true;
    this.errorMessage = '';

    try {
      this.datasetIndex = await this.fetchJsonData('index.json');
      this.availableMonths = this.datasetIndex?.months || [];
      if (this.availableMonths.length > 0) {
        this.selectedMonth = this.availableMonths.includes('2024-10') ? '2024-10' : this.availableMonths[0];
        this.updateAvailableDays();
      }
    } catch (err: any) {
      console.error('[ChartsComponent] Index load error:', err);
      this.errorMessage = `Could not load dataset index for ${this.selectedSymbol}: ${err.message}`;
      this.isLoading = false;
    }
  }

  onSymbolChange() {
    this.loadDatasetIndex();
  }

  onMonthChange() {
    this.updateAvailableDays();
  }

  private updateAvailableDays() {
    if (!this.datasetIndex || !this.selectedMonth) return;
    this.availableDays = this.datasetIndex.daysByMonth[this.selectedMonth] || [];
    if (this.availableDays.length > 0) {
      this.selectedDay = this.availableDays[0];
      this.loadDayData(this.selectedMonth, this.selectedDay);
    } else {
      this.selectedDay = '';
      this.rawDayCandles = [];
      this.filteredCandles = [];
      this.isLoading = false;
    }
  }

  async loadDayData(month: string, day: string) {
    if (!month || !day) return;
    this.isLoading = true;
    this.errorMessage = '';

    try {
      const data = await this.fetchJsonData(`${month}/${day}.json`);
      this.rawDayCandles = Array.isArray(data) ? data : [];
      this.onFilterChange();
    } catch (err: any) {
      console.error(`[ChartsComponent] Failed to load day data for ${day}:`, err);
      this.errorMessage = `Could not load day data for ${day}: ${err.message}`;
      this.rawDayCandles = [];
      this.filteredCandles = [];
    } finally {
      this.isLoading = false;
    }
  }

  onDayChange() {
    this.loadDayData(this.selectedMonth, this.selectedDay);
  }

  onTimeframeChange(minutes: number) {
    this.selectedTimeframeMinutes = minutes;
    this.onFilterChange();
  }

  onEngineChange(engine: 'PRIMENG' | 'LIGHTWEIGHT') {
    this.chartEngine = engine;
    if (engine === 'PRIMENG') {
      this.updatePrimeNgCharts();
    } else {
      setTimeout(() => this.initLightweightCharts(), 50);
    }
  }

  onFilterChange() {
    this.filteredCandles = this.resampleCandles(this.rawDayCandles, this.selectedTimeframeMinutes);

    if (this.filteredCandles.length > 0) {
      const strikesSet = new Set<number>();
      this.filteredCandles.forEach(c => {
        if (c.options) {
          Object.keys(c.options).forEach(s => strikesSet.add(Number(s)));
        }
      });
      this.availableStrikes = Array.from(strikesSet).sort((a, b) => a - b);
      const atm = this.filteredCandles[0].atmStrike || Math.round(this.filteredCandles[0].close / 50) * 50;
      this.selectedStrike = this.availableStrikes.includes(atm) ? atm : (this.availableStrikes[Math.floor(this.availableStrikes.length / 2)] || 0);

      this.computeDayStats();
    }

    if (this.chartEngine === 'PRIMENG') {
      this.updatePrimeNgCharts();
    } else {
      setTimeout(() => {
        this.initLightweightCharts();
      }, 50);
    }
  }

  private resampleCandles(candles: MergedCandle[], timeframeMinutes: number): MergedCandle[] {
    if (timeframeMinutes <= 1 || candles.length === 0) return candles;

    const resampled: MergedCandle[] = [];
    const chunkSize = timeframeMinutes;

    for (let i = 0; i < candles.length; i += chunkSize) {
      const chunk = candles.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;

      const first = chunk[0];
      const last = chunk[chunk.length - 1];

      let maxHigh = first.high;
      let minLow = first.low;
      let totVol = 0;

      let futMaxHigh = first.future ? first.future.high : first.high;
      let futMinLow = first.future ? first.future.low : first.low;
      let futTotVol = 0;

      const optionsAgg: Record<string, OptionStrikeData> = {};
      if (first.options) {
        Object.keys(first.options).forEach(strike => {
          let ceOpen = first.options[strike]?.CE?.open || 0;
          let ceHigh = first.options[strike]?.CE?.high || 0;
          let ceLow = first.options[strike]?.CE?.low || 0;
          let ceClose = last.options[strike]?.CE?.close || 0;
          let ceVol = 0;

          let peOpen = first.options[strike]?.PE?.open || 0;
          let peHigh = first.options[strike]?.PE?.high || 0;
          let peLow = first.options[strike]?.PE?.low || 0;
          let peClose = last.options[strike]?.PE?.close || 0;
          let peVol = 0;

          chunk.forEach(c => {
            if (c.options && c.options[strike]) {
              const opt = c.options[strike];
              if (opt.CE) {
                if (opt.CE.high > ceHigh) ceHigh = opt.CE.high;
                if (opt.CE.low < ceLow || ceLow === 0) ceLow = opt.CE.low;
                ceVol += opt.CE.volume || 0;
              }
              if (opt.PE) {
                if (opt.PE.high > peHigh) peHigh = opt.PE.high;
                if (opt.PE.low < peLow || peLow === 0) peLow = opt.PE.low;
                peVol += opt.PE.volume || 0;
              }
            }
          });

          optionsAgg[strike] = {
            CE: { open: ceOpen, high: ceHigh, low: ceLow, close: ceClose, volume: ceVol },
            PE: { open: peOpen, high: peHigh, low: peLow, close: peClose, volume: peVol }
          };
        });
      }

      chunk.forEach(c => {
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.low < minLow) minLow = c.low;
        totVol += c.volume || 0;

        if (c.future) {
          if (c.future.high > futMaxHigh) futMaxHigh = c.future.high;
          if (c.future.low < futMinLow) futMinLow = c.future.low;
          futTotVol += c.future.volume || 0;
        }
      });

      const futureObj = first.future ? {
        open: first.future.open,
        high: futMaxHigh,
        low: futMinLow,
        close: last.future ? last.future.close : last.close,
        volume: futTotVol,
        openInterest: last.future ? last.future.openInterest : 0
      } : undefined;

      resampled.push({
        timestamp: first.timestamp,
        open: first.open,
        high: maxHigh,
        low: minLow,
        close: last.close,
        volume: totVol,
        atmStrike: last.atmStrike || Math.round(last.close / 50) * 50,
        callClose: last.callClose || 0,
        putClose: last.putClose || 0,
        future: futureObj,
        options: optionsAgg
      });
    }

    return resampled;
  }

  private computeDayStats() {
    if (this.filteredCandles.length === 0) return;
    const first = this.filteredCandles[0];
    const last = this.filteredCandles[this.filteredCandles.length - 1];

    let maxHigh = first.high;
    let minLow = first.low;
    let totVol = 0;
    let maxOi = 0;

    this.filteredCandles.forEach(c => {
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;
      totVol += c.volume || 0;
      if (c.future && c.future.openInterest > maxOi) maxOi = c.future.openInterest;
    });

    const chg = last.close - first.open;
    const chgPct = (chg / first.open) * 100;
    const futClose = last.future ? last.future.close : last.close;
    const basis = futClose - last.close;

    this.dayStats = {
      open: first.open,
      high: maxHigh,
      low: minLow,
      close: last.close,
      change: chg,
      changePct: chgPct,
      totalVolume: totVol,
      maxOI: maxOi,
      basis: basis,
      atmStrike: last.atmStrike || Math.round(last.close / 50) * 50,
      straddlePremium: (last.callClose || 0) + (last.putClose || 0)
    };
  }

  // --- PrimeNG Chart.js Renderer ---

  private updatePrimeNgCharts() {
    if (this.filteredCandles.length === 0) return;

    const step = Math.max(1, Math.floor(this.filteredCandles.length / 50));
    const labels = this.filteredCandles.map((c, idx) => {
      const timeStr = c.timestamp.split('T')[1]?.substring(0, 5) || '';
      return (idx % step === 0) ? timeStr : '';
    });

    if (this.viewMode === 'SPOT') {
      this.primengMainData = {
        labels,
        datasets: [
          {
            type: 'line',
            label: 'Spot Close',
            data: this.filteredCandles.map(c => c.close),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            fill: true,
            tension: 0.1,
            pointRadius: 0
          },
          {
            type: 'line',
            label: 'Spot Open',
            data: this.filteredCandles.map(c => c.open),
            borderColor: '#38bdf8',
            borderDash: [4, 4],
            fill: false,
            tension: 0.1,
            pointRadius: 0
          },
          {
            type: 'line',
            label: 'Spot High',
            data: this.filteredCandles.map(c => c.high),
            borderColor: 'rgba(52, 211, 153, 0.4)',
            borderDash: [2, 2],
            fill: false,
            pointRadius: 0
          },
          {
            type: 'line',
            label: 'Spot Low',
            data: this.filteredCandles.map(c => c.low),
            borderColor: 'rgba(248, 113, 113, 0.4)',
            borderDash: [2, 2],
            fill: false,
            pointRadius: 0
          }
        ]
      };

      this.primengSubData = {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Spot Volume',
            data: this.filteredCandles.map(c => c.volume),
            backgroundColor: 'rgba(59, 130, 246, 0.6)'
          }
        ]
      };

    } else if (this.viewMode === 'FUTURE') {
      this.primengMainData = {
        labels,
        datasets: [
          {
            type: 'line',
            label: 'Future Close',
            data: this.filteredCandles.map(c => c.future ? c.future.close : c.close),
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            fill: true,
            tension: 0.1,
            pointRadius: 0
          },
          {
            type: 'line',
            label: 'Future Open',
            data: this.filteredCandles.map(c => c.future ? c.future.open : c.open),
            borderColor: '#38bdf8',
            borderDash: [4, 4],
            fill: false,
            tension: 0.1,
            pointRadius: 0
          }
        ]
      };

      this.primengSubData = {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Futures Volume',
            data: this.filteredCandles.map(c => c.future ? c.future.volume : 0),
            backgroundColor: 'rgba(6, 182, 212, 0.5)'
          },
          {
            type: 'line',
            label: 'Open Interest (OI)',
            data: this.filteredCandles.map(c => c.future ? c.future.openInterest : 0),
            borderColor: '#eab308',
            borderWidth: 2,
            pointRadius: 0
          }
        ]
      };

    } else if (this.viewMode === 'SPOT_VS_FUTURE') {
      this.primengMainData = {
        labels,
        datasets: [
          {
            label: 'Spot Price',
            data: this.filteredCandles.map(c => c.close),
            borderColor: '#f59e0b',
            borderWidth: 2,
            pointRadius: 0
          },
          {
            label: 'Future Price',
            data: this.filteredCandles.map(c => c.future ? c.future.close : c.close),
            borderColor: '#06b6d4',
            borderWidth: 2,
            pointRadius: 0
          }
        ]
      };

      this.primengSubData = {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Basis (Future - Spot)',
            data: this.filteredCandles.map(c => {
              const fut = c.future ? c.future.close : c.close;
              return parseFloat((fut - c.close).toFixed(2));
            }),
            backgroundColor: this.filteredCandles.map(c => {
              const fut = c.future ? c.future.close : c.close;
              return (fut >= c.close) ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)';
            })
          }
        ]
      };

    } else if (this.viewMode === 'ATM_OPTIONS') {
      this.primengMainData = {
        labels,
        datasets: [
          {
            label: 'ATM Call Close',
            data: this.filteredCandles.map(c => c.callClose || 0),
            borderColor: '#10b981',
            borderWidth: 2,
            pointRadius: 0
          },
          {
            label: 'ATM Put Close',
            data: this.filteredCandles.map(c => c.putClose || 0),
            borderColor: '#f43f5e',
            borderWidth: 2,
            pointRadius: 0
          },
          {
            label: 'ATM Straddle (Call + Put)',
            data: this.filteredCandles.map(c => parseFloat(((c.callClose || 0) + (c.putClose || 0)).toFixed(2))),
            borderColor: '#a855f7',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0
          }
        ]
      };

      this.primengSubData = {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Total Volume',
            data: this.filteredCandles.map(c => c.volume),
            backgroundColor: 'rgba(168, 85, 247, 0.5)'
          }
        ]
      };

    } else if (this.viewMode === 'OPTION_STRIKE') {
      const strikeStr = String(this.selectedStrike);
      const datasets: any[] = [];

      if (this.optionType === 'CE' || this.optionType === 'BOTH') {
        datasets.push({
          label: `${strikeStr} CE Close`,
          data: this.filteredCandles.map(c => (c.options && c.options[strikeStr] && c.options[strikeStr].CE) ? c.options[strikeStr].CE.close : 0),
          borderColor: '#10b981',
          borderWidth: 2,
          pointRadius: 0
        });
      }

      if (this.optionType === 'PE' || this.optionType === 'BOTH') {
        datasets.push({
          label: `${strikeStr} PE Close`,
          data: this.filteredCandles.map(c => (c.options && c.options[strikeStr] && c.options[strikeStr].PE) ? c.options[strikeStr].PE.close : 0),
          borderColor: '#f43f5e',
          borderWidth: 2,
          pointRadius: 0
        });
      }

      this.primengMainData = { labels, datasets };

      this.primengSubData = {
        labels,
        datasets: [
          {
            type: 'bar',
            label: `${strikeStr} Volume`,
            data: this.filteredCandles.map(c => {
              const opt = (c.options && c.options[strikeStr]) ? c.options[strikeStr] : null;
              return opt ? ((opt.CE ? opt.CE.volume : 0) + (opt.PE ? opt.PE.volume : 0)) : 0;
            }),
            backgroundColor: 'rgba(16, 185, 129, 0.5)'
          }
        ]
      };
    }
  }

  // --- Lightweight Canvas Chart Renderer ---

  private initLightweightCharts() {
    if (!this.mainChartContainer || !this.volumeChartContainer) return;

    const mainEl = this.mainChartContainer.nativeElement;
    const volEl = this.volumeChartContainer.nativeElement;

    if (!mainEl || !volEl) return;

    if (this.mainChart) try { this.mainChart.remove(); } catch (e) {}
    if (this.volumeChart) try { this.volumeChart.remove(); } catch (e) {}

    const chartOptions = {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8'
      },
      grid: {
        vertLines: { color: 'rgba(51, 65, 85, 0.4)' },
        horzLines: { color: 'rgba(51, 65, 85, 0.4)' }
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true, secondsVisible: false }
    };

    this.mainChart = createChart(mainEl, { ...chartOptions, height: 420 });
    this.volumeChart = createChart(volEl, { ...chartOptions, height: 140 });

    this.mainChart.timeScale().subscribeVisibleTimeRangeChange(timeRange => {
      if (timeRange && this.volumeChart) {
        this.volumeChart.timeScale().setVisibleRange(timeRange);
      }
    });

    this.mainChart.subscribeCrosshairMove(param => {
      if (param.time && this.filteredCandles.length > 0) {
        const timeSec = param.time as number;
        const matched = this.filteredCandles.find(c => this.getIstSeconds(c.timestamp) === timeSec);
        if (matched) this.hoveredCandle = matched;
      } else {
        this.hoveredCandle = null;
      }
    });

    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (this.mainChart) this.mainChart.applyOptions({ width });
        if (this.volumeChart) this.volumeChart.applyOptions({ width });
      }
    });
    this.resizeObserver.observe(mainEl);

    this.renderLightweightCharts();
  }

  private clearSeries() {
    if (!this.mainChart || !this.volumeChart) return;
    if (this.spotCandleSeries) { try { this.mainChart.removeSeries(this.spotCandleSeries); } catch (e) {} this.spotCandleSeries = undefined; }
    if (this.futCandleSeries) { try { this.mainChart.removeSeries(this.futCandleSeries); } catch (e) {} this.futCandleSeries = undefined; }
    if (this.futLineSeries) { try { this.mainChart.removeSeries(this.futLineSeries); } catch (e) {} this.futLineSeries = undefined; }
    if (this.spotLineSeries) { try { this.mainChart.removeSeries(this.spotLineSeries); } catch (e) {} this.spotLineSeries = undefined; }
    if (this.callSeries) { try { this.mainChart.removeSeries(this.callSeries); } catch (e) {} this.callSeries = undefined; }
    if (this.putSeries) { try { this.mainChart.removeSeries(this.putSeries); } catch (e) {} this.putSeries = undefined; }
    if (this.optionCeCandleSeries) { try { this.mainChart.removeSeries(this.optionCeCandleSeries); } catch (e) {} this.optionCeCandleSeries = undefined; }
    if (this.volumeSeries) { try { this.volumeChart.removeSeries(this.volumeSeries); } catch (e) {} this.volumeSeries = undefined; }
    if (this.oiSeries) { try { this.volumeChart.removeSeries(this.oiSeries); } catch (e) {} this.oiSeries = undefined; }
  }

  renderLightweightCharts() {
    if (!this.mainChart || !this.volumeChart || this.filteredCandles.length === 0) return;
    this.clearSeries();

    const times = this.filteredCandles.map(c => this.getIstSeconds(c.timestamp) as Time);

    if (this.viewMode === 'SPOT') {
      this.spotCandleSeries = this.mainChart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444'
      });
      this.spotCandleSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], open: c.open, high: c.high, low: c.low, close: c.close })));

      this.volumeSeries = this.volumeChart.addSeries(HistogramSeries, { color: '#3b82f6', priceFormat: { type: 'volume' } });
      this.volumeSeries.setData(this.filteredCandles.map((c, i) => ({
        time: times[i], value: c.volume, color: c.close >= c.open ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)'
      })));

    } else if (this.viewMode === 'FUTURE') {
      this.futCandleSeries = this.mainChart.addSeries(CandlestickSeries, {
        upColor: '#06b6d4', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#06b6d4', wickDownColor: '#f43f5e'
      });
      this.futCandleSeries.setData(this.filteredCandles.map((c, i) => {
        const f = c.future || c;
        return { time: times[i], open: f.open, high: f.high, low: f.low, close: f.close };
      }));

      this.volumeSeries = this.volumeChart.addSeries(HistogramSeries, { color: '#06b6d4', priceFormat: { type: 'volume' } });
      this.volumeSeries.setData(this.filteredCandles.map((c, i) => {
        const f = c.future || c;
        return { time: times[i], value: f.volume, color: f.close >= f.open ? 'rgba(6, 182, 212, 0.6)' : 'rgba(244, 63, 94, 0.6)' };
      }));

      this.oiSeries = this.volumeChart.addSeries(LineSeries, { color: '#eab308', lineWidth: 2, title: 'Open Interest' });
      this.oiSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: (c.future && c.future.openInterest) ? c.future.openInterest : 0 })));

    } else if (this.viewMode === 'SPOT_VS_FUTURE') {
      this.spotLineSeries = this.mainChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, title: 'Spot Price' });
      this.spotLineSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: c.close })));

      this.futLineSeries = this.mainChart.addSeries(LineSeries, { color: '#06b6d4', lineWidth: 2, title: 'Future Price' });
      this.futLineSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: c.future ? c.future.close : c.close })));

      this.volumeSeries = this.volumeChart.addSeries(HistogramSeries, { color: '#8b5cf6', title: 'Basis (Fut - Spot)' });
      this.volumeSeries.setData(this.filteredCandles.map((c, i) => {
        const b = (c.future ? c.future.close : c.close) - c.close;
        return { time: times[i], value: parseFloat(b.toFixed(2)), color: b >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)' };
      }));

    } else if (this.viewMode === 'ATM_OPTIONS') {
      this.callSeries = this.mainChart.addSeries(LineSeries, { color: '#10b981', lineWidth: 2, title: 'ATM Call Close' });
      this.callSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: c.callClose || 0 })));

      this.putSeries = this.mainChart.addSeries(LineSeries, { color: '#f43f5e', lineWidth: 2, title: 'ATM Put Close' });
      this.putSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: c.putClose || 0 })));

      this.spotLineSeries = this.mainChart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 2, title: 'ATM Straddle (CE + PE)' });
      this.spotLineSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: parseFloat(((c.callClose || 0) + (c.putClose || 0)).toFixed(2)) })));

      this.volumeSeries = this.volumeChart.addSeries(HistogramSeries, { color: '#a855f7' });
      this.volumeSeries.setData(this.filteredCandles.map((c, i) => ({ time: times[i], value: c.volume })));

    } else if (this.viewMode === 'OPTION_STRIKE') {
      const strikeStr = String(this.selectedStrike);

      if (this.optionType === 'CE' || this.optionType === 'BOTH') {
        this.optionCeCandleSeries = this.mainChart.addSeries(CandlestickSeries, {
          upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444', title: `${strikeStr} CE`
        });
        this.optionCeCandleSeries.setData(this.filteredCandles.map((c, i) => {
          const opt = (c.options && c.options[strikeStr] && c.options[strikeStr].CE) ? c.options[strikeStr].CE : { open: 0, high: 0, low: 0, close: 0, volume: 0 };
          return { time: times[i], open: opt.open, high: opt.high, low: opt.low, close: opt.close };
        }));
      }

      if (this.optionType === 'PE' || this.optionType === 'BOTH') {
        this.callSeries = this.mainChart.addSeries(LineSeries, { color: '#f43f5e', lineWidth: 2, title: `${strikeStr} PE Close` });
        this.callSeries.setData(this.filteredCandles.map((c, i) => {
          const opt = (c.options && c.options[strikeStr] && c.options[strikeStr].PE) ? c.options[strikeStr].PE : { open: 0, high: 0, low: 0, close: 0, volume: 0 };
          return { time: times[i], value: opt.close };
        }));
      }

      this.volumeSeries = this.volumeChart.addSeries(HistogramSeries, { color: '#10b981', priceFormat: { type: 'volume' } });
      this.volumeSeries.setData(this.filteredCandles.map((c, i) => {
        const opt = (c.options && c.options[strikeStr]) ? c.options[strikeStr] : null;
        const vol = opt ? ((opt.CE ? opt.CE.volume : 0) + (opt.PE ? opt.PE.volume : 0)) : 0;
        return { time: times[i], value: vol };
      }));
    }

    this.mainChart.timeScale().fitContent();
    this.volumeChart.timeScale().fitContent();
  }
}
