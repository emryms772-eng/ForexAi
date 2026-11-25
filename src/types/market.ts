export type MarketCategory = 'Metals' | 'Forex' | 'Synthetic' | 'Digital';

export type Timeframe = '1M' | '5M' | '15M' | '1H' | '4H';

export interface MarketInstrument {
  symbol: string;
  name: string;
  category: MarketCategory;
  decimals: number;
  basePrice: number;
  volatilityBps: number;
  description: string;
}

export interface OHLCVCandle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type FeedOrigin = 'live-api' | 'simulated-live';

export interface MarketCandlesResponse {
  symbol: string;
  timeframe: Timeframe;
  decimals: number;
  source: FeedOrigin;
  sourceLabel: string;
  candles: OHLCVCandle[];
}

export interface MarketTickEvent {
  symbol: string;
  timeframe: Timeframe;
  price: number;
  bid: number;
  ask: number;
  changePct: number;
  source: FeedOrigin;
  candle: OHLCVCandle;
  timestamp: number;
}

export interface WatchlistQuote {
  symbol: string;
  name: string;
  category: MarketCategory;
  decimals: number;
  price: number;
  changePct: number;
  high24h: number;
  low24h: number;
  structureHint?: string;
  recentPattern?: string;
}

export interface KeyLevel {
  id: string;
  price: number;
  type: 'Support' | 'Resistance';
  strength: 'Major' | 'Minor';
  touches: number;
  distancePct: number;
}

export interface PriceActionZone {
  id: string;
  kind: 'Demand OB' | 'Supply OB' | 'Bullish FVG' | 'Bearish FVG';
  low: number;
  high: number;
  midpoint: number;
  time: number;
  mitigated: boolean;
  distancePct: number;
}

export interface PriceActionMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
  kind: 'BOS' | 'CHoCH' | 'Sweep' | 'Engulfing' | 'PinBar';
}

export interface CandlePatternEvent {
  time: number;
  name: string;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  description: string;
}

export interface PriceActionSnapshot {
  trendStructure: 'Bullish (HH / HL)' | 'Bearish (LH / LL)' | 'Ranging / Choppy';
  latestStructureEvent: 'Bullish BOS' | 'Bearish BOS' | 'Bullish CHoCH' | 'Bearish CHoCH' | 'Inside Range';
  dealingRangeHigh: number;
  dealingRangeLow: number;
  equilibriumPrice: number;
  rangePositionPct: number;
  rangeZone: 'Discount' | 'Equilibrium' | 'Premium';
  avgCandleRange: number;
  avgRangePct: number;
  recentSweep: 'Buy-Side Sweep (Bearish)' | 'Sell-Side Sweep (Bullish)' | 'None';
  latestPattern: CandlePatternEvent | null;
  buyerPressurePct: number;
  unmitigatedFvgCount: number;
  activeOrderBlockCount: number;
}

export interface PriceActionAnalysisSummary {
  snapshot: PriceActionSnapshot;
  levels: KeyLevel[];
  zones: PriceActionZone[];
  markers: PriceActionMarker[];
  recentPatterns: CandlePatternEvent[];
}

export interface PriceActionSignalPlan {
  signal: 'BUY' | 'SELL' | 'WAIT';
  signalStrength: 'A+ Setup' | 'Standard' | 'Developing';
  setupType: string;
  triggerPattern: string;
  entryPrice: number;
  entryZone: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: string;
  invalidationReason: string;
  confluences: string[];
}

export interface TimeframeAlignmentItem {
  timeframe: Timeframe;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  structureEvent: string;
  rangeZone: string;
  note: string;
}

export type EntryTimingStatus =
  | 'ENTER_NOW'
  | 'WAIT_CANDLE_CLOSE'
  | 'WAIT_FOR_SETUP'
  | 'INVALIDATED'
  | 'MISSED';

export interface SignalEntryTiming {
  decision: EntryTimingStatus;
  headline: string;
  detail: string;
  closeCondition: string;
  candleCloseTime: number;
  candleTimeframe: Timeframe;
}

