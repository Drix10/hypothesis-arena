/**
 * Trading System Type Definitions
 * 
 * Complete, production-ready data models for the Agent Trading System
 * with all edge cases and validations handled.
 */

import { AnalystMethodology } from './stock';

// ═══════════════════════════════════════════════════════════════════════════════
// CORE PORTFOLIO MODELS
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentPortfolio {
    agentId: string;
    agentName: string;
    methodology: AnalystMethodology;

    // Account info
    initialCash: number;
    currentCash: number;
    reservedCash: number;
    totalValue: number;

    // Performance metrics (sharpeRatio is nullable - null means not yet calculated, requires 30+ data points)
    totalReturn: number;
    totalReturnDollar: number;
    winRate: number;
    sharpeRatio: number | null;
    maxDrawdown: number;
    currentDrawdown: number;
    peakValue: number;
    volatility: number;

    // Trade statistics
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;

    // Positions
    positions: Position[];
    pendingOrders: PendingOrder[];

    // History
    trades: Trade[];
    corporateActions: CorporateAction[];
    errorLog: ErrorLog[];
    performanceHistory: PerformanceSnapshot[];

    // Metadata
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'paused' | 'liquidated';
    lastTradeAt: number | null;
}

export interface Position {
    ticker: string;
    shares: number;
    avgCostBasis: number;
    currentPrice: number;
    lastPriceUpdate: number;
    marketValue: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    openedAt: number;
    totalCostBasis: number;
    realizedPnL: number;
    highWaterMark: number;
    drawdownFromHigh: number;
    lastUpdated: number;
    sector?: string;
}

export interface PendingOrder {
    id: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    createdAt: number;
    expiresAt: number;
    reason: string;
    thesisId?: string;
    debateId?: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;
    status: 'pending' | 'executed' | 'cancelled' | 'expired';
    executedAt?: number;
    executedPrice?: number;
    cancelReason?: string;
}

export interface Trade {
    id: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    price: number;
    totalValue: number;
    commission: number;
    timestamp: number;
    marketStatus: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';
    priceTimestamp: number;
    priceDelay: number;
    thesisId?: string;
    debateId?: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;
    realizedPnL?: number;
    realizedPnLPercent?: number;
    holdingPeriodDays?: number;
    isValid: boolean;
    validationWarnings: string[];
    executionMethod: 'IMMEDIATE' | 'PENDING_ORDER';
    relatedTradeIds?: string[];
}

export interface SpinoffDetails {
    parentTicker: string;
    spinoffTicker: string;
    ratio: number;
    parentSharesRetained: number;
    spinoffSharesReceived: number;
}

export interface CorporateAction {
    id: string;
    ticker: string;
    type: 'SPLIT' | 'DIVIDEND' | 'MERGER' | 'TICKER_CHANGE' | 'DELISTING' | 'SPINOFF';
    effectiveDate: number;
    announcedDate: number;
    details: SplitDetails | DividendDetails | MergerDetails | TickerChangeDetails | DelistingDetails | SpinoffDetails;
    processed: boolean;
    processedAt?: number;
    affectedPositions: string[];
}

export interface SplitDetails {
    ratio: number;
    oldShares: number;
    newShares: number;
    oldCostBasis: number;
    newCostBasis: number;
}

export interface DividendDetails {
    amountPerShare: number;
    totalAmount: number;
    exDate: number;
    payDate: number;
    dividendType: 'CASH' | 'STOCK';
}

export interface MergerDetails {
    acquirerTicker: string;
    exchangeRatio: number;
    cashComponent?: number;
    newTicker?: string;
}

export interface TickerChangeDetails {
    oldTicker: string;
    newTicker: string;
    reason: string;
}

export interface DelistingDetails {
    reason: 'BANKRUPTCY' | 'MERGER' | 'PRIVATIZATION' | 'NON_COMPLIANCE';
    finalPrice: number;
    settlementDate: number;
}

export interface PerformanceSnapshot {
    timestamp: number;
    totalValue: number;
    cash: number;
    positionsValue: number;
    totalReturn: number;
    dailyReturn: number;
    volatility: number;
    sharpeRatio: number | null;  // Nullable to match AgentPortfolio.sharpeRatio
    maxDrawdown: number;
    currentDrawdown: number;
    spyPrice?: number;
    spyReturn?: number;
    alpha?: number;
    beta?: number;
    numPositions: number;
    largestPosition: string;
    largestPositionPercent: number;
    sectorExposure?: Record<string, number>;
}

