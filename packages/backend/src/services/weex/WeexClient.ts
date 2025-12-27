import crypto from 'crypto';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { WeexApiError, RateLimitError } from '../../utils/errors';
import {
    WeexCredentials,
    WeexOrderRequest,
    WeexOrderResponse,
    WeexPosition,
    WeexPositionRaw,
    normalizeWeexPosition,
    WeexAccount,
    WeexAccountAssets,
    WeexTicker,
    WeexDepth,
    WeexServerTime,
    WeexFundingRate,
    WeexTrade,
    WeexCandle,
    WeexContract,
    WeexOrderDetail,
    WeexFill,
    WeexBatchOrderResponse,
    ENDPOINT_WEIGHTS,
    DEFAULT_RATE_LIMITS,
} from '../../shared/types/weex';

interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

export class WeexClient {
    private client: AxiosInstance;
    private credentials: WeexCredentials;
    private serverTimeOffset: number = 0;
    private lastTimeSync: number = 0;
    private ipBucket: TokenBucket;
    private uidBucket: TokenBucket;
    private orderBucket: TokenBucket;

    constructor(credentials?: WeexCredentials) {
        this.credentials = credentials || {
            apiKey: config.weex.apiKey,
            secretKey: config.weex.secretKey,
            passphrase: config.weex.passphrase,
        };

        // Validate credentials are non-empty strings
        if (!this.credentials.apiKey || typeof this.credentials.apiKey !== 'string' || this.credentials.apiKey.trim() === '') {
            logger.warn('WeexClient: apiKey is missing or empty - API calls will fail');
        }
        if (!this.credentials.secretKey || typeof this.credentials.secretKey !== 'string' || this.credentials.secretKey.trim() === '') {
            logger.warn('WeexClient: secretKey is missing or empty - API calls will fail');
        }
        if (!this.credentials.passphrase || typeof this.credentials.passphrase !== 'string' || this.credentials.passphrase.trim() === '') {
            logger.warn('WeexClient: passphrase is missing or empty - API calls will fail');
        }

        const defaultHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
        };

        // Add proxy auth token if using a proxy server for IP whitelist
        if (config.weex.proxyToken) {
            defaultHeaders['X-Proxy-Token'] = config.weex.proxyToken;
        }

        this.client = axios.create({
            baseURL: config.weex.baseUrl,
            timeout: 120000, // Increased to 120 seconds for slow proxy/WEEX responses
            headers: defaultHeaders,
        });

        // Initialize rate limit buckets
        const now = Date.now();
        this.ipBucket = { tokens: DEFAULT_RATE_LIMITS.ipLimit, lastRefill: now };
        this.uidBucket = { tokens: DEFAULT_RATE_LIMITS.uidLimit, lastRefill: now };
        this.orderBucket = { tokens: DEFAULT_RATE_LIMITS.orderLimit, lastRefill: now };

