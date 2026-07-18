import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MarketDataService } from '../../../services/market-data.service';
import { BacktestRunnerService } from '../../../services/backtest-runner.service';
import { BacktestConfig, BacktestResult, TimeInterval, SavedSimulation } from '../../../models/backtest.models';
import { Firestore, collection, doc, setDoc, deleteDoc, getDocs, query, orderBy } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { FirebaseAuthService } from '../../../services/firebase-auth.service';
import axios from 'axios';

@Component({
  selector: 'app-backtest',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './backtest.component.html',
  styleUrl: './backtest.component.scss'
})
export class BacktestComponent implements OnInit {

  // General Form Models
  dataSource: 'local' | 'upstox' = 'local';
  instrumentKey = 'NSE_INDEX|Nifty 50'; // Default Nifty 50
  interval: TimeInterval = '1minute'; // Default 1 minute for ORB
  fromDate: string = '2024-09-27'; // Default start date
  toDate: string = this.getDefaultToDate();
  initialCapital = 200000;
  strategyId = 'ORB'; // Default strategy Opening Range Breakout

  // ORB Specific Parameters
  openingRangeMinutes = 15;
  direction: 'LONG' | 'SHORT' | 'BOTH' = 'BOTH';
  stopLossType: 'POINTS' | 'PERCENT' | 'OR_OPPOSITE' | 'ENTRY_CANDLE' = 'ENTRY_CANDLE';
  stopLossValue = 2; // default points SL if POINTS is chosen
  takeProfitType: 'POINTS' | 'PERCENT' | 'OR_MULTIPLE' | 'SL_MULTIPLE' = 'SL_MULTIPLE';
  takeProfitValue = 2; // 2x range target by default
  entryStartTime = '09:30';
  entryEndTime = '15:29';
  squareOffTime = '15:29';
  lotSize = 65; // Nifty standard lot size
  numberOfLots = 1;
  longOptionLots = 1;
  shortOptionLots = 1;
  slippagePoints = 1.0;
  brokerageFlat = 250; // ₹20 * 4 orders flat brokerage per round trade (synthetic CE+PE)
  tradeType: 'SPOT' | 'OPTIONS' = 'OPTIONS';
  maxTradesPerDay = 3;
  trailingStopLoss = 0;
  trailToCostAtFiftyPercentTarget = false;
  maxTradesOnSLHit = 1;
  entryType: 'MARKET' | 'RETEST' | 'REVERSION' | 'FVG' = 'MARKET';

  // MACross Parameters (Fallback)
  maShortWindow = 9;
  maLongWindow = 21;
  
  // State
  isLoading = false;
  errorMessage = '';
  
  // Results
  lastResult: BacktestResult | null = null;
  savedSimulations: SavedSimulation[] = [];
  activeSavedSimId: string | null = null;

  // Firebase Firestore & Auth services
  private firestore = inject(Firestore);
  private auth = inject(Auth);
  private authService = inject(FirebaseAuthService);

  constructor(
    private marketData: MarketDataService,
    private backtestRunner: BacktestRunnerService
  ) {}

  ngOnInit(): void {
    this.loadSavedSimulations();
    // Listen to user logins/logouts to refresh the simulations list
    this.authService.user$.subscribe(() => {
      this.loadSavedSimulations();
    });
  }

  async loadSavedSimulations() {
    try {
      const data = localStorage.getItem('backtest_simulations_history');
      if (data) {
        this.savedSimulations = JSON.parse(data);
      }
    } catch (e) {
      console.error('Failed to load simulations history from localStorage', e);
    }

    const user = this.auth.currentUser;
    if (user) {
      try {
        const uid = user.uid;
        const colRef = collection(this.firestore, `users/${uid}/simulations`);
        const q = query(colRef, orderBy('runTime', 'desc'));
        const querySnapshot = await getDocs(q);
        const firestoreSims: SavedSimulation[] = [];
        querySnapshot.forEach(docSnap => {
          firestoreSims.push(docSnap.data() as SavedSimulation);
        });

        // Merge Firestore and localStorage, removing duplicates
        const merged = [...firestoreSims, ...this.savedSimulations];
        const unique = merged.filter((item, index, self) =>
          index === self.findIndex((t) => t.id === item.id)
        );
        this.savedSimulations = unique.slice(0, 30);
      } catch (e) {
        console.error('Failed to load simulations from Firestore', e);
      }
    }
  }

