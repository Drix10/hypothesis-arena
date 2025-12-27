// Shared constants

export const WEEX_BASE_URL = 'https://api-contract.weex.com';
export const WEEX_WS_URL = 'wss://ws-contract.weex.com/v2/ws';

// Funding settlement times (UTC)
export const FUNDING_SETTLEMENT_HOURS = [0, 8, 16];

// Default risk limits - Conservative system-wide defaults
// These can be overridden per-strategy via environment config or strategy params
// Source: FLOW.md specifies MAX_SAFE_LEVERAGE = 5x for crypto futures
export const DEFAULT_RISK_LIMITS = {
    maxPositionSize: 0.2,       // 20% per position
    maxTotalInvested: 0.8,      // 80% max invested
    maxDailyTrades: 20,
    maxLeverage: 5,             // 5x max (WEEX supports up to 100x but 5x is safe default per FLOW.md)
    drawdownPauseThreshold: 0.3,    // 30% drawdown = pause
    drawdownLiquidateThreshold: 0.5, // 50% drawdown = liquidate (reduced from 80% for safety)
    circuitBreakerThreshold: 0.15,   // 15% loss in 24h = stop
};

// API rate limits
export const RATE_LIMITS = {
    IP_LIMIT: 1000,           // per 10 seconds
    UID_LIMIT: 1000,          // per 10 seconds
    ORDER_LIMIT: 10,          // per second
    WINDOW_MS: 10000,
};

// Timestamp tolerance
export const TIMESTAMP_TOLERANCE_MS = 30000; // 30 seconds

// WebSocket
export const WS_PING_INTERVAL = 30000;      // 30 seconds
export const WS_PONG_TIMEOUT = 5;           // 5 missed pongs = disconnect
export const WS_RECONNECT_MAX_ATTEMPTS = 10;
export const WS_RECONNECT_BASE_DELAY = 1000;

// Cache TTLs (seconds)
export const CACHE_TTL = {
    TICKER: 5,
    DEPTH: 2,
    ACCOUNT: 10,
    POSITIONS: 5,
    ANALYSIS: 300,
};

// AI Log stages
export const AI_LOG_STAGES = {
    DECISION_MAKING: 'Decision Making',
    STRATEGY_GENERATION: 'Strategy Generation',
    RISK_ASSESSMENT: 'Risk Assessment',
    MARKET_ANALYSIS: 'Market Analysis',
    ORDER_EXECUTION: 'Order Execution',
    PORTFOLIO_MANAGEMENT: 'Portfolio Management',
};
