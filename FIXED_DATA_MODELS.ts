/**
 * FIXED Trading System Data Models
 * 
 * This file contains the corrected and comprehensive data models
 * for the Agent Trading System, addressing all edge cases and issues
 * identified in the design critique.
 */

import { AnalystMethodology } from './types/stock';

// ═══════════════════════════════════════════════════════════════════════════════
// CORE PORTFOLIO MODELS (FIXED)
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentPortfolio {
    agentId: string;
    agentName: string;
    methodology: AnalystMethodology;

    // Account info
    initialCash: number; // $100,000
    currentCash: number; // Available cash
    reservedCash: number; // ADDED: Cash allocated to pending orders
    totalValue: number; // Cash + positions value

    // Performance metrics
    totalReturn: number; // Percentage
    totalReturnDollar: number; // Dollar amount
    winRate: number; // % of profitable closed positions
    sharpeRatio: number | null; // Risk-adjusted return (needs 30+ days)
    maxDrawdown: number; // Worst peak-to-trough decline

    // ADDED: Additional risk metrics
    currentDrawdown: number; // Current drawdown from peak
    peakValue: number; // All-time high portfolio value
    volatility: number; // Annualized volatility

    // ADDED: Trade statistics
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number; // Total wins / Total losses

    // Positions
    positions: Position[];

    // ADDED: Pending orders (for market closed scenarios)
    pendingOrders: PendingOrder[];

    // Trade history
    trades: Trade[];

    // ADDED: Corporate actions log
    corporateActions: CorporateAction[];

    // ADDED: Error log
    errorLog: ErrorLog[];

    // Performance history (daily snapshots)
    performanceHistory: PerformanceSnapshot[];

    // Metadata
    createdAt: number;
    updatedAt: number;

    // ADDED: Status tracking
    status: 'active' | 'paused' | 'liquidated'; // Liquidated if loses >80%
    lastTradeAt: number | null;
}

export interface Position {
    ticker: string;
    shares: number;
    avgCostBasis: number; // Average price paid per share
    currentPrice: number; // Latest market price
    lastPriceUpdate: number; // ADDED: Timestamp of price update
    marketValue: number; // shares × currentPrice
    unrealizedPnL: number; // (currentPrice - avgCostBasis) × shares
    unrealizedPnLPercent: number;
    openedAt: number; // Timestamp

    // ADDED: Position tracking
    totalCostBasis: number; // Total amount invested
    realizedPnL: number; // P&L from partial sells

    // ADDED: Risk metrics
    highWaterMark: number; // Highest price reached
    drawdownFromHigh: number; // % down from high

    // ADDED: Position metadata
    lastUpdated: number;
    sector?: string; // For sector concentration limits
}

