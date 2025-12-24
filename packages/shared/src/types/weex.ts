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

/**
 * WEEX Order Request
 * Matches /capi/v2/order/placeOrder parameters exactly
 */
export interface WeexOrderRequest {
    symbol: string;                    // Trading pair (e.g., "cmt_btcusdt")
    client_oid: string;                // Custom order ID (max 40 chars)
    size: string;                      // Order quantity
    type: '1' | '2' | '3' | '4';       // 1=Open long, 2=Open short, 3=Close long, 4=Close short
    order_type: '0' | '1' | '2' | '3'; // 0=Normal, 1=Post-Only, 2=FOK, 3=IOC
    match_price: '0' | '1';            // 0=Limit price, 1=Market price
    price: string;                     // Order price (required for limit orders)
    presetTakeProfitPrice?: string;    // Optional TP price
    presetStopLossPrice?: string;      // Optional SL price
    marginMode?: 1 | 3;                // 1=Cross, 3=Isolated (default: 1)
}

/**
 * WEEX Order Response
 * Response from /capi/v2/order/placeOrder
 */
export interface WeexOrderResponse {
    client_oid: string | null;         // Client-generated order identifier
    order_id: string;                  // Order ID
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

/**
 * WEEX Ticker Response
 * Matches /capi/v2/market/ticker response exactly
 */
export interface WeexTicker {
    symbol: string;
    last: string;
    best_ask: string;      // Ask price
    best_bid: string;      // Bid price
    high_24h: string;      // Highest price in last 24h
    low_24h: string;       // Lowest price in last 24h
    volume_24h: string;    // Trading volume of quote currency
    timestamp: string;     // Unix millisecond timestamp
    priceChangePercent?: string;  // Price change percent (24h)
    base_volume?: string;  // Trading volume of base currency
    markPrice?: string;    // Mark price
    indexPrice?: string;   // Index price
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

/**
 * WEEX Funding Rate Response
 * Matches /capi/v2/market/currentFundRate response
 */
export interface WeexFundingRate {
    symbol: string;
    fundingRate: string;       // Current funding rate
    collectCycle: number;      // Settlement cycle in minutes
    timestamp: number;         // Settlement time (Unix ms)
}

export interface WeexTrade {
    tradeId: string;
    symbol: string;
    price: string;
    size: string;
    side: 'buy' | 'sell';
    timestamp: string;
}

export interface WeexCandle {
    timestamp: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface WeexContract {
    symbol: string;
    baseCoin: string;
    quoteCoin: string;
    minTradeNum: string;
    maxTradeNum: string;
    takerFeeRate: string;
    makerFeeRate: string;
    pricePlace: number;
    volumePlace: number;
    minLeverage: string;
    maxLeverage: string;
}

export interface WeexAccountAssets {
    marginCoin: string;
    locked: string;
    available: string;
    crossMaxAvailable: string;
    fixedMaxAvailable: string;
    maxTransferOut: string;
    equity: string;
    usdtEquity: string;
    btcEquity: string;
}

export interface WeexOrderDetail {
    symbol: string;
    size: string;
    orderId: string;
    clientOid: string;
    filledQty: string;
    fee: string;
    price: string;
    priceAvg: string;
    status: 'pending' | 'open' | 'filled' | 'canceling' | 'canceled' | 'untriggered';
    type: string;
    orderType: string;
    side: string;
    createTime: string;
    totalProfits: string;
}

export interface WeexFill {
    tradeId: string;
    symbol: string;
    orderId: string;
    price: string;
    size: string;
    side: string;
    fee: string;
    feeCoin: string;
    timestamp: string;
}

export interface WeexBatchOrderResponse {
    code: string;
    msg: string;
    data: {
        successList: { orderId: string; clientOid: string }[];
        failureList: { clientOid: string; errorCode: string; errorMsg: string }[];
    };
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
