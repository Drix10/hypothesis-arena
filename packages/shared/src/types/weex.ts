// WEEX API Types

export const APPROVED_SYMBOLS = [
    'cmt_btcusdt',
    'cmt_ethusdt',
    'cmt_solusdt',
    'cmt_dogeusdt',
    'cmt_xrpusdt',
    'cmt_adausdt',
    'cmt_bnbusdt',
    'cmt_ltcusdt',
] as const;

export type ApprovedSymbol = typeof APPROVED_SYMBOLS[number];

export interface WeexCredentials {
    apiKey: string;
    secretKey: string;
    passphrase: string;
}

export interface WeexOrderRequest {
    symbol: string;
    side: 'buy' | 'sell';
    type: '1' | '2'; // 1=limit, 2=market
    orderType: '0' | '1'; // 0=normal, 1=post-only
    size: string;
    price?: string;
    clientOrderId: string;
    marginMode?: '1' | '3'; // 1=cross, 3=isolated
}

export interface WeexOrderResponse {
    code: string;
    msg: string;
    data: {
        orderId: string;
        clientOrderId: string;
    };
}

export interface WeexPosition {
    symbol: string;
    side: 'long' | 'short';
    size: string;
    leverage: string;
    openValue: string;
    markPrice: string;
    unrealizePnl: string;
    marginMode: '1' | '3';
    liquidationPrice: string;
}

export interface WeexAccount {
    marginCoin: string;
    available: string;
    frozen: string;
    equity: string;
    unrealizedPL: string;
}

export interface WeexTicker {
    symbol: string;
    last: string;
    bestAsk: string;
    bestBid: string;
    high24h: string;
    low24h: string;
    volume24h: string;
    timestamp: string;
}

export interface WeexDepth {
    asks: [string, string][]; // [price, quantity]
    bids: [string, string][];
    timestamp: string;
}

export interface WeexServerTime {
    epoch: string;
    iso: string;
    timestamp: number;
}

export interface WeexFundingRate {
    symbol: string;
    fundingRate: string;
    nextFundingTime: number;
}

export interface WeexError {
    code: string;
    msg: string;
}

// Rate limit config
export interface RateLimitConfig {
    ipLimit: number;      // 1000 per 10s
    uidLimit: number;     // 1000 per 10s
    orderLimit: number;   // 10 per second
    windowMs: number;     // 10000ms
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
    ipLimit: 1000,
    uidLimit: 1000,
    orderLimit: 10,
    windowMs: 10000,
};

// Endpoint weights
export const ENDPOINT_WEIGHTS: Record<string, number> = {
    '/capi/v2/market/time': 1,
    '/capi/v2/market/contracts': 10,
    '/capi/v2/market/depth': 1,
    '/capi/v2/market/tickers': 40,
    '/capi/v2/market/ticker': 1,
    '/capi/v2/market/trades': 1,
    '/capi/v2/market/candles': 1,
    '/capi/v2/account/accounts': 5,
    '/capi/v2/account/account': 5,
    '/capi/v2/account/assets': 5,
    '/capi/v2/account/position/allPosition': 5,
    '/capi/v2/account/position/singlePosition': 5,
    '/capi/v2/order/placeOrder': 2,
    '/capi/v2/order/batchOrders': 5,
    '/capi/v2/order/cancelOrder': 2,
    '/capi/v2/order/batchCancelOrders': 5,
    '/capi/v2/order/detail': 1,
    '/capi/v2/order/history': 5,
    '/capi/v2/order/current': 1,
    '/capi/v2/order/fills': 5,
    '/capi/v2/order/uploadAiLog': 1,
};
