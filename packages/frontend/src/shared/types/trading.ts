// Trading Types - Shared between frontend and backend

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'TRIGGER';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'FAILED';
export type PositionSide = 'LONG' | 'SHORT';
export type MarginMode = 'CROSS' | 'ISOLATED';
export type Recommendation = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface TradeDecision {
    symbol: string;
    action: OrderSide | 'HOLD';
    confidence: number;
    targetPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    size: number;
    reason: string;
    thesisId: string;
    debateId?: string;
    recommendation: Recommendation;
    leverage?: number;
    methodology?: string;
}

export interface Trade {
    id: string;
    portfolioId: string;
    positionId?: string;
    symbol: string;
    side: OrderSide;
    type: OrderType;
    size: number;
    price?: number;              // Requested price (optional for MARKET orders)
    executedPrice?: number;      // Actual execution price (filled after order executes)
    fee?: number;
    status: OrderStatus;
    reason?: string;
    analysisId?: string;
    confidence?: number;
    executedAt?: number;
    createdAt: number;
    weexOrderId?: string;
    clientOrderId: string;
    realizedPnL?: number;
    realizedPnLPercent?: number;
}

export interface Position {
    id: string;
    portfolioId: string;
    symbol: string;
    side: PositionSide;
    size: number;
    entryPrice: number;
    currentPrice: number;
    marginMode: MarginMode;
    leverage: number;
    unrealizedPnL: number;
    realizedPnL: number;
    openedAt: number;
    closedAt?: number;
    isOpen: boolean;
    weexPositionId?: string;
}

export interface Portfolio {
    id: string;
    agentId: string;
    agentName: string;
    userId?: string;
    initialBalance: number;
    currentBalance: number;
    totalValue: number;
    totalReturn: number;
    totalReturnDollar: number;
    winRate: number;
    sharpeRatio: number | null;
    maxDrawdown: number;
    currentDrawdown: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    positions: Position[];
    trades: Trade[];
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'paused' | 'liquidated';
}

export interface RiskLimits {
    maxPositionSize: number;
    maxTotalInvested: number;
    maxDailyTrades: number;
    maxLeverage: number;
    drawdownPauseThreshold: number;
    drawdownLiquidateThreshold: number;
    circuitBreakerThreshold: number;
}

export interface PerformanceSnapshot {
    timestamp: number;
    totalValue: number;
    cash: number;
    positionsValue: number;
    totalReturn: number;
    dailyReturn: number;
    numPositions: number;
}