export interface AIPriceActionSignal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  signalTimeframe: Timeframe;
  analyzedAt: string;
  confirmedBarTime: number;
  confirmedBarCloseTime: number;
  isLockedToClosedBar: boolean;
  model: string;
  spotPriceAtSignal: number;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  priceActionNarrative: string;
  keyZonesExplanation: string;
  timeframeAlignment: TimeframeAlignmentItem[];
  plan: PriceActionSignalPlan;
}

export type AutoScanIntervalSec = 0 | 60 | 180 | 300;
export type AutoScanScope = 'active' | 'watchlist';

export interface AutoTradeConfig {
  autoTradeEnabled: boolean;
  autoScanIntervalSec: AutoScanIntervalSec;
  scanScope: AutoScanScope;
  riskPercentPerTrade: 0.5 | 1 | 2;
  ntfyAlertsEnabled: boolean;
  ntfyTopic: string;
  ntfyNotifyWait: boolean;
  ntfyAllScansInitialized?: boolean;
  smsAlertsEnabled: boolean;
  smsNotifyWait: boolean;
}

export interface NtfyConfigStatus {
  configured: boolean;
  serverUrl: string;
  topicMasked: string | null;
}

export interface SmsConfigStatus {
  configured: boolean;
  provider: 'twilio' | 'textbelt' | 'vonage' | 'none';
  recipientMasked: string | null;
}

export interface DemoPosition {
  id: string;
  signalId: string;
  symbol: string;
  timeframe: Timeframe;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  initialUnits: number;
  remainingUnits: number;
  tp1Hit: boolean;
  breakevenActive: boolean;
  realizedPartialPnl: number;
  unrealizedPnl: number;
  openedAt: string;
  setupType: string;
}

export type TradeCloseReason =
  | 'TP2 Hit'
  | 'Stop Loss'
  | 'Breakeven Stop'
  | 'Signal Reversal'
  | 'Manual Close';

export interface ClosedDemoTrade {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  units: number;
  realizedPnl: number;
  reason: TradeCloseReason;
  openedAt: string;
  closedAt: string;
}

export interface DemoAccountState {
  initialBalance: number;
  balance: number;
  openPositions: DemoPosition[];
  closedTrades: ClosedDemoTrade[];
  config: AutoTradeConfig;
}

export interface BacktestTrade {
  id: string;
  side: 'BUY' | 'SELL';
  setupType: string;
  trigger: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  exitPrice: number;
  exitReason: 'TP2 Hit' | 'Breakeven Stop' | 'Stop Loss' | 'End of Sample';
  tp1Hit: boolean;
  rMultiple: number;
  pnlUsd: number;
  equityAfter: number;
}

export interface BacktestSetupStats {
  setupType: string;
  trades: number;
  wins: number;
  winRatePct: number;
  netR: number;
  netPnlUsd: number;
}

export interface BacktestEquityPoint {
  time: number;
  equity: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  barsTested: number;
  fromTime: number;
  toTime: number;
  initialCapital: number;
  finalEquity: number;
  netReturnUsd: number;
  netReturnPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownPct: number;
  nonRepaintingVerified: boolean;
  appliedFilters?: string[];
  filterStats?: {
    candidatesEvaluated: number;
    rejectedByHtfBias: number;
    rejectedByPremiumDiscount: number;
    rejectedByDisplacement: number;
    qualifiedSetups: number;
  };
  setupBreakdown: BacktestSetupStats[];
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTrade[];
}

export interface AIBacktestReview {
  model: string;
  reviewedAt: string;
  verdict: 'Strong Edge' | 'Moderate Edge' | 'Needs Filtering';
  summary: string;
  bestPerformingPattern: string;
  keyWeakness: string;
  recommendations: string[];
}

export interface MarketScanResponse {
  scannedAt: string;
  confirmedBarTime: number;
  totalScanned: number;
  sniperSignals: AIPriceActionSignal[];
  watchSignals: AIPriceActionSignal[];
}
