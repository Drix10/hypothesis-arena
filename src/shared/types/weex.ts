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

/**
 * WEEX Position - Canonical camelCase interface
 * Based on official WEEX API docs: /capi/v2/account/position/singlePosition
 * 
 * Use `normalizeWeexPosition()` to convert API responses to this canonical shape.
 */
export interface WeexPosition {
    id?: number;                       // Position ID
    isolatedPositionId?: number;       // Isolated position ID (for margin adjustment)
    symbol: string;                    // Trading pair (required)
    side: 'LONG' | 'SHORT';            // Position direction (required, normalized to uppercase)
    size: string;                      // Current position size (required)
    leverage: string;                  // Position leverage (required)
    openValue?: string;                // Initial value at position opening
    entryPrice?: number;               // Calculated entry price (openValue / size)
    marginMode?: string;               // 'SHARED' (cross) or 'ISOLATED'
    marginSize?: string;               // Margin amount
    unrealizePnl?: string;             // Unrealized PnL
    liquidationPrice?: string;         // Estimated liquidation price
}

/**
 * Raw WEEX Position from API
 * Based on official WEEX API docs: /capi/v2/account/position/singlePosition
 * Internal type - use normalizeWeexPosition() to convert to WeexPosition
 */
export interface WeexPositionRaw {
    id?: number;                       // Position ID
    isolated_position_id?: number;     // Isolated position ID (for margin adjustment)
    symbol: string;                    // Trading pair (required)
    side: string;                      // 'LONG' | 'SHORT' (required, uppercase from API)
    size: string;                      // Current position size (required)
    leverage: string;                  // Position leverage (required)
    open_value?: string;               // Initial value at position opening
    margin_mode?: string;              // 'SHARED' (cross) or 'ISOLATED'
    marginSize?: string;               // Margin amount (note: camelCase in API response)
    unrealizePnl?: string;             // Unrealized PnL (note: camelCase in API response)
    liquidatePrice?: string;           // Estimated liquidation price (note: camelCase in API response)
}

/**
 * Normalize a raw WEEX position response to the canonical camelCase shape
 * Handles the official WEEX API response format
 * 
 * @throws Error if required fields (symbol, size, leverage, side) are missing or invalid
 */
