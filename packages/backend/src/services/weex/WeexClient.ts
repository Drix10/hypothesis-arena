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
} from '@hypothesis-arena/shared';

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

        this.client = axios.create({
            baseURL: config.weex.baseUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'HypothesisArena/1.0',
            },
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
        const message = queryString
            ? `${timestamp}${method.toUpperCase()}${requestPath}?${queryString}${body}`
            : `${timestamp}${method.toUpperCase()}${requestPath}${body}`;

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
                    // Don't update lastTimeSync - will retry on next request
                }
            } else {
                logger.warn('Invalid server time response:', response.data);
                // Don't update lastTimeSync - will retry on next request
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
        const refillAmount = (elapsed / windowMs) * limit;

        bucket.tokens = Math.min(limit, bucket.tokens + refillAmount);
        bucket.lastRefill = now;
    }

    private async consumeTokens(endpoint: string, isOrderRequest: boolean, depth: number = 0): Promise<void> {
        // Prevent infinite recursion
        if (depth > 10) {
            throw new RateLimitError('Rate limit retry exceeded');
        }

        const weight = ENDPOINT_WEIGHTS[endpoint] || 1;

        // Refill buckets
        this.refillBucket(this.ipBucket, DEFAULT_RATE_LIMITS.ipLimit, DEFAULT_RATE_LIMITS.windowMs);
        this.refillBucket(this.uidBucket, DEFAULT_RATE_LIMITS.uidLimit, DEFAULT_RATE_LIMITS.windowMs);

        if (isOrderRequest) {
            this.refillBucket(this.orderBucket, DEFAULT_RATE_LIMITS.orderLimit, 1000);
        }

        // Check if we have enough tokens
        if (this.ipBucket.tokens < weight || this.uidBucket.tokens < weight) {
            const waitTime = Math.min(
                Math.max(
                    (weight - this.ipBucket.tokens) / DEFAULT_RATE_LIMITS.ipLimit * DEFAULT_RATE_LIMITS.windowMs,
                    (weight - this.uidBucket.tokens) / DEFAULT_RATE_LIMITS.uidLimit * DEFAULT_RATE_LIMITS.windowMs
                ),
                5000 // Max wait 5 seconds
            );
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.consumeTokens(endpoint, isOrderRequest, depth + 1);
        }

        if (isOrderRequest && this.orderBucket.tokens < 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return this.consumeTokens(endpoint, isOrderRequest, depth + 1);
        }

        // Consume tokens
        this.ipBucket.tokens -= weight;
        this.uidBucket.tokens -= weight;
        if (isOrderRequest) {
            this.orderBucket.tokens -= 1;
        }
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
        const queryString = params ? new URLSearchParams(params).toString() : '';
        const bodyString = body ? JSON.stringify(body) : '';

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
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
        }

        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        try {
            const response = method === 'GET'
                ? await this.client.get<T>(url, { headers })
                : await this.client.post<T>(endpoint, body, { headers });

            return response.data;
        } catch (error: any) {
            // Extract useful error info without circular references
            const errorInfo = {
                method,
                endpoint,
                status: error.response?.status,
                code: error.response?.data?.code,
                message: error.response?.data?.msg || error.message,
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
        const response = await this.request<{ data: WeexFundingRate }>(
            'GET',
            '/capi/v2/market/fundingRate',
            { symbol }
        );
        return response.data;
    }

    async getTrades(symbol: string, limit: number = 100): Promise<WeexTrade[]> {
        const response = await this.request<{ data: WeexTrade[] }>(
            'GET',
            '/capi/v2/market/trades',
            { symbol, limit: String(limit) }
        );
        return response.data || [];
    }

    async getCandles(symbol: string, interval: string = '1m', limit: number = 100): Promise<WeexCandle[]> {
        const response = await this.request<{ data: WeexCandle[] }>(
            'GET',
            '/capi/v2/market/candles',
            { symbol, granularity: interval, limit: String(limit) }
        );
        return response.data || [];
    }

    async getContracts(): Promise<WeexContract[]> {
        const response = await this.request<{ data: WeexContract[] }>(
            'GET',
            '/capi/v2/market/contracts'
        );
        return response.data || [];
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
        const response = await this.request<{ data: WeexPosition[] }>(
            'GET',
            '/capi/v2/account/position/allPosition',
            undefined,
            undefined,
            true
        );
        return response.data || [];
    }

    async getPosition(symbol: string): Promise<WeexPosition | null> {
        const response = await this.request<{ data: WeexPosition }>(
            'GET',
            '/capi/v2/account/position/singlePosition',
            { symbol },
            undefined,
            true
        );
        return response.data || null;
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

    async cancelOrder(symbol: string, orderId: string): Promise<any> {
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
        const response = await this.request<{ data: WeexOrderDetail }>(
            'GET',
            '/capi/v2/order/detail',
            { orderId },
            undefined,
            true
        );
        return response.data;
    }

    async getCurrentOrders(symbol?: string): Promise<WeexOrderDetail[]> {
        const params = symbol ? { symbol } : undefined;
        const response = await this.request<{ data: WeexOrderDetail[] }>(
            'GET',
            '/capi/v2/order/current',
            params,
            undefined,
            true
        );
        return response.data || [];
    }

    async getHistoryOrders(symbol: string, limit: number = 50): Promise<WeexOrderDetail[]> {
        const response = await this.request<{ data: WeexOrderDetail[] }>(
            'GET',
            '/capi/v2/order/history',
            { symbol, pageSize: String(limit) },
            undefined,
            true
        );
        return response.data || [];
    }

    async getFills(symbol: string, limit: number = 50): Promise<WeexFill[]> {
        const response = await this.request<{ data: WeexFill[] }>(
            'GET',
            '/capi/v2/order/fills',
            { symbol, pageSize: String(limit) },
            undefined,
            true
        );
        return response.data || [];
    }

    async batchOrders(orders: WeexOrderRequest[]): Promise<WeexBatchOrderResponse> {
        return this.request<WeexBatchOrderResponse>(
            'POST',
            '/capi/v2/order/batchOrders',
            undefined,
            { orderList: orders },
            true,
            true
        );
    }

    async batchCancelOrders(symbol: string, orderIds: string[]): Promise<any> {
        return this.request(
            'POST',
            '/capi/v2/order/batchCancelOrders',
            undefined,
            { symbol, orderIds },
            true,
            true
        );
    }

    async closeAllPositions(symbol: string): Promise<any> {
        return this.request(
            'POST',
            '/capi/v2/order/closeAllPositions',
            undefined,
            { symbol },
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

// Singleton instance with proper async locking
let weexClientInstance: WeexClient | null = null;
let creationPromise: Promise<WeexClient> | null = null;

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

export async function getWeexClientAsync(credentials?: WeexCredentials): Promise<WeexClient> {
    // If new credentials provided, always create new instance
    if (credentials) {
        weexClientInstance = new WeexClient(credentials);
        return weexClientInstance;
    }

    // Return existing instance
    if (weexClientInstance) {
        return weexClientInstance;
    }

    // If creation is in progress, wait for it
    if (creationPromise) {
        return creationPromise;
    }

    // Create new instance
    creationPromise = Promise.resolve().then(() => {
        weexClientInstance = new WeexClient();
        return weexClientInstance;
    });

    try {
        return await creationPromise;
    } finally {
        creationPromise = null;
    }
}

export function resetWeexClient(): void {
    weexClientInstance = null;
    creationPromise = null;
}
