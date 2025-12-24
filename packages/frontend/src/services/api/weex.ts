/**
 * WEEX API Service
 * 
 * Frontend service for WEEX market data and account operations.
 */

import { apiClient, ApiError } from './client';

export interface WeexStatus {
    connected: boolean;
    serverTime?: number;
    localTime?: number;
    offset?: number;
    error?: string;
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
    asks: [string, string][];
    bids: [string, string][];
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
    minLeverage: string;
    maxLeverage: string;
}

export interface WeexPosition {
    symbol: string;
    side: 'long' | 'short';
    size: string;
    leverage: string;
    openValue: string;
    markPrice: string;
    unrealizePnl: string;
    marginMode: string;
    liquidationPrice: string;
}

export interface WeexAssets {
    marginCoin: string;
    locked: string;
    available: string;
    equity: string;
    usdtEquity: string;
}

export interface WeexAuthTestResult {
    tests: {
        name: string;
        success: boolean;
        data?: any;
        error?: string;
    }[];
    success: boolean;
}

export const weexApi = {
    // Public endpoints (no auth required)

    async getStatus(): Promise<WeexStatus> {
        return apiClient.get<WeexStatus>('/weex/status');
    },

    async getTickers(): Promise<WeexTicker[]> {
        const response = await apiClient.get<{ tickers: WeexTicker[] }>('/weex/tickers');
        return response.tickers;
    },

    async getTicker(symbol: string): Promise<WeexTicker> {
        const encodedSymbol = encodeURIComponent(symbol);
        const response = await apiClient.get<{ ticker: WeexTicker }>(`/weex/ticker/${encodedSymbol}`);
        return response.ticker;
    },

    async getDepth(symbol: string, limit: number = 15): Promise<WeexDepth> {
        const encodedSymbol = encodeURIComponent(symbol);
        const response = await apiClient.get<{ depth: WeexDepth }>(`/weex/depth/${encodedSymbol}?limit=${limit}`);
        return response.depth;
    },

    async getCandles(symbol: string, interval: string = '1m', limit: number = 100): Promise<WeexCandle[]> {
        const encodedSymbol = encodeURIComponent(symbol);
        const encodedInterval = encodeURIComponent(interval);
        const response = await apiClient.get<{ candles: WeexCandle[] }>(
            `/weex/candles/${encodedSymbol}?interval=${encodedInterval}&limit=${limit}`
        );
        return response.candles;
    },

    async getContracts(): Promise<WeexContract[]> {
        const response = await apiClient.get<{ contracts: WeexContract[] }>('/weex/contracts');
        return response.contracts;
    },

    // Private endpoints (auth required)

    async getAccount(): Promise<any[]> {
        const response = await apiClient.get<{ accounts: any[] }>('/weex/account');
        return response.accounts;
    },

    async getAssets(): Promise<WeexAssets> {
        const response = await apiClient.get<{ assets: WeexAssets }>('/weex/assets');
        return response.assets;
    },

    async getPositions(): Promise<WeexPosition[]> {
        const response = await apiClient.get<{ positions: WeexPosition[] }>('/weex/positions');
        return response.positions;
    },

    async getPosition(symbol: string): Promise<WeexPosition | null> {
        const encodedSymbol = encodeURIComponent(symbol);
        const response = await apiClient.get<{ position: WeexPosition | null }>(`/weex/position/${encodedSymbol}`);
        return response.position;
    },

    async getCurrentOrders(symbol?: string): Promise<any[]> {
        const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
        const response = await apiClient.get<{ orders: any[] }>(`/weex/orders${query}`);
        return response.orders;
    },

    async getOrderHistory(symbol: string, limit: number = 50): Promise<any[]> {
        const encodedSymbol = encodeURIComponent(symbol);
        const response = await apiClient.get<{ orders: any[] }>(
            `/weex/orders/history/${encodedSymbol}?limit=${limit}`
        );
        return response.orders;
    },

    async getFills(symbol: string, limit: number = 50): Promise<any[]> {
        const encodedSymbol = encodeURIComponent(symbol);
        const response = await apiClient.get<{ fills: any[] }>(
            `/weex/fills/${encodedSymbol}?limit=${limit}`
        );
        return response.fills;
    },

    async changeLeverage(symbol: string, leverage: number, marginMode?: '1' | '3'): Promise<any> {
        return apiClient.post('/weex/leverage', { symbol, leverage, marginMode });
    },

    async testAuth(): Promise<WeexAuthTestResult> {
        return apiClient.post<WeexAuthTestResult>('/weex/test-auth', {});
    },
};

export { ApiError };