export function normalizeWeexPosition(raw: WeexPositionRaw): WeexPosition {
    // Validate required fields exist and are strings
    if (!raw.symbol || typeof raw.symbol !== 'string') {
        throw new Error(`WeexPosition missing required field: symbol (got: ${JSON.stringify(raw.symbol)})`);
    }

    // Validate size is a valid positive number string
    if (!raw.size || typeof raw.size !== 'string') {
        throw new Error(`WeexPosition missing required field: size for ${raw.symbol} (got: ${JSON.stringify(raw.size)})`);
    }
    const sizeNum = parseFloat(raw.size);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
        throw new Error(`WeexPosition invalid size for ${raw.symbol}: must be a positive number, got '${raw.size}'`);
    }

    // Validate leverage is a valid positive number string
    if (!raw.leverage || typeof raw.leverage !== 'string') {
        throw new Error(`WeexPosition missing required field: leverage for ${raw.symbol} (got: ${JSON.stringify(raw.leverage)})`);
    }
    const leverageNum = parseFloat(raw.leverage);
    if (!Number.isFinite(leverageNum) || leverageNum <= 0) {
        throw new Error(`WeexPosition invalid leverage for ${raw.symbol}: must be a positive number, got '${raw.leverage}'`);
    }

    // Validate side - MUST be present and valid, no silent defaults
    if (!raw.side || typeof raw.side !== 'string') {
        throw new Error(`WeexPosition missing required field: side for ${raw.symbol} (got: ${JSON.stringify(raw.side)})`);
    }
    const normalizedSide = raw.side.toUpperCase();
    if (normalizedSide !== 'LONG' && normalizedSide !== 'SHORT') {
        throw new Error(`WeexPosition invalid side value for ${raw.symbol}: expected 'LONG' or 'SHORT', got '${raw.side}'`);
    }
    const side: 'LONG' | 'SHORT' = normalizedSide as 'LONG' | 'SHORT';

    // Calculate entry price from openValue and size
    let entryPrice: number | undefined;
    if (raw.open_value && typeof raw.open_value === 'string') {
        const openValueNum = parseFloat(raw.open_value);
        if (Number.isFinite(openValueNum) && openValueNum > 0 && sizeNum > 0) {
            entryPrice = openValueNum / sizeNum;
            // Validate entry price is reasonable
            if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
                entryPrice = undefined;
            }
        }
    }

    return {
        id: raw.id,
        isolatedPositionId: raw.isolated_position_id, symbol: raw.symbol,
        side,
        size: raw.size,
        leverage: raw.leverage,
        openValue: raw.open_value,
        entryPrice,
        marginMode: raw.margin_mode,
        marginSize: raw.marginSize,
        unrealizePnl: raw.unrealizePnl,
        liquidationPrice: raw.liquidatePrice,
    };
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
    underlying_index: string;
    quote_currency: string;
    coin: string;
    contract_val: string;
    delivery: string[];
    size_increment: string; // Decimal places of quantity (e.g., "5" = 5 decimals)
    tick_size: string; // Decimal places of price (e.g., "1" = 1 decimal)
    forwardContractFlag: boolean;
    priceEndStep: number; // Step size of last decimal digit (e.g., 1 = 0.1, 0.1 = 0.01)
    minLeverage: number;
    maxLeverage: number;
    buyLimitPriceRatio: string;
    sellLimitPriceRatio: string;
    makerFeeRate: string;
    takerFeeRate: string;
    minOrderSize: string; // Minimum order size in base currency
    maxOrderSize: string; // Maximum order size in base currency
    maxPositionSize: string; // Maximum position size in base currency
    marketOpenLimitSize?: string; // Market order opening position single limit
    // Legacy fields (may be deprecated)
    baseCoin?: string;
    quoteCoin?: string;
    minTradeNum?: string;
    maxTradeNum?: string;
    pricePlace?: number;
    volumePlace?: number;
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

// Rate limit config with explicit time windows
export interface RateLimitConfig {
    ipLimit: number;           // IP-based limit
    ipWindowMs: number;        // Time window for IP limit (default: 10000ms)
    uidLimit: number;          // UID-based limit
    uidWindowMs: number;       // Time window for UID limit (default: 10000ms)
    orderLimit: number;        // Order placement limit
    orderWindowMs: number;     // Time window for order limit (default: 1000ms = 1 second)
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
    ipLimit: 1000,
    ipWindowMs: 10000,         // 1000 requests per 10 seconds
    uidLimit: 1000,
    uidWindowMs: 10000,        // 1000 requests per 10 seconds
    orderLimit: 10,
    orderWindowMs: 1000,       // 10 orders per second
};

// Endpoint weights
export const ENDPOINT_WEIGHTS: Record<string, number> = {
    '/capi/v2/market/time': 1,
    '/capi/v2/market/contracts': 10,
    '/capi/v2/market/depth': 1,
    '/capi/v2/market/tickers': 40,
    '/capi/v2/market/ticker': 1,
    '/capi/v2/market/trades': 5,
    '/capi/v2/market/candles': 1,
    '/capi/v2/market/currentFundRate': 1,
    '/capi/v2/account/accounts': 5,
    '/capi/v2/account/assets': 5,
    '/capi/v2/account/leverage': 10,
    '/capi/v2/account/position/allPosition': 10,
    '/capi/v2/account/position/singlePosition': 2,
    '/capi/v2/order/placeOrder': 2,
    '/capi/v2/order/cancel_order': 2,
    '/capi/v2/order/closePositions': 40,
    '/capi/v2/order/detail': 2,
    '/capi/v2/order/history': 10,
    '/capi/v2/order/current': 2,
    '/capi/v2/order/fills': 5,
    '/capi/v2/order/uploadAiLog': 1,
};