export interface ErrorLog {
    id: string;
    timestamp: number;
    code: TradingErrorCode;
    message: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    context?: any;
    resolved: boolean;
    resolvedAt?: number;
}

export enum TradingErrorCode {
    INSUFFICIENT_CASH = 'INSUFFICIENT_CASH',
    INVALID_PRICE = 'INVALID_PRICE',
    MARKET_CLOSED = 'MARKET_CLOSED',
    POSITION_LIMIT = 'POSITION_LIMIT',
    STORAGE_FULL = 'STORAGE_FULL',
    DATA_CORRUPTION = 'DATA_CORRUPTION',
    API_FAILURE = 'API_FAILURE',
    STALE_PRICE = 'STALE_PRICE',
    INVALID_SHARES = 'INVALID_SHARES',
    POSITION_NOT_FOUND = 'POSITION_NOT_FOUND',
    DUPLICATE_TRADE = 'DUPLICATE_TRADE',
    CORPORATE_ACTION_FAILED = 'CORPORATE_ACTION_FAILED'
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET STATUS
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketStatus {
    isOpen: boolean;
    currentStatus: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';
    nextOpen: number;
    nextClose: number;
    reason?: 'weekend' | 'holiday' | 'after_hours' | 'pre_market';
    holidayName?: string;
}

export interface PriceValidation {
    ticker: string;
    price: number;
    timestamp: number;
    ageSeconds: number;
    isStale: boolean;
    isSuspicious: boolean;
    warning?: string;
    source: 'FMP' | 'YAHOO' | 'CACHE';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADING SYSTEM STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradingSystemState {
    version: number;
    isEnabled: boolean;
    portfolios: Record<string, AgentPortfolio>;
    positionSizingRules: PositionSizingRules;
    riskManagementRules: RiskManagementRules;
    leaderboard: LeaderboardEntry[];
    startDate: number;
    lastUpdated: number;
    lastBackup: number;
    dataIntegrityHash: string;
    totalTrades: number;
    totalVolume: number;
    mostTradedStocks: Record<string, number>;
    systemErrors: number;
}

export interface PositionSizingRules {
    maxPositionPercent: number;
    maxTotalInvested: number;
    minTradeValue: number;
    maxPositionsPerAgent: number;
    reserveCashPercent: number;
    maxSectorExposure: number;
}

export interface RiskManagementRules {
    stopLossPercent: number;
    takeProfitPercent: number;
    maxDrawdownBeforePause: number;
    maxDrawdownBeforeLiquidate: number;
    enableStopLoss: boolean;
    enableTakeProfit: boolean;
}

export interface LeaderboardEntry {
    agentId: string;
    agentName: string;
    methodology: AnalystMethodology;
    totalReturn: number;
    totalValue: number;
    winRate: number;
    tradesCount: number;
    sharpeRatio: number | null;
    maxDrawdown: number;
    rank: number;
    rankChange: number;
}

export interface TradeDecision {
    action: 'BUY' | 'SELL' | 'HOLD';
    ticker: string;
    shares: number;
    estimatedPrice: number;
    estimatedValue: number;
    confidence: number;
    reasoning: string[];
    warnings: string[];
    thesisId?: string;
    debateId?: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    isValid: boolean;
    validationErrors: string[];
}

export interface ClosedPosition {
    ticker: string;
    shares: number;
    costBasis: number;
    proceeds: number;
    realizedPnL: number;
    realizedPnLPercent: number;
    openDate: number;
    closeDate: number;
    holdingPeriodDays: number;
    openTrades: Trade[];
    closeTrades: Trade[];
}

export interface StorageMetadata {
    version: number;
    createdAt: number;
    lastModified: number;
    dataSize: number;
    compressionEnabled: boolean;
    backupCount: number;
    lastBackupAt: number;
    integrityChecksum: string;
}

export class TradingError extends Error {
    constructor(
        message: string,
        public code: TradingErrorCode,
        public recoverable: boolean,
        public context?: any
    ) {
        super(message);
        this.name = 'TradingError';
    }
}