  async saveSimulation(result: BacktestResult) {
    try {
      const newSim: SavedSimulation = {
        id: Date.now().toString(),
        runTime: new Date().toISOString(),
        name: `${result.config.strategyId} - ${result.config.instrumentKey.split('|')[1]} (${result.config.strategyId === 'ORB' ? this.openingRangeMinutes + 'm' : 'MA'})`,
        result: result
      };

      this.savedSimulations.unshift(newSim);
      if (this.savedSimulations.length > 30) {
        this.savedSimulations = this.savedSimulations.slice(0, 30);
      }
      localStorage.setItem('backtest_simulations_history', JSON.stringify(this.savedSimulations));
      this.activeSavedSimId = newSim.id;

      const user = this.auth.currentUser;
      if (user) {
        const uid = user.uid;
        const docRef = doc(this.firestore, `users/${uid}/simulations/${newSim.id}`);
        const plainSim = JSON.parse(JSON.stringify(newSim));
        await setDoc(docRef, plainSim);
        console.log('[BacktestComponent] Saved simulation to Firestore:', newSim.id);
      }
    } catch (e) {
      console.error('Failed to save simulation', e);
    }
  }

  async deleteSimulation(id: string, event: Event) {
    event.stopPropagation();
    this.savedSimulations = this.savedSimulations.filter(s => s.id !== id);
    localStorage.setItem('backtest_simulations_history', JSON.stringify(this.savedSimulations));
    if (this.activeSavedSimId === id) {
      this.activeSavedSimId = null;
      this.lastResult = null;
    }

    const user = this.auth.currentUser;
    if (user) {
      try {
        const uid = user.uid;
        const docRef = doc(this.firestore, `users/${uid}/simulations/${id}`);
        await deleteDoc(docRef);
        console.log('[BacktestComponent] Deleted simulation from Firestore:', id);
      } catch (e) {
        console.error('Failed to delete simulation from Firestore', e);
      }
    }
  }

  viewSimulation(sim: SavedSimulation) {
    this.lastResult = sim.result;
    this.activeSavedSimId = sim.id;

    const cfg = sim.result.config;
    this.initialCapital = cfg.initialCapital;
    this.instrumentKey = cfg.instrumentKey;
    this.interval = cfg.interval;
    this.fromDate = new Date(cfg.fromDate).toISOString().split('T')[0];
    this.toDate = new Date(cfg.toDate).toISOString().split('T')[0];
    this.strategyId = cfg.strategyId;

    if (cfg.strategyId === 'ORB' && cfg.strategyParams) {
      const params = cfg.strategyParams;
      this.openingRangeMinutes = params.openingRangeMinutes;
      this.direction = params.direction;
      this.stopLossType = params.stopLossType;
      this.stopLossValue = params.stopLossValue;
      this.takeProfitType = params.takeProfitType;
      this.takeProfitValue = params.takeProfitValue;
      this.entryStartTime = params.entryStartTime;
      this.entryEndTime = params.entryEndTime;
      this.squareOffTime = params.squareOffTime;
      this.lotSize = params.lotSize;
      this.numberOfLots = params.numberOfLots;
      this.longOptionLots = params.longOptionLots !== undefined ? params.longOptionLots : 1;
      this.shortOptionLots = params.shortOptionLots !== undefined ? params.shortOptionLots : 0;
      this.slippagePoints = params.slippagePoints;
      this.brokerageFlat = params.brokerageFlat;
      this.tradeType = params.tradeType || 'OPTIONS';
      this.maxTradesPerDay = params.maxTradesPerDay || 1;
      this.trailingStopLoss = params.trailingStopLoss || 0;
      this.trailToCostAtFiftyPercentTarget = params.trailToCostAtFiftyPercentTarget || false;
      this.maxTradesOnSLHit = params.maxTradesOnSLHit || 1;
      this.entryType = params.entryType || 'MARKET';
    } else if (cfg.strategyId === 'MACross' && cfg.strategyParams) {
      this.maShortWindow = cfg.strategyParams.shortWindow;
      this.maLongWindow = cfg.strategyParams.longWindow;
    }
  }