        this.setupInterceptors();
    }

    private setupInterceptors() {
        this.client.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                if (error.response?.status === 429) {
                    throw new RateLimitError('WEEX rate limit exceeded');
                }

                const data = error.response?.data as any;
                if (data?.code) {
                    throw new WeexApiError(data.code, data.msg || 'WEEX API error');
                }

                // Create a clean error without circular references
                const cleanError = new Error(error.message);
                (cleanError as any).status = error.response?.status;
                (cleanError as any).code = data?.code;
                throw cleanError;
            }
        );
    }

    private generateSignature(
        timestamp: string,
        method: string,
        requestPath: string,
        queryString: string = '',
        body: string = ''
    ): string {
        // queryString should already include "?" if present (e.g., "?symbol=cmt_btcusdt")
        // For POST with no query params, queryString is empty ""
        const message = `${timestamp}${method.toUpperCase()}${requestPath}${queryString}${body}`;

        const signature = crypto
            .createHmac('sha256', this.credentials.secretKey)
            .update(message)
            .digest('base64');

        return signature;
    }

    private async getTimestamp(): Promise<string> {
        // Always sync time before private requests (every 10 seconds max)
        if (this.lastTimeSync === 0 || Date.now() - this.lastTimeSync > 10000) {
            await this.syncServerTime();
        }
        const ts = Math.round(Date.now() + this.serverTimeOffset);
        return String(ts);
    }

    private async syncServerTime(): Promise<void> {
        try {
            const localBefore = Date.now();
            const response = await this.client.get<{ timestamp: number }>('/capi/v2/market/time');
            const localAfter = Date.now();
            const latency = Math.round((localAfter - localBefore) / 2);

            const serverTime = response.data?.timestamp;
            if (typeof serverTime === 'number' && serverTime > 0) {
                // Calculate offset: serverTime = localTime + offset
                // So offset = serverTime - localTime (accounting for latency)
                const newOffset = serverTime - (localBefore + latency);
                // Verify the offset is reasonable (within 30 seconds)
                if (Math.abs(newOffset) <= 30000) {
                    this.serverTimeOffset = newOffset;
                    this.lastTimeSync = Date.now(); // Only update on successful sync
                } else {
                    logger.warn(`Rejecting unreasonable time offset: ${newOffset}ms`);
                    // Apply short delay to prevent spam on persistent bad responses
                    this.lastTimeSync = Date.now() - 5000;
                }
            } else {
                logger.warn('Invalid server time response:', response.data);
                // Apply short delay to prevent spam on persistent bad responses
                this.lastTimeSync = Date.now() - 5000;
            }
        } catch (error: any) {
            // Log but don't throw - use local time if sync fails
            logger.error('Failed to sync server time:', {
                status: error.status,
                message: error.message
            });
            // Don't update lastTimeSync on error - will retry on next request
            // But set a short delay to prevent spam (5 seconds)
            this.lastTimeSync = Date.now() - 5000;
        }
    }

    private refillBucket(bucket: TokenBucket, limit: number, windowMs: number): void {
        const now = Date.now();
        const elapsed = now - bucket.lastRefill;

        // Reset if elapsed time is unreasonably large (> 1 hour) or negative (clock skew)
        // This prevents overflow and handles system clock changes
        if (elapsed > 3600000 || elapsed < 0) {
            bucket.tokens = limit;
            bucket.lastRefill = now;
            return;
        }

        const refillAmount = (elapsed / windowMs) * limit;
        bucket.tokens = Math.min(limit, bucket.tokens + refillAmount);
        bucket.lastRefill = now;
    }

    private async consumeTokens(endpoint: string, isOrderRequest: boolean): Promise<void> {
        const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
        let attempts = 0;
        const MAX_ATTEMPTS = 20;

        while (attempts < MAX_ATTEMPTS) {
            // Refill buckets
            this.refillBucket(this.ipBucket, DEFAULT_RATE_LIMITS.ipLimit, DEFAULT_RATE_LIMITS.ipWindowMs);
            this.refillBucket(this.uidBucket, DEFAULT_RATE_LIMITS.uidLimit, DEFAULT_RATE_LIMITS.uidWindowMs);

            if (isOrderRequest) {
                this.refillBucket(this.orderBucket, DEFAULT_RATE_LIMITS.orderLimit, DEFAULT_RATE_LIMITS.orderWindowMs);
            }

            // Check if we have enough tokens
            const hasIPTokens = this.ipBucket.tokens >= weight;
            const hasUIDTokens = this.uidBucket.tokens >= weight;
            const hasOrderTokens = !isOrderRequest || this.orderBucket.tokens >= 1;

            if (hasIPTokens && hasUIDTokens && hasOrderTokens) {
                // Consume tokens (ensure we don't go negative)
                this.ipBucket.tokens = Math.max(0, this.ipBucket.tokens - weight);
                this.uidBucket.tokens = Math.max(0, this.uidBucket.tokens - weight);
                if (isOrderRequest) {
                    this.orderBucket.tokens = Math.max(0, this.orderBucket.tokens - 1);
                }
                return;
            }

            // Calculate wait time with exponential backoff
            // Include order bucket in wait time calculation to prevent tight retry loops
            const ipWaitTime = (weight - this.ipBucket.tokens) / DEFAULT_RATE_LIMITS.ipLimit * DEFAULT_RATE_LIMITS.ipWindowMs;
            const uidWaitTime = (weight - this.uidBucket.tokens) / DEFAULT_RATE_LIMITS.uidLimit * DEFAULT_RATE_LIMITS.uidWindowMs;
            const orderWaitTime = isOrderRequest && this.orderBucket.tokens < 1
                ? (1 - this.orderBucket.tokens) / DEFAULT_RATE_LIMITS.orderLimit * DEFAULT_RATE_LIMITS.orderWindowMs
                : 0;

            const baseWaitTime = Math.min(
                Math.max(ipWaitTime, uidWaitTime, orderWaitTime),
                5000 // Max base wait 5 seconds
            );
            // Add exponential backoff factor
            const waitTime = Math.min(baseWaitTime * Math.pow(1.5, attempts), 30000); // Cap at 30 seconds
            await new Promise(resolve => setTimeout(resolve, waitTime));
            attempts++;
        }

        throw new RateLimitError('Rate limit retry exceeded after 20 attempts');
    }

    private async request<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        params?: Record<string, any>,
        body?: any,
        isPrivate: boolean = false,
        isOrderRequest: boolean = false
    ): Promise<T> {
        await this.consumeTokens(endpoint, isOrderRequest);

        const timestamp = await this.getTimestamp();
        // For signature: include "?" in queryString if params exist
        const queryString = params ? `?${new URLSearchParams(params).toString()}` : '';
        const bodyString = body ? JSON.stringify(body) : '';

        // IMPORTANT: Always include User-Agent - WEEX requires it
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'locale': 'en-US',
        };

        if (isPrivate) {
            headers['ACCESS-KEY'] = this.credentials.apiKey;
            headers['ACCESS-TIMESTAMP'] = timestamp;
            headers['ACCESS-PASSPHRASE'] = this.credentials.passphrase;
            headers['ACCESS-SIGN'] = this.generateSignature(
                timestamp,
                method,
                endpoint,
                queryString,
                bodyString
            );

            // Debug logging - only in development
            if (process.env.NODE_ENV === 'development' && process.env.DEBUG_WEEX === 'true') {
                logger.debug(`[WEEX] ${method} ${endpoint}${queryString}`);
                logger.debug(`[WEEX] Timestamp: ${timestamp}`);
            }
        }

        // For URL: queryString already has "?" if present
        const url = queryString ? `${endpoint}${queryString}` : endpoint;

        try {
            const response = method === 'GET'
                ? await this.client.get<T>(url, {
                    headers,
                    timeout: 120000, // Explicit 120s timeout per request (matches client default)
                })
                : await this.client.post<T>(endpoint, body, {
                    headers,
                    timeout: 120000, // Explicit 120s timeout per request (matches client default)
                });

            return response.data;
        } catch (error: any) {
            // Extract useful error info without circular references
            const errorInfo = {
                method,
                endpoint,
                status: error.response?.status,
                code: error.response?.data?.code,
                message: error.response?.data?.msg || error.message,
                isPrivate,
            };
            logger.error(`WEEX API error:`, errorInfo);

            // Re-throw with clean error
            if (error.response?.data?.code) {
                throw new WeexApiError(error.response.data.code, error.response.data.msg || 'WEEX API error');
            }
            throw new Error(errorInfo.message);
        }
    }

    // Public endpoints
    async getServerTime(): Promise<WeexServerTime> {
        return this.request<WeexServerTime>('GET', '/capi/v2/market/time');
    }

    async getTicker(symbol: string): Promise<WeexTicker> {
        const response = await this.request<{ data: WeexTicker } | WeexTicker>(
            'GET',
            '/capi/v2/market/ticker',
            { symbol }
        );
        // Handle both response formats
        return (response as any).data || response;
    }

    async getAllTickers(): Promise<WeexTicker[]> {
        const response = await this.request<{ data: WeexTicker[] } | WeexTicker[]>(
            'GET',
            '/capi/v2/market/tickers'
        );
        // Handle both response formats
        return (response as any).data || response || [];
    }

    async getDepth(symbol: string, limit: number = 15): Promise<WeexDepth> {
        // WEEX API only accepts specific limit values: 15 or 200
        const actualLimit = limit > 15 ? 200 : 15;

        const response = await this.request<WeexDepth>(
            'GET',
            '/capi/v2/market/depth',
            { symbol, limit: String(actualLimit) }
        );
        return response;
    }

    async getFundingRate(symbol: string): Promise<WeexFundingRate> {
        const response = await this.request<WeexFundingRate[]>(
            'GET',
            '/capi/v2/market/currentFundRate',
            { symbol }
        );
        // Response is an array, find the matching symbol
        const rates = Array.isArray(response) ? response : [];
        // Prefer exact symbol match, warn if falling back to first item
        const exactMatch = rates.find(r => r.symbol === symbol);
        if (exactMatch) {
            return exactMatch;
        }
        if (rates.length > 0) {
            logger.warn(`getFundingRate: No exact match for ${symbol}, using first result: ${rates[0].symbol}`);
            return rates[0];
        }
        // Return default if no rates available
        return { symbol, fundingRate: '0', collectCycle: 480, timestamp: Date.now() };
    }

    async getCandles(symbol: string, interval: string = '1m', limit: number = 100): Promise<WeexCandle[]> {
        // Response is array of arrays: [[timestamp, open, high, low, close, baseVol, quoteVol], ...]
        const response = await this.request<string[][]>(
            'GET',
            '/capi/v2/market/candles',
            { symbol, granularity: interval, limit: String(limit) }
        );
        // Convert array format to object format with bounds checking
        const candles = Array.isArray(response) ? response : [];
        return candles.map(c => {
            // Ensure c is an array with at least 7 elements
            if (!Array.isArray(c) || c.length < 7) {
                return {
                    timestamp: '0',
                    open: '0',
                    high: '0',
                    low: '0',
                    close: '0',
                    volume: '0',
                };
            }
            return {
                timestamp: c[0] || '0',
                open: c[1] || '0',
                high: c[2] || '0',
                low: c[3] || '0',
                close: c[4] || '0',
                volume: c[6] || '0', // quoteVol (USDT volume)
            };
        }).filter(c => c.timestamp !== '0'); // Filter out invalid candles
    }

    async getContracts(): Promise<WeexContract[]> {
        // Response is array directly
        const response = await this.request<WeexContract[] | { data: WeexContract[] }>(
            'GET',
            '/capi/v2/market/contracts'
        );
        return Array.isArray(response) ? response : (response as any).data || [];
    }

    // Private endpoints
    async getAccount(): Promise<WeexAccount[]> {
        const response = await this.request<any>(
            'GET',
            '/capi/v2/account/accounts',
            undefined,
            undefined,
            true
        );
        // Response format: { account: {...}, collateral: [...], position: [...] }
        if (response?.account) {
            return [response.account];
        }
        return response?.data || [];
    }

    async getAccountAssets(): Promise<WeexAccountAssets> {
        const response = await this.request<any>(
            'GET',
            '/capi/v2/account/assets',
            undefined,
            undefined,
            true
        );
        // Response is an array of assets, convert to expected format
        if (Array.isArray(response)) {
            const usdt = response.find((a: any) => a.coinName === 'USDT') || response[0] || {};
            return {
                marginCoin: usdt.coinName || 'USDT',
                locked: usdt.frozen || '0',
                available: usdt.available || '0',
                crossMaxAvailable: usdt.available || '0',
                fixedMaxAvailable: usdt.available || '0',
                maxTransferOut: usdt.available || '0',
                equity: usdt.equity || '0',
                usdtEquity: usdt.equity || '0',
                btcEquity: '0',
            };
        }
        return response?.data || response || {} as WeexAccountAssets;
    }

    async changeLeverage(symbol: string, leverage: number, marginMode: '1' | '3' = '1'): Promise<any> {
        return this.request(
            'POST',
            '/capi/v2/account/leverage',
            undefined,
            { symbol, marginMode, longLeverage: String(leverage), shortLeverage: String(leverage) },
            true
        );
    }

    async getPositions(): Promise<WeexPosition[]> {
        // Response is array directly, not wrapped in { data: [...] }
        const response = await this.request<WeexPositionRaw[] | { data: WeexPositionRaw[] }>(
            'GET',
            '/capi/v2/account/position/allPosition',
            undefined,
            undefined,
            true
        );
        // Handle both response formats and normalize to canonical camelCase shape
        const rawPositions = Array.isArray(response) ? response : (response as any).data || [];

        // Filter and normalize positions, skipping invalid ones
        const positions: WeexPosition[] = [];
        for (const raw of rawPositions) {
            try {
                positions.push(normalizeWeexPosition(raw));
            } catch (error) {
                logger.warn('Skipping invalid position:', { symbol: raw?.symbol, error: (error as Error).message });
            }
        }
        return positions;
    }

    async getPosition(symbol: string): Promise<WeexPosition | null> {
        // Response is array directly (can have multiple positions for same symbol in hedge mode)
        const response = await this.request<WeexPositionRaw[] | { data: WeexPositionRaw[] }>(
            'GET',
            '/capi/v2/account/position/singlePosition',
            { symbol },
            undefined,
            true
        );
        const rawPositions = Array.isArray(response) ? response : (response as any).data || [];

        if (!rawPositions[0]) return null;

        try {
            return normalizeWeexPosition(rawPositions[0]);
        } catch (error) {
            logger.warn('Invalid position data:', { symbol, error: (error as Error).message });
            return null;
        }
    }

    async placeOrder(order: WeexOrderRequest): Promise<WeexOrderResponse> {
        return this.request<WeexOrderResponse>(
            'POST',
            '/capi/v2/order/placeOrder',
            undefined,
            order,
            true,
            true
        );
    }

    /**
     * Cancel an order by orderId
     * @param orderId - The order ID to cancel
     * @deprecated symbol parameter removed - it was never used by the API
     */
    async cancelOrder(orderId: string): Promise<any> {
        return this.request(
            'POST',
            '/capi/v2/order/cancel_order',
            undefined,
            { orderId },
            true,
            true
        );
    }

    async getOrder(orderId: string): Promise<WeexOrderDetail> {
        // Response is object directly, not wrapped in { data: {...} }
        const response = await this.request<WeexOrderDetail | { data: WeexOrderDetail }>(
            'GET',
            '/capi/v2/order/detail',
            { orderId },
            undefined,
            true
        );
        return (response as any).data || response;
    }

    async getCurrentOrders(symbol?: string): Promise<WeexOrderDetail[]> {
        const params = symbol ? { symbol } : undefined;
        // Response is array directly
        const response = await this.request<WeexOrderDetail[] | { data: WeexOrderDetail[] }>(
            'GET',
            '/capi/v2/order/current',
            params,
            undefined,
            true
        );
        return Array.isArray(response) ? response : (response as any).data || [];
    }

    async getHistoryOrders(symbol: string, limit: number = 50): Promise<WeexOrderDetail[]> {
        // Response is array directly
        const response = await this.request<WeexOrderDetail[] | { data: WeexOrderDetail[] }>(
            'GET',
            '/capi/v2/order/history',
            { symbol, pageSize: String(limit) },
            undefined,
            true
        );
        return Array.isArray(response) ? response : (response as any).data || [];
    }

    async getFills(symbol: string, limit: number = 50): Promise<WeexFill[]> {
        // Response format: { list: [...], nextFlag: boolean, totals: number }
        const response = await this.request<{ list: WeexFill[] } | { data: WeexFill[] }>(
            'GET',
            '/capi/v2/order/fills',
            { symbol, limit: String(limit) },
            undefined,
            true
        );
        return (response as any).list || (response as any).data || [];
    }

    async closeAllPositions(symbol?: string): Promise<any> {
        // Correct endpoint is /capi/v2/order/closePositions (not closeAllPositions)
        // symbol is optional - if not provided, closes all positions
        const body = symbol ? { symbol } : {};
        return this.request(
            'POST',
            '/capi/v2/order/closePositions',
            undefined,
            body,
            true,
            true
        );
    }

    async uploadAILog(log: {
        orderId?: string;
        stage: string;
        model: string;
        input: any;
        output: any;
        explanation: string;
    }): Promise<any> {
        return this.request(
            'POST',
            '/capi/v2/order/uploadAiLog',
            undefined,
            log,
            true
        );
    }
}

// Singleton instance
let weexClientInstance: WeexClient | null = null;

export function getWeexClient(credentials?: WeexCredentials): WeexClient {
    // If new credentials provided, always create new instance
    if (credentials) {
        weexClientInstance = new WeexClient(credentials);
        return weexClientInstance;
    }

    // Return existing instance
    if (weexClientInstance) {
        return weexClientInstance;
    }

    // Create new instance synchronously (safe since constructor is sync)
    weexClientInstance = new WeexClient();
    return weexClientInstance;
}