// ═══════════════════════════════════════════════════════════════════════════════
// PENDING ORDERS (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PendingOrder {
    id: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    createdAt: number;
    expiresAt: number; // Auto-cancel after X days
    reason: string;

    // Context
    thesisId?: string;
    debateId?: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;

    // Status
    status: 'pending' | 'executed' | 'cancelled' | 'expired';
    executedAt?: number;
    executedPrice?: number;
    cancelReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE MODEL (ENHANCED)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Trade {
    id: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    price: number;
    totalValue: number; // shares × price
    commission: number; // $0 for now, but support for future
    timestamp: number;

    // ADDED: Market context
    marketStatus: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';
    priceTimestamp: number; // When price was fetched
    priceDelay: number; // Seconds between price fetch and trade

    // Context
    thesisId?: string; // Link to investment thesis
    debateId?: string; // Link to debate
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;

    // Result (for closed positions)
    realizedPnL?: number;
    realizedPnLPercent?: number;
    holdingPeriodDays?: number;

    // ADDED: Trade validation
    isValid: boolean; // False if price was stale or other issues
    validationWarnings: string[]; // Any warnings about the trade

    // ADDED: Execution details
    executionMethod: 'IMMEDIATE' | 'PENDING_ORDER';
    relatedTradeIds?: string[]; // For tracking position opens/closes
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORPORATE ACTIONS (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface CorporateAction {
    id: string;
    ticker: string;
    type: 'SPLIT' | 'DIVIDEND' | 'MERGER' | 'TICKER_CHANGE' | 'DELISTING' | 'SPINOFF';
    effectiveDate: number;
    announcedDate: number;
    details: SplitDetails | DividendDetails | MergerDetails | TickerChangeDetails | DelistingDetails;
    processed: boolean;
    processedAt?: number;
    affectedPositions: string[]; // Position IDs
}

export interface SplitDetails {
    ratio: number; // 2.0 for 2:1 split, 0.5 for 1:2 reverse split
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

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE SNAPSHOT (ENHANCED)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PerformanceSnapshot {
    timestamp: number;
    totalValue: number;
    cash: number;
    positionsValue: number;
    totalReturn: number;
    dailyReturn: number;

    // ADDED: Risk metrics
    volatility: number;
    sharpeRatio: number;
    maxDrawdown: number;
    currentDrawdown: number;

    // ADDED: Market context
    spyPrice?: number; // S&P 500 for comparison
    spyReturn?: number; // S&P 500 return for alpha calculation
    alpha?: number; // Return vs S&P 500
    beta?: number; // Correlation to S&P 500

    // ADDED: Position summary
    numPositions: number;
    largestPosition: string;
    largestPositionPercent: number;
    sectorExposure?: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET STATUS (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketStatus {
    isOpen: boolean;
    currentStatus: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';
    nextOpen: number; // Timestamp
    nextClose: number;
    reason?: 'weekend' | 'holiday' | 'after_hours' | 'pre_market';
    holidayName?: string;
}

export interface MarketHoliday {
    date: string; // YYYY-MM-DD
    name: string;
    marketClosed: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE VALIDATION (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PriceValidation {
    ticker: string;
    price: number;
    timestamp: number;
    ageSeconds: number;
    isStale: boolean; // > 30 minutes
    isSuspicious: boolean; // Unusual price movement
    warning?: string;
    source: 'FMP' | 'YAHOO' | 'CACHE';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR LOGGING (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

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
// TRADING SYSTEM STATE (ENHANCED)
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradingSystemState {
    version: number; // For data migration
    isEnabled: boolean;
    portfolios: Map<string, AgentPortfolio>;

    // Global settings
    initialCash: number; // $100,000
    commissionRate: number; // 0 for now

    // ADDED: Position sizing rules
    positionSizingRules: PositionSizingRules;

    // ADDED: Risk management rules
    riskManagementRules: RiskManagementRules;

    // Leaderboard
    leaderboard: LeaderboardEntry[];

    // System metadata
    startDate: number;
    lastUpdated: number;
    lastBackup: number; // ADDED
    dataIntegrityHash: string; // ADDED

    // ADDED: System statistics
    totalTrades: number;
    totalVolume: number;
    mostTradedStocks: Record<string, number>;
    systemErrors: number;
}

export interface PositionSizingRules {
    maxPositionPercent: number; // 0.2 = 20% max per position
    maxTotalInvested: number; // 0.8 = 80% max invested
    minTradeValue: number; // $100 minimum trade
    maxPositionsPerAgent: number; // 10 positions max
    reserveCashPercent: number; // 0.05 = 5% cash reserve
    maxSectorExposure: number; // 0.4 = 40% max in one sector
}

export interface RiskManagementRules {
    stopLossPercent: number; // 0.15 = 15% stop loss
    takeProfitPercent: number; // 0.25 = 25% take profit
    maxDrawdownBeforePause: number; // 0.3 = 30% max drawdown
    maxDrawdownBeforeLiquidate: number; // 0.8 = 80% max drawdown
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
    sharpeRatio: number;
    maxDrawdown: number;
    rank: number;
    rankChange: number; // Change from last update
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE DECISION (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradeDecision {
    action: 'BUY' | 'SELL' | 'HOLD' | 'REDUCE';
    ticker: string;
    shares: number;
    estimatedPrice: number;
    estimatedValue: number;
    confidence: number;
    reasoning: string[];
    warnings: string[];

    // Context
    thesisId?: string;
    debateId?: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';

    // Validation
    isValid: boolean;
    validationErrors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSED POSITION (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE METADATA (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

export interface StorageMetadata {
    version: number;
    createdAt: number;
    lastModified: number;
    dataSize: number; // Bytes
    compressionEnabled: boolean;
    backupCount: number;
    lastBackupAt: number;
    integrityChecksum: string;
}