  downloadTradeLogsCSV() {
    if (!this.lastResult || this.lastResult.trades.length === 0) return;

    const headers = [
      'Entry Time',
      'Position Type',
      'Strike Price',
      'Quantity (Lots)',
      'Long Option Lots',
      'Short Option Lots',
      'Entry Spot Price',
      'Entry Net Premium',
      'Call Entry Premium',
      'Put Entry Premium',
      'Exit Time',
      'Exit Spot Price',
      'Exit Net Premium',
      'Call Exit Premium',
      'Put Exit Premium',
      'Exit Reason',
      'Stop Loss Price (Spot)',
      'Target Price (Spot)',
      'Flat Brokerage',
      'Net P&L (INR)'
    ];

    const rows = this.lastResult.trades.map(trade => [
      trade.entryTime,
      trade.type,
      trade.strikePrice || '',
      `${trade.quantity} (${trade.quantity / (this.lotSize || 75)} Lots)`,
      trade.longOptionLots !== undefined ? trade.longOptionLots : (trade.quantity / (this.lotSize || 75)),
      trade.shortOptionLots !== undefined ? trade.shortOptionLots : 0,
      trade.entrySpot || '',
      trade.entryPrice,
      trade.ceEntryPrice || '',
      trade.peEntryPrice || '',
      trade.exitTime || '',
      trade.exitSpot || '',
      trade.exitPrice || '',
      trade.ceExitPrice || '',
      trade.peExitPrice || '',
      trade.exitReason || '',
      (trade as any).stopLossPrice || '',
      (trade as any).targetPrice || '',
      this.brokerageFlat,
      trade.pnl || 0
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `trade_logs_${this.lastResult.config.strategyId}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async runBacktest() {
    this.isLoading = true;
    this.errorMessage = '';
    this.lastResult = null;

    try {
      // 1. Construct the Config
      const config: BacktestConfig = {
        initialCapital: this.initialCapital,
        instrumentKey: this.instrumentKey,
        interval: this.interval,
        fromDate: new Date(this.fromDate),
        toDate: new Date(this.toDate),
        strategyId: this.strategyId,
        strategyParams: this.strategyId === 'ORB' ? {
          openingRangeMinutes: this.openingRangeMinutes,
          direction: this.direction,
          stopLossType: this.stopLossType,
          stopLossValue: this.stopLossValue,
          takeProfitType: this.takeProfitType,
          takeProfitValue: this.takeProfitValue,
          entryStartTime: this.entryStartTime,
          entryEndTime: this.entryEndTime,
          squareOffTime: this.squareOffTime,
          lotSize: this.lotSize,
          numberOfLots: this.numberOfLots,
          longOptionLots: this.longOptionLots,
          shortOptionLots: this.shortOptionLots,
          slippagePoints: this.slippagePoints,
          brokerageFlat: this.brokerageFlat,
          tradeType: this.tradeType,
          maxTradesPerDay: this.maxTradesPerDay,
          trailingStopLoss: this.trailingStopLoss,
          trailToCostAtFiftyPercentTarget: this.trailToCostAtFiftyPercentTarget,
          maxTradesOnSLHit: this.maxTradesOnSLHit,
          entryType: this.entryType
        } : {
          shortWindow: this.maShortWindow,
          longWindow: this.maLongWindow
        },
        brokeragePerOrder: 20,
        slippagePercent: 0.05
      };

      // 2. Fetch the Engine Data
      let candles: any[] = [];

      if (this.dataSource === 'local') {
        if (this.instrumentKey !== 'NSE_INDEX|Nifty 50') {
          throw new Error("Local offline backtest is only available for 'NSE_INDEX|Nifty 50'. Please connect Upstox and select Upstox API mode to test other instruments.");
        }
        if (this.interval !== '1minute') {
          throw new Error("Local offline backtest requires '1 Minute' interval. Please change the interval to 1 Minute.");
        }

        console.log('[BacktestComponent] Loading local offline monthly files...');

        const fromLimit = new Date(this.fromDate);
        const toLimit = new Date(this.toDate);
        toLimit.setHours(23, 59, 59, 999);

        const fromStr = this.fromDate; // 'YYYY-MM-DD'
        const toStr = this.toDate;     // 'YYYY-MM-DD'
        let loadedCandles: any[] = [];

        const fetchLocalJson = async (relPath: string) => {
          const ts = Date.now();
          const urls = [
            `/data/nifty_1min/${relPath}?v=${ts}`,
            `./data/nifty_1min/${relPath}?v=${ts}`,
            `/algo-trading/data/nifty_1min/${relPath}?v=${ts}`
          ];
          for (const url of urls) {
            try {
              const res = await axios.get(url);
              return res.data;
            } catch (e) {
              // try next
            }
          }
          throw new Error(`Could not load ${relPath}`);
        };

        try {
          const indexData = await fetchLocalJson('index.json');
          if (indexData && indexData.daysByMonth) {
            const monthsNeeded = this.getMonthsInRange(fromLimit, toLimit);
            for (const month of monthsNeeded) {
              const days = indexData.daysByMonth[month] || [];
              for (const day of days) {
                if (day >= fromStr && day <= toStr) {
                  try {
                    const data = await fetchLocalJson(`${month}/${day}.json`);
                    if (data && Array.isArray(data)) {
                      loadedCandles = loadedCandles.concat(data);
                    }
                  } catch (err) {
                    console.warn(`[BacktestComponent] Could not load daily file for ${day}. Skip.`);
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error('[BacktestComponent] Failed to load index.json or daily data:', err);
        }

        candles = loadedCandles
          .map(candle => ({
            ...candle,
            timestamp: new Date(candle.timestamp)
          }))
          .filter(c => c.timestamp >= fromLimit && c.timestamp <= toLimit);

        if (candles.length === 0) {
          throw new Error(`No local data found in the selected date range. Ensure you have run the downloader script to fetch options data.`);
        }
      } else {
        // Upstox API Mode
        candles = await this.marketData.getHistoricalData({
          instrumentKey: config.instrumentKey,
          interval: config.interval,
          fromDate: config.fromDate,
          toDate: config.toDate
        });
      }

      if (candles.length === 0) {
        throw new Error("No data returned for the selected configuration.");
      }

      // 3. Process the Data
      this.lastResult = this.backtestRunner.runBacktest(config, candles);
      this.saveSimulation(this.lastResult);

    } catch (error: any) {
      console.error(error);
      this.errorMessage = error.message || 'Failed to run backtest. Check console or verify your Upstox connection.';
    } finally {
      this.isLoading = false;
    }
  }

  // --- Date format helpers ---
  private getDefaultFromDate(): string {
    const d = new Date();
    d.setMonth(d.getMonth() - 6); // default to 6 months ago
    return d.toISOString().split('T')[0];
  }

  private getDefaultToDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  private getMonthsInRange(startDate: Date, endDate: Date): string[] {
    const months: string[] = [];
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    while (current <= end) {
      const year = current.getFullYear();
      const month = String(current.getMonth() + 1).padStart(2, '0');
      months.push(`${year}-${month}`);
      current.setMonth(current.getMonth() + 1);
    }
    return months;
  }
}
