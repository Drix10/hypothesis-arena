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
    WeexTicker,
    WeexDepth,
    WeexServerTime,
    WeexFundingRate,
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

                throw error;
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
        // Sync time if needed (every 60 seconds)
        if (Date.now() - this.lastTimeSync > 60000) {
            await this.syncServerTime();
        }
        return String(Date.now() + this.serverTimeOffset);
    }

    private async syncServerTime(): Promise<void> {
        try {
            const localBefore = Date.now();
            const response = await this.client.get<WeexServerTime>('/capi/v2/market/time');
            const localAfter = Date.now();
            const latency = (localAfter - localBefore) / 2;

            this.serverTimeOffset = response.data.timestamp - localBefore - latency;
            this.lastTimeSync = Date.now();

            logger.debug(`Server time synced, offset: ${this.serverTimeOffset}ms`);
        } catch (error) {
            logger.error('Failed to sync server time:', error);
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
        } catch (error) {
            logger.error(`WEEX API error: ${method} ${endpoint}`, error);
            throw error;
        }
    }

    // Public endpoints
    async getServerTime(): Promise<WeexServerTime> {
        return this.request<WeexServerTime>('GET', '/capi/v2/market/time');
    }

    async getTicker(symbol: string): Promise<WeexTicker> {
        const response = await this.request<{ data: WeexTicker }>(
            'GET',
            '/capi/v2/market/ticker',
            { symbol }
        );
        return response.data;
    }

    async getAllTickers(): Promise<WeexTicker[]> {
        const response = await this.request<{ data: WeexTicker[] }>(
            'GET',
            '/capi/v2/market/tickers'
        );
        return response.data;
    }

    async getDepth(symbol: string, limit: number = 15): Promise<WeexDepth> {
        const response = await this.request<WeexDepth>(
            'GET',
            '/capi/v2/market/depth',
            { symbol, limit: String(limit) }
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

    // Private endpoints
    async getAccount(): Promise<WeexAccount[]> {
        const response = await this.request<{ data: WeexAccount[] }>(
            'GET',
            '/capi/v2/account/accounts',
            undefined,
            undefined,
            true
        );
        return response.data;
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
            '/capi/v2/order/cancelOrder',
            undefined,
            { symbol, orderId },
            true,
            true
        );
    }

    async getOrder(symbol: string, orderId: string): Promise<any> {
        return this.request(
            'GET',
            '/capi/v2/order/detail',
            { symbol, orderId },
            undefined,
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

// Singleton instance with proper locking
let weexClientInstance: WeexClient | null = null;
let isCreating = false;

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

    // Prevent race condition during creation
    if (isCreating) {
        // Wait and retry - simple spinlock for sync context
        throw new Error('WeexClient is being initialized, please retry');
    }

    isCreating = true;
    try {
        weexClientInstance = new WeexClient();
        return weexClientInstance;
    } finally {
        isCreating = false;
    }
}

export function resetWeexClient(): void {
    weexClientInstance = null;
}
