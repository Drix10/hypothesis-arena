import crypto from 'crypto';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { WeexApiError, RateLimitError } from '../../utils/errors';
import { validateWeexOrder } from '../../shared/utils/weex';
import {
    WeexCredentials,
    WeexOrderRequest,
    WeexOrderResponse,
    WeexClosePositionsResult,
    WeexClosePositionsResponse,
    WeexPosition,
    WeexPositionRaw,
    normalizeWeexPosition,
    WeexAccount,
    WeexAccountAssets,
    WeexTicker,
    WeexDepth,
    WeexServerTime,
    WeexFundingRate,
    WeexCandle,
    WeexContract,
    WeexOrderDetail,
    WeexFill,
    ENDPOINT_WEIGHTS,
    DEFAULT_RATE_LIMITS,
} from '../../shared/types/weex';

// Configuration from environment (via config)
const WEEX_REQUEST_TIMEOUT = config.weexClient.requestTimeoutMs;
const MAX_ATTEMPTS = config.weexClient.rateLimitMaxAttempts;
const MAX_TOTAL_WAIT_MS = config.weexClient.rateLimitMaxWaitMs;

interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

export class WeexClient {
    private client: AxiosInstance;
    private credentials: WeexCredentials;
    private serverTimeOffset: number = 0;
    private lastTimeSync: number = 0;
    private syncInProgress: boolean = false; // Prevent concurrent syncs
    private ipBucket: TokenBucket;
    private uidBucket: TokenBucket;
    private orderBucket: TokenBucket;
    private responseInterceptorId: number | null = null;
    private consumeLock: Promise<void> | null = null; // Mutex for rate limit consumption

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
            'Accept': 'application/json',
        };

        this.client = axios.create({
            baseURL: config.weex.baseUrl,
            timeout: WEEX_REQUEST_TIMEOUT, // Configurable timeout for slow proxy/WEEX responses
            headers: defaultHeaders,
        });

        // Validate rate limit configuration to prevent infinite loops
        if (DEFAULT_RATE_LIMITS.ipLimit < 1 || DEFAULT_RATE_LIMITS.uidLimit < 1 || DEFAULT_RATE_LIMITS.orderLimit < 1) {
            throw new Error('Rate limits must be >= 1 to prevent infinite wait loops');
        }
        if (DEFAULT_RATE_LIMITS.ipWindowMs < 1000 || DEFAULT_RATE_LIMITS.uidWindowMs < 1000 || DEFAULT_RATE_LIMITS.orderWindowMs < 1000) {
            throw new Error('Rate limit windows must be >= 1000ms');
        }

        // Initialize rate limit buckets
        const now = Date.now();
        this.ipBucket = { tokens: DEFAULT_RATE_LIMITS.ipLimit, lastRefill: now };
        this.uidBucket = { tokens: DEFAULT_RATE_LIMITS.uidLimit, lastRefill: now };
        this.orderBucket = { tokens: DEFAULT_RATE_LIMITS.orderLimit, lastRefill: now };

        this.setupInterceptors();
    }

    private setupInterceptors() {
        // Store interceptor ID for cleanup
        this.responseInterceptorId = this.client.interceptors.response.use(
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

    /**
     * Cleanup resources to prevent memory leaks
     * CRITICAL: Must be called when WeexClient is no longer needed
     * 
     * FIXED: Added cleanup state tracking to prevent confusing runtime errors
     */
    private isCleanedUp: boolean = false;

    cleanup(): void {
        if (this.isCleanedUp) {
            logger.warn('WeexClient.cleanup() called multiple times - already cleaned up');
            return;
        }

        this.isCleanedUp = true;

        // Remove response interceptor
        if (this.responseInterceptorId !== null) {
            this.client.interceptors.response.eject(this.responseInterceptorId);
            this.responseInterceptorId = null;
        }

        logger.info('WeexClient cleaned up successfully');
    }

    /**
     * Check if client has been cleaned up
     * Useful for preventing operations on a cleaned-up client
     */
    isDestroyed(): boolean {
        return this.isCleanedUp;
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

        // Validate timestamp is reasonable to prevent signature failures
        // Valid range: 2020-01-01 to 2100-01-01
        const MIN_TIMESTAMP = 1577836800000;
        const MAX_TIMESTAMP = 4102444800000;
        if (ts < MIN_TIMESTAMP || ts > MAX_TIMESTAMP) {
            logger.error(`Timestamp out of range: ${ts} (offset: ${this.serverTimeOffset}ms) - re-syncing server time`);
            // Reset offset and re-sync
            this.serverTimeOffset = 0;
            this.lastTimeSync = 0;
            try {
                await this.syncServerTime();
                // Recompute timestamp with new offset
                const newTs = Math.round(Date.now() + this.serverTimeOffset);
                // Validate new timestamp
                if (newTs >= MIN_TIMESTAMP && newTs <= MAX_TIMESTAMP) {
                    return String(newTs);
                } else {
                    // If still invalid after sync, use current time without offset
                    logger.error(`Timestamp still invalid after re-sync: ${newTs}, using Date.now()`);
                    return String(Date.now());
                }
            } catch (syncError) {
                // If sync fails, use current time without offset
                logger.error('Failed to re-sync server time:', syncError);
                return String(Date.now());
            }
        }

        return String(ts);
    }

    private async syncServerTime(): Promise<void> {
        // Prevent concurrent sync operations (race condition fix)
        if (this.syncInProgress) {
            return;
        }

        this.syncInProgress = true;
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
        } finally {
            this.syncInProgress = false;
        }
    }

    private refillBucket(bucket: TokenBucket, limit: number, windowMs: number): void {
        const now = Date.now();
        const elapsed = now - bucket.lastRefill;

        // Reset if elapsed time is unreasonably large (> 1 hour) or negative (clock skew)
        // This prevents overflow and handles system clock changes
        if (elapsed > 3600000 || elapsed < 0) {
            if (elapsed < 0) {
                logger.warn(`Clock skew detected: elapsed time is negative (${elapsed}ms). Resetting rate limiter.`);
            } else {
                logger.debug(`Long elapsed time (${elapsed}ms), resetting rate limiter bucket.`);
            }
            bucket.tokens = limit;
            bucket.lastRefill = now;
            return;
        }

        // CRITICAL FIX: Validate windowMs to prevent division by zero
        if (!Number.isFinite(windowMs) || windowMs <= 0) {
            logger.error(`Invalid windowMs: ${windowMs}. Resetting bucket.`);
            bucket.tokens = limit;
            bucket.lastRefill = now;
            return;
        }

        const refillAmount = (elapsed / windowMs) * limit;

        // CRITICAL FIX: Protect against Infinity from extreme elapsed values
        if (!Number.isFinite(refillAmount) || refillAmount < 0) {
            logger.warn(`Invalid refillAmount: ${refillAmount} (elapsed: ${elapsed}ms). Resetting bucket.`);
            bucket.tokens = limit;
            bucket.lastRefill = now;
            return;
        }

        bucket.tokens = Math.min(limit, bucket.tokens + refillAmount);
        bucket.lastRefill = now;
    }

    private async consumeTokens(endpoint: string, isOrderRequest: boolean): Promise<void> {
        const weight = ENDPOINT_WEIGHTS[endpoint] || 1;
        let attempts = 0;
        const startTime = Date.now();

        // Validate rate limits are configured correctly
        if (DEFAULT_RATE_LIMITS.ipLimit <= 0 || DEFAULT_RATE_LIMITS.uidLimit <= 0) {
            throw new Error('Invalid rate limit configuration: limits must be > 0');
        }

        while (attempts < MAX_ATTEMPTS) {
            // Check if we've exceeded total wait time
            if (Date.now() - startTime > MAX_TOTAL_WAIT_MS) {
                throw new RateLimitError(`Rate limit retry timeout after ${MAX_TOTAL_WAIT_MS}ms`);
            }

            // ACQUIRE MUTEX for bucket check and decrement
            // CRITICAL FIX: Use single check with timeout instead of infinite loop
            if (this.consumeLock) {
                const lockWaitStart = Date.now();
                try {
                    // Wait for existing lock with 5s timeout
                    await Promise.race([
                        this.consumeLock,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Lock timeout')), 5000))
                    ]);
                } catch (error) {
                    // Lock timeout or error - force release and continue
                    const waitTime = Date.now() - lockWaitStart;
                    logger.error(`[WEEX] Lock wait timeout/error after ${waitTime}ms, forcing lock release`);
                    this.consumeLock = null;
                }
            }

            let resolveLock: () => void = () => { };
            this.consumeLock = new Promise<void>(resolve => {
                resolveLock = resolve;
            });

            try {
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

                    // Warn if tokens are running low (< 10%)
                    if (this.ipBucket.tokens < DEFAULT_RATE_LIMITS.ipLimit * 0.1) {
                        logger.warn(`IP rate limit tokens low: ${this.ipBucket.tokens.toFixed(0)}/${DEFAULT_RATE_LIMITS.ipLimit}`);
                    }
                    if (this.uidBucket.tokens < DEFAULT_RATE_LIMITS.uidLimit * 0.1) {
                        logger.warn(`UID rate limit tokens low: ${this.uidBucket.tokens.toFixed(0)}/${DEFAULT_RATE_LIMITS.uidLimit}`);
                    }

                    // CRITICAL FIX: Release lock before returning to prevent memory leak
                    resolveLock();
                    this.consumeLock = null;
                    return;
                }

                // Tokens not available - calculate wait time while holding lock to get accurate tokens
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

                if (attempts === 0) {
                    logger.debug(`[WEEX] Rate limited, waiting ${waitTime.toFixed(0)}ms`);
                }

                // RELEASE LOCK before waiting to allow other requests to try
                resolveLock();
                this.consumeLock = null;

                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempts++;
                continue; // Retry after waiting

            } finally {
                // Ensure lock is always released
                resolveLock();
            }
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
        // FIXED: Check if client has been cleaned up before making requests
        if (this.isCleanedUp) {
            throw new Error('WeexClient has been cleaned up - cannot make requests. Create a new instance.');
        }

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

            // Debug logging when DEBUG_WEEX is enabled
            if (process.env.DEBUG_WEEX === 'true') {
                logger.debug(`[WEEX] ${method} ${endpoint}${queryString}`);
                logger.debug(`[WEEX] Timestamp: ${timestamp}`);
                logger.debug(`[WEEX] Headers: ACCESS-KEY=${this.credentials.apiKey.substring(0, 10)}...`);
            }
        }

        // For URL: queryString already has "?" if present
        const url = queryString ? `${endpoint}${queryString}` : endpoint;

        const requestStart = Date.now();

        try {
            const response = method === 'GET'
                ? await this.client.get<T>(url, {
                    headers,
                    timeout: WEEX_REQUEST_TIMEOUT, // Configurable timeout per request
                })
                : await this.client.post<T>(url, body, {
                    headers,
                    timeout: WEEX_REQUEST_TIMEOUT, // Configurable timeout per request
                });

            const requestDuration = Date.now() - requestStart;

            // Only log slow requests (>1s) or order requests
            if (requestDuration > 1000 || isOrderRequest) {
                logger.debug(`[WEEX] ${method} ${endpoint} completed in ${requestDuration}ms`);
            }

            return response.data;
        } catch (error: any) {
            const requestDuration = Date.now() - requestStart;

            // Extract useful error info without circular references
            const errorInfo = {
                method,
                endpoint,
                status: error.response?.status,
                code: error.response?.data?.code,
                message: error.response?.data?.msg || error.message,
                isPrivate,
                duration: requestDuration,
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
        logger.debug('🌐 WEEX API: Calling /capi/v2/account/assets...');
        const startTime = Date.now();

        const response = await this.request<any>(
            'GET',
            '/capi/v2/account/assets',
            undefined,
            undefined,
            true
        );

        const duration = Date.now() - startTime;
        logger.debug(`✅ WEEX API: /capi/v2/account/assets completed in ${duration}ms`);

        // Response is an array of assets, convert to expected format
        if (Array.isArray(response)) {
            const usdt = response.find((a: any) => a.coinName === 'USDT') || response[0] || {};
            logger.debug(`💰 WEEX Assets: available=${usdt.available}, equity=${usdt.equity}`);
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
        // Validate order before submission
        try {
            validateWeexOrder({
                symbol: order.symbol,
                size: order.size,
                price: order.price,
                type: order.type,
                order_type: order.order_type,
                match_price: order.match_price,
                client_oid: order.client_oid,
            });
        } catch (error) {
            logger.error('Order validation failed:', error);
            throw error;
        }

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

    async closeAllPositions(symbol?: string): Promise<WeexClosePositionsResponse> {
        // Correct endpoint is /capi/v2/order/closePositions (not closeAllPositions)
        // symbol is optional - if not provided, closes all positions
        const body = symbol ? { symbol } : {};
        const response = await this.request<
            WeexClosePositionsResponse |
            { data: WeexClosePositionsResponse } |
            WeexClosePositionsResult
        >(
            'POST',
            '/capi/v2/order/closePositions',
            undefined,
            body,
            true,
            true
        );
        const data = (response as any).data ?? response;
        return Array.isArray(data) ? data : [data as WeexClosePositionsResult];
    }

    /**
     * Close a partial position by placing a close order
     * @param symbol - Trading pair symbol
     * @param side - Position side (LONG or SHORT)
     * @param sizeToClose - Amount to close (as string to preserve precision)
     * @param priceType - '0' for limit, '1' for market (default: market)
     * @param price - Required if priceType is '0' (limit order)
     * @returns Order response with order_id
     */
    async closePartialPosition(
        symbol: string,
        side: 'LONG' | 'SHORT',
        sizeToClose: string,
        priceType: '0' | '1' = '1',
        price?: string
    ): Promise<WeexOrderResponse> {
        // Validate inputs
        if (!symbol || typeof symbol !== 'string') {
            throw new Error('Invalid symbol for partial close');
        }
        if (side !== 'LONG' && side !== 'SHORT') {
            throw new Error(`Invalid side for partial close: ${side}. Must be LONG or SHORT`);
        }

        // FIXED: Validate parseFloat returns finite number, not NaN
        const parsedSize = parseFloat(sizeToClose);
        if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
            throw new Error(`Invalid size to close: ${sizeToClose}`);
        }

        // FIXED: Validate price is finite number, not NaN
        if (priceType === '0') {
            const parsedPrice = parseFloat(price || '0');
            if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
                throw new Error('Price is required for limit orders (priceType=0) and must be > 0');
            }
        }

        // Type 3 = Close long, Type 4 = Close short
        const type = side === 'LONG' ? '3' : '4';

        const order: WeexOrderRequest = {
            symbol,
            client_oid: `close_partial_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            size: sizeToClose,
            type,
            order_type: '0', // Normal order
            match_price: priceType,
            price: priceType === '1' ? '0' : price!, // Market orders use price=0
        };

        logger.info(`Closing partial ${side} position:`, {
            symbol,
            size: sizeToClose,
            priceType: priceType === '1' ? 'market' : 'limit',
            price: priceType === '1' ? 'market' : price
        });

        return this.placeOrder(order);
    }

    /**
     * Place a take-profit or stop-loss order
     * @param params - TP/SL order parameters
     * @returns Array with order result (orderId and success flag)
     */
    async placeTpSlOrder(params: {
        symbol: string;
        planType: 'profit_plan' | 'loss_plan';
        triggerPrice: number;
        executePrice?: number; // 0 or undefined = market, >0 = limit
        size: number;
        positionSide: 'long' | 'short';
        marginMode?: 1 | 3;
    }): Promise<{ orderId: number; success: boolean }[]> {
        // Validate inputs
        if (!params.symbol || typeof params.symbol !== 'string') {
            throw new Error('Invalid symbol for TP/SL order');
        }
        if (params.planType !== 'profit_plan' && params.planType !== 'loss_plan') {
            throw new Error(`Invalid planType: ${params.planType}. Must be profit_plan or loss_plan`);
        }
        if (!Number.isFinite(params.triggerPrice) || params.triggerPrice <= 0) {
            throw new Error(`Invalid trigger price: ${params.triggerPrice}`);
        }
        if (!Number.isFinite(params.size) || params.size <= 0) {
            throw new Error(`Invalid size: ${params.size}`);
        }
        if (params.positionSide !== 'long' && params.positionSide !== 'short') {
            throw new Error(`Invalid positionSide: ${params.positionSide}. Must be long or short`);
        }

        // FIXED: Validate executePrice if provided
        if (params.executePrice !== undefined) {
            if (!Number.isFinite(params.executePrice) || params.executePrice < 0) {
                throw new Error(`Invalid execute price: ${params.executePrice}. Must be >= 0 (0 = market)`);
            }
        }

        const body = {
            symbol: params.symbol,
            clientOrderId: `tpsl_${params.planType}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            planType: params.planType,
            triggerPrice: String(params.triggerPrice),
            executePrice: String(params.executePrice || 0), // 0 = market execution
            size: String(params.size),
            positionSide: params.positionSide,
            marginMode: params.marginMode || 1, // Default to cross mode
        };

        logger.info(`Placing ${params.planType} order:`, {
            symbol: params.symbol,
            triggerPrice: params.triggerPrice,
            executePrice: params.executePrice || 'market',
            size: params.size,
            positionSide: params.positionSide
        });

        const response = await this.request<{ orderId: number; success: boolean }[]>(
            'POST',
            '/capi/v2/order/placeTpSlOrder',
            undefined,
            body,
            true,
            true
        );

        // Response is array: [{ orderId: number, success: boolean }]
        return Array.isArray(response) ? response : [response as any];
    }

    /**
     * Modify an existing take-profit or stop-loss order
     * @param params - Modification parameters
     * @returns Response with code and message
     */
    async modifyTpSlOrder(params: {
        orderId: string;
        triggerPrice: number;
        executePrice?: number; // 0 or undefined = market, >0 = limit
        triggerPriceType?: 1 | 3; // 1=Last price (default), 3=Mark price
    }): Promise<{ code: string; msg: string; requestTime: number; data: any }> {
        // Validate inputs
        if (!params.orderId || typeof params.orderId !== 'string') {
            throw new Error('Invalid orderId for TP/SL modification');
        }
        if (!Number.isFinite(params.triggerPrice) || params.triggerPrice <= 0) {
            throw new Error(`Invalid trigger price: ${params.triggerPrice}`);
        }
        if (params.triggerPriceType && params.triggerPriceType !== 1 && params.triggerPriceType !== 3) {
            throw new Error(`Invalid triggerPriceType: ${params.triggerPriceType}. Must be 1 (Last) or 3 (Mark)`);
        }

        const body: any = {
            orderId: params.orderId,
            triggerPrice: String(params.triggerPrice),
            triggerPriceType: params.triggerPriceType || 1, // Default to last price
        };

        // Only include executePrice if provided
        if (params.executePrice !== undefined) {
            body.executePrice = String(params.executePrice);
        }

        logger.info(`Modifying TP/SL order:`, {
            orderId: params.orderId,
            triggerPrice: params.triggerPrice,
            executePrice: params.executePrice !== undefined ? params.executePrice : 'unchanged',
            triggerPriceType: params.triggerPriceType || 1
        });

        return this.request(
            'POST',
            '/capi/v2/order/modifyTpSlOrder',
            undefined,
            body,
            true,
            true
        );
    }

    /**
     * Get current plan orders (trigger orders, TP/SL orders)
     * @param symbol - Optional symbol filter
     * @returns Array of plan orders
     */
    async getCurrentPlanOrders(symbol?: string): Promise<any[]> {
        const params = symbol ? { symbol } : undefined;

        logger.debug(`Fetching current plan orders${symbol ? ` for ${symbol}` : ''}`);

        const response = await this.request<any[] | { data: any[] }>(
            'GET',
            '/capi/v2/order/currentPlan',
            params,
            undefined,
            true
        );

        // Handle both response formats
        return Array.isArray(response) ? response : (response as any).data || [];
    }

    /**
     * Adjust position margin (add or reduce margin for isolated positions)
     * @param params - Margin adjustment parameters
     * @returns Response with success status
     */
    async adjustPositionMargin(params: {
        isolatedPositionId: number;
        collateralAmount: string; // Positive = add, negative = reduce
        coinId?: number; // Default: 2 (USDT)
    }): Promise<any> {
        // Validate inputs
        if (!Number.isFinite(params.isolatedPositionId) || params.isolatedPositionId <= 0) {
            throw new Error(`Invalid isolatedPositionId: ${params.isolatedPositionId}`);
        }
        if (!params.collateralAmount || typeof params.collateralAmount !== 'string') {
            throw new Error(`Invalid collateralAmount: ${params.collateralAmount}`);
        }
        const amount = parseFloat(params.collateralAmount);
        if (!Number.isFinite(amount) || amount === 0) {
            throw new Error(`Invalid collateralAmount value: ${params.collateralAmount}. Must be non-zero number`);
        }

        const action = amount > 0 ? 'Adding' : 'Reducing';
        logger.info(`${action} margin for isolated position:`, {
            isolatedPositionId: params.isolatedPositionId,
            collateralAmount: params.collateralAmount,
            coinId: params.coinId || 2
        });

        const body = {
            isolatedPositionId: params.isolatedPositionId,
            collateralAmount: params.collateralAmount,
            coinId: params.coinId || 2 // Default to USDT
        };

        return this.request(
            'POST',
            '/capi/v2/account/adjustMargin',
            undefined,
            body,
            true
        );
    }

    async uploadAILog(log: {
        orderId?: string | number | null;
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
    // FIXED: Consider implications of cleaning up existing instances
    // If new credentials provided, cleanup old instance first to prevent memory leaks
    // WARNING: This will invalidate any existing references to the old client
    // Callers should not cache WeexClient instances - always use getWeexClient()
    if (credentials && weexClientInstance) {
        logger.warn('Creating new WeexClient with different credentials - cleaning up old instance. ' +
            'Any cached references to the old client will become invalid.');
        weexClientInstance.cleanup();
        weexClientInstance = null;
    }

    if (credentials) {
        weexClientInstance = new WeexClient(credentials);
        return weexClientInstance;
    }

    // Return existing instance
    if (weexClientInstance) {
        // FIXED: Check if instance was destroyed and recreate if needed
        if (weexClientInstance.isDestroyed()) {
            logger.warn('Existing WeexClient was destroyed, creating new instance');
            weexClientInstance = new WeexClient();
        }
        return weexClientInstance;
    }

    // Create new instance synchronously (safe since constructor is sync)
    weexClientInstance = new WeexClient();
    return weexClientInstance;
}

/**
 * Reset/cleanup the WeexClient singleton
 * Call this during graceful shutdown to release resources
 * FIXED: Added for proper cleanup on application shutdown
 */
export function resetWeexClient(): void {
    if (weexClientInstance) {
        weexClientInstance.cleanup();
        weexClientInstance = null;
        logger.info('WeexClient singleton reset');
    }
}
