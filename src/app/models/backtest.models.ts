export type TimeInterval = '1minute' | '5minute' | '15minute' | '30minute' | '60minute' | 'day' | 'week' | 'month';

export interface OptionDetails {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
  atmStrike?: number;
  callClose?: number;
  putClose?: number;
  options?: {
    [strike: string]: {
      CE: OptionDetails;
      PE: OptionDetails;
    };
  };
}

export interface MarketDataRequest {
  instrumentKey: string;
  interval: TimeInterval;
  fromDate: Date;
  toDate: Date;
}

export interface TradeSignal {
  type: 'BUY' | 'SELL' | 'HOLD';
  price?: number | undefined;
  reason?: string;
}

export interface TradePosition {
  entryTime: Date;
  entryPrice: number;
  type: 'LONG' | 'SHORT';
  quantity: number;
  status: 'OPEN' | 'CLOSED';
  exitTime?: Date;
  exitPrice?: number;
  pnl?: number; // Profit and Loss for this specific trade
  entrySpot?: number;
  exitSpot?: number;
  exitReason?: string;
  strikePrice?: number;
  stopLossPrice?: number;
  targetPrice?: number;
  isSlMovedToCost?: boolean;
  ceEntryPrice?: number;
  peEntryPrice?: number;
  ceExitPrice?: number;
  peExitPrice?: number;
  longOptionLots?: number;
  shortOptionLots?: number;
}

export interface BacktestConfig {
  initialCapital: number;
  instrumentKey: string;
  interval: TimeInterval;
  fromDate: Date;
  toDate: Date;
  strategyId: string;
  strategyParams?: any;
  // Slippage and Commission
  slippagePercent?: number; // e.g., 0.05%
  brokeragePerOrder?: number; // e.g., ₹20
}

export interface ORBParams {
  openingRangeMinutes: number; // e.g., 15, 30, 60
  direction: 'LONG' | 'SHORT' | 'BOTH';
  stopLossType: 'POINTS' | 'PERCENT' | 'OR_OPPOSITE' | 'ENTRY_CANDLE';
  stopLossValue: number;       // points or percent or buffer points
  takeProfitType: 'POINTS' | 'PERCENT' | 'OR_MULTIPLE' | 'SL_MULTIPLE';
  takeProfitValue: number;     // points, percent, or e.g., 1.5x range
  entryStartTime: string;      // e.g., "09:30"
  entryEndTime: string;        // e.g., "14:30"
  squareOffTime: string;       // e.g., "15:15"
  lotSize: number;             // e.g., 75
  numberOfLots: number;        // e.g., 1
  slippagePoints: number;      // e.g., 2.0
  brokerageFlat: number;       // e.g., 80
  tradeType?: 'SPOT' | 'OPTIONS'; // e.g., trade spot index or option premiums
  entryType?: 'MARKET' | 'RETEST' | 'REVERSION' | 'FVG'; // market or pullback limit entry or mean reversion opposite entry or FVG pullback entry
  maxTradesPerDay?: number;
  trailingStopLoss?: number;   // 0 to disable, or points trailing SL
  trailToCostAtFiftyPercentTarget?: boolean;
  maxTradesOnSLHit?: number;
  longOptionLots?: number;
  shortOptionLots?: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number; // Percentage
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  finalCapital: number;
  avgWin?: number;
  avgLoss?: number;
  winLossRatio?: number;
  recoveryFactor?: number;
  maxConsecutiveWins?: number;
  maxConsecutiveLosses?: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  metrics: BacktestMetrics;
  trades: TradePosition[];
  equityCurve: { time: Date; equity: number }[];
}

export interface SavedSimulation {
  id: string;
  runTime: string;
  name: string;
  result: BacktestResult;
}

// --- Seasonality Models ---
export interface UpstoxInstrument {
  instrument_key: string;
  exchange_token: string;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;
  strike: string;
  tick_size: string;
  lot_size: string;
  instrument_type: string;
  option_type: string;
  exchange: string;
}

export interface SeasonalityDataPoint {
  periodLabel: string; // e.g., "Jan", "Feb" or "Week 1", "Week 2"
  startPrice: number;
  endPrice: number;
  percentageChange: number;
}

export interface SeasonalityPeriodMetrics {
  periodLabel: string;
  averageReturn: number;
  positiveProbability: number; // e.g. 60% of years were positive this month
  negativeProbability: number;
}

export interface SeasonalityYearData {
  year: number;
  dataPoints: SeasonalityDataPoint[];
  yearlyReturn?: number; // Total return for the year
}

export interface SeasonalityResult {
  instrument: UpstoxInstrument;
  yearsData: SeasonalityYearData[];
  periodMetrics: SeasonalityPeriodMetrics[];
}

// --- Best Periods & Screener Models ---
export interface BestPeriodEntry {
  periodLabel: string;
  periodIndex: number;
  averageReturn: number;
  positiveProbability: number;
  negativeProbability: number;
}

export interface ScreenerStock {
  instrument: UpstoxInstrument;
  positiveProbability: number;
  negativeProbability: number;
  periodToDate: number;      // MTD / WTD / DTD (% change so far in current period)
  maxPositive: number;        // Best historical return for this period
  avgPositive: number;        // Average positive return
  minPositive: number;        // Smallest positive return (weakest bull case)
  currentPrice: number;
}
