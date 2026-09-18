/**
 * Market Data Types
 * 
 * Shared types for market data across the application.
 */

/**
 * Extended market data with all available fields from WEEX
 * 
 * PRECISION NOTE: JavaScript numbers are IEEE 754 double-precision floats.
 * - Safe integer range: ±2^53 (9,007,199,254,740,992)
 * - Decimal precision: ~15-17 significant digits
 * 
 * For typical crypto trading values:
 * - BTC price ($100,000): Full precision maintained
 * - Small altcoin prices ($0.00001234): Full precision maintained
 * - Volume in USD ($1B): Full precision maintained
 * 
 * Precision loss only occurs with extreme values (>$9 quadrillion).
 * For production systems handling very large values, consider:
 * - Using string representation for prices
 * - Using Decimal.js library for calculations
 * - Storing as integer cents/satoshis
 */
export interface ExtendedMarketData {
    symbol: string;
    currentPrice: number;
    high24h: number;
    low24h: number;
    /**
     * 24-hour trading volume in quote currency (USDT for most pairs).
     * Example: 1000000 means $1,000,000 USDT traded in the last 24 hours.
     */
    volume24h: number;
    /**
     * 24-hour price change in USD (absolute value, not percentage).
     * Calculated as: currentPrice - priceAt24hAgo
     * Positive = price increased, Negative = price decreased.
     * Example: If BTC was $100,000 yesterday and is $101,500 now, change24h = 1500
     * To get percentage: (change24h / (currentPrice - change24h)) * 100
     */
    change24h: number;
    /**
     * Unix timestamp in milliseconds when this data was fetched.
     * Use Date.now() - fetchTimestamp to calculate data age.
     * Example: 1704067200000 = January 1, 2024 00:00:00 UTC
     */
    fetchTimestamp: number;
    markPrice: number;
    indexPrice: number;
    bestBid: number;
    bestAsk: number;
    /**
     * Funding rate as a decimal (e.g., 0.0001 = 0.01% per funding period).
     * WEEX uses 8-hour funding periods (3 per day).
     * Positive = longs pay shorts, Negative = shorts pay longs.
     * undefined = funding rate data unavailable from exchange.
     */
    fundingRate?: number;
    /**
     * Open interest in contracts (number of outstanding derivative contracts).
     * undefined = open interest data unavailable from exchange.
     */
    openInterest?: number;
}
