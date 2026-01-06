/**
 * Trading Context Types for v5.0.0
 * 
 * Rich context object passed to all analysts (like competitor's approach).
 * Contains account state, positions, market data with indicators, and trade history.
 */

import { TechnicalIndicators } from '../services/indicators/TechnicalIndicatorService';

/**
 * Main context object passed to analysts
 */
export interface TradingContext {
    invocation: InvocationInfo;
    account: AccountState;
    market_data: MarketDataWithIndicators[];
    instructions: Instructions;
}

/**
 * Invocation metadata
 */
export interface InvocationInfo {
    count: number;
    current_time: string;  // ISO timestamp - AI uses this for cooldowns
}

/**
 * Account state including positions and history
 */
export interface AccountState {
    balance: number;
    total_value: number;
    total_return_pct: number;
    profit_factor: number;
    positions: EnrichedPosition[];
    active_trades: ActiveTrade[];
    open_orders: OpenOrder[];
    recent_diary: DiaryEntry[];
    recent_fills: RecentFill[];
}

/**
 * Position with current market data
 */
export interface EnrichedPosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    entry_price: number;
    current_price: number;
    liquidation_price: number | null;
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    leverage: number;
    margin_used: number;
}

/**
 * Active trade with exit plan (CRITICAL for anti-churn)
 */
export interface ActiveTrade {
    asset: string;
    is_long: boolean;
    amount: number;
    entry_price: number;
    current_price: number;
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    exit_plan: string;           // CRITICAL: AI must respect this
    entry_thesis: string;
    opened_at: string;           // ISO timestamp
    hold_time_hours: number;
    entry_confidence: number;
    tp_price: number | null;
    sl_price: number | null;
}

/**
 * Open order on exchange
 */
export interface OpenOrder {
    symbol: string;
    order_id: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET' | 'STOP' | 'TAKE_PROFIT';
    size: number;
    price: number;
    trigger_price: number | null;
    created_at: string;
}

/**
 * Recent trade decision (diary entry)
 */
export interface DiaryEntry {
    timestamp: string;
    asset: string;
    action: string;
    allocation_usd: number;
    entry_price: number;
    tp_price: number | null;
    sl_price: number | null;
    exit_plan: string;
    rationale: string;
    champion: string;            // Which analyst won
    result: 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN' | null;
    realized_pnl: number | null;
}

/**
 * Recent fill from exchange
 */
export interface RecentFill {
    timestamp: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    fee: number;
    realized_pnl: number | null;
}

/**
 * Market data with technical indicators for one asset
 */
export interface MarketDataWithIndicators {
    asset: string;
    current_price: number;
    price_change_24h: number;
    price_change_24h_pct: number;
    volume_24h: number;
    high_24h: number;
    low_24h: number;

    // Technical indicators (from TechnicalIndicatorService)
    intraday: IntradayIndicators;
    long_term: LongTermIndicators;

    // Market structure
    open_interest: number | null;
    funding_rate: number;
    funding_annualized_pct: number;

    // Derived signals
    signals: TradingSignals;
}

/**
 * 5-minute timeframe indicators
 */
export interface IntradayIndicators {
    ema20: number;
    ema50: number;
    macd: number;
    macd_signal: number;
    macd_histogram: number;
    rsi7: number;
    rsi14: number;
    atr: number;
    atr_pct: number;             // ATR as % of price

    // Series for trend analysis
    series: {
        ema20: number[];         // Last 5 values
        macd: number[];
        rsi7: number[];
        rsi14: number[];
    };

    // Price relative to indicators
    price_vs_ema20: 'above' | 'below';
    price_vs_ema50: 'above' | 'below';
}

/**
 * 4-hour timeframe indicators
 */
export interface LongTermIndicators {
    ema20: number;
    ema50: number;
    ema200: number;
    atr: number;
    atr_pct: number;             // ATR as % of price
    macd: number;
    macd_signal: number;
    macd_histogram: number;
    rsi14: number;

    // Bollinger Bands
    bollinger_upper: number;
    bollinger_middle: number;
    bollinger_lower: number;

    // Trend classification
    trend: 'bullish' | 'bearish' | 'neutral';
    trend_strength: number;      // 0-100

    // Price relative to indicators
    price_vs_ema20: 'above' | 'below';
    price_vs_ema50: 'above' | 'below';
    price_vs_ema200: 'above' | 'below';
}

/**
 * Derived trading signals
 */
export interface TradingSignals {
    ema_crossover: 'golden' | 'death' | 'none';
    rsi_signal: 'overbought' | 'oversold' | 'neutral';
    macd_signal: 'bullish' | 'bearish' | 'neutral';
    bollinger_signal: 'upper_touch' | 'lower_touch' | 'squeeze' | 'expansion' | 'neutral';
    volatility: 'low' | 'medium' | 'high';
    funding_bias: 'long_crowded' | 'short_crowded' | 'neutral';
}

/**
 * Instructions embedded in context
 */
export interface Instructions {
    assets: readonly string[] | string[];
    anti_churn_rules: string;
    leverage_policy: string;
    trading_style: 'scalp' | 'swing';
}

/**
 * Performance metrics for context
 * 
 * NOTE: profit_factor = avgWin / avgLoss (not true Sharpe ratio which requires
 * daily returns and standard deviation calculation)
 */
export interface PerformanceMetrics {
    total_return_pct: number;
    profit_factor: number;
    win_rate: number;
    avg_win: number;
    avg_loss: number;
    max_drawdown: number;
    current_drawdown: number;
    trades_last_24h: number;
    trades_last_7d: number;
    total_trades: number;
}

/**
 * Convert TechnicalIndicators to MarketDataWithIndicators format
 */
export function convertIndicatorsToMarketData(
    symbol: string,
    ticker: {
        currentPrice: number;
        high24h: number;
        low24h: number;
        volume24h: number;
        change24h: number;
    },
    indicators: TechnicalIndicators,
    fundingRate: number,
    openInterest: number | null
): MarketDataWithIndicators {
    const currentPrice = ticker.currentPrice;

    // FIXED: Guard against empty indicator arrays before accessing [length - 1]
    // FIXED: Guard against division by zero when currentPrice is 0
    // FIXED: Validate indicator values to prevent misleading signals
    // NOTE: Default values for missing data:
    // - ema20/ema50: 0 indicates no data (caller should check before using in calculations)
    // - rsi: 50 is neutral (neither overbought nor oversold) - safe default for missing data
    // - price_vs_ema: 'below' when data is missing (conservative default)

    // Extract intraday values with validation
    // NOTE: ema20 is an array (last 5 values for trend analysis), ema50 is a single value
    // This is intentional - ema20 series is used for short-term trend detection,
    // while ema50 is only needed as current value for crossover detection
    const ema20_value = indicators.intraday.ema20.length > 0 ? indicators.intraday.ema20[indicators.intraday.ema20.length - 1] : 0;
    const ema50_value = indicators.intraday.ema50; // Single value, not array
    const rsi7_value = indicators.intraday.rsi7.length > 0 ? indicators.intraday.rsi7[indicators.intraday.rsi7.length - 1] : 50;
    const rsi14_value = indicators.intraday.rsi14.length > 0 ? indicators.intraday.rsi14[indicators.intraday.rsi14.length - 1] : 50;

    // Validate intraday EMA values are usable (non-zero, finite)
    const ema20_valid = Number.isFinite(ema20_value) && ema20_value > 0;
    const ema50_valid = Number.isFinite(ema50_value) && ema50_value > 0;

    // Validate long-term EMA values before comparison to prevent misleading signals
    const lt_ema20_valid = Number.isFinite(indicators.longTerm.ema20) && indicators.longTerm.ema20 > 0;
    const lt_ema50_valid = Number.isFinite(indicators.longTerm.ema50) && indicators.longTerm.ema50 > 0;
    const lt_ema200_valid = Number.isFinite(indicators.longTerm.ema200) && indicators.longTerm.ema200 > 0;

    return {
        asset: symbol,
        current_price: currentPrice,
        price_change_24h: ticker.change24h,
        // FIXED: Guard against division by zero when previous price equals zero
        price_change_24h_pct: (() => {
            const previousPrice = currentPrice - ticker.change24h;
            return previousPrice !== 0 ? (ticker.change24h / previousPrice) * 100 : 0;
        })(),
        volume_24h: ticker.volume24h,
        high_24h: ticker.high24h,
        low_24h: ticker.low24h,

        intraday: {
            ema20: ema20_value,
            ema50: ema50_value,
            macd: indicators.intraday.macd.macd,
            macd_signal: indicators.intraday.macd.signal,
            macd_histogram: indicators.intraday.macd.histogram,
            rsi7: rsi7_value,
            rsi14: rsi14_value,
            atr: indicators.intraday.atr,
            atr_pct: currentPrice !== 0 ? (indicators.intraday.atr / currentPrice) * 100 : 0,
            series: {
                ema20: indicators.intraday.ema20,
                // NOTE: MACD series contains only the current value. For trend analysis,
                // the AI should compare macd vs macd_signal and check histogram direction.
                // Full MACD history would require storing more candle data.
                macd: [indicators.intraday.macd.macd],
                rsi7: indicators.intraday.rsi7,
                rsi14: indicators.intraday.rsi14,
            },
            // FIXED: Only compare price vs EMA when EMA data is valid
            // When EMA is 0 or invalid, default to 'below' (conservative - no false bullish signals)
            price_vs_ema20: ema20_valid && currentPrice > ema20_value ? 'above' : 'below',
            price_vs_ema50: ema50_valid && currentPrice > ema50_value ? 'above' : 'below',
        },

        long_term: {
            ema20: indicators.longTerm.ema20,
            ema50: indicators.longTerm.ema50,
            ema200: indicators.longTerm.ema200,
            atr: indicators.longTerm.atr,
            atr_pct: currentPrice !== 0 ? (indicators.longTerm.atr / currentPrice) * 100 : 0,
            macd: indicators.longTerm.macd.macd,
            macd_signal: indicators.longTerm.macd.signal,
            macd_histogram: indicators.longTerm.macd.histogram,
            rsi14: indicators.longTerm.rsi14,
            bollinger_upper: indicators.longTerm.bollingerBands.upper,
            bollinger_middle: indicators.longTerm.bollingerBands.middle,
            bollinger_lower: indicators.longTerm.bollingerBands.lower,
            trend: indicators.longTerm.trend,
            trend_strength: indicators.signals.trendStrength,
            // FIXED: Only compare price vs EMA when EMA data is valid
            // When EMA is 0 or invalid, default to 'below' (conservative - no false bullish signals)
            price_vs_ema20: lt_ema20_valid && currentPrice > indicators.longTerm.ema20 ? 'above' : 'below',
            price_vs_ema50: lt_ema50_valid && currentPrice > indicators.longTerm.ema50 ? 'above' : 'below',
            price_vs_ema200: lt_ema200_valid && currentPrice > indicators.longTerm.ema200 ? 'above' : 'below',
        },

        open_interest: openInterest,
        funding_rate: fundingRate,
        funding_annualized_pct: fundingRate * 3 * 365 * 100,  // 3 funding periods per day

        signals: {
            ema_crossover: indicators.signals.emaCrossover,
            rsi_signal: indicators.signals.rsiSignal,
            macd_signal: indicators.signals.macdSignal,
            bollinger_signal: getBollingerSignal(currentPrice, indicators.longTerm.bollingerBands),
            volatility: indicators.signals.volatility,
            funding_bias: getFundingBias(fundingRate),
        },
    };
}

/**
 * Determine Bollinger Band signal
 * 
 * FIXED: Added division by zero protection for bb.middle, bb.upper, bb.lower
 * NOTE: Zero guards are placed at the top to prevent any calculations with invalid data
 */
function getBollingerSignal(
    price: number,
    bb: { upper: number; middle: number; lower: number }
): 'upper_touch' | 'lower_touch' | 'squeeze' | 'expansion' | 'neutral' {
    // Guard against division by zero - check ALL band values upfront before any calculations
    // This prevents misleading bandwidth calculations when bands are invalid
    if (bb.middle === 0 || bb.upper === 0 || bb.lower === 0) return 'neutral';

    const bandwidth = (bb.upper - bb.lower) / bb.middle;

    if (bandwidth < 0.02) return 'squeeze';
    if (bandwidth > 0.08) return 'expansion';

    const upperDist = Math.abs(price - bb.upper) / bb.upper;
    const lowerDist = Math.abs(price - bb.lower) / bb.lower;

    if (upperDist < 0.005) return 'upper_touch';
    if (lowerDist < 0.005) return 'lower_touch';

    return 'neutral';
}

/**
 * Determine funding rate bias
 * 
 * FIXED: Added validation for NaN/Infinity to prevent invalid comparisons
 * 
 * NOTE: Funding rate thresholds (0.0003 = 0.03% per 8h period):
 * - > 0.03%: Longs are paying shorts significantly, indicating long crowding
 * - < -0.03%: Shorts are paying longs significantly, indicating short crowding
 * - Between: Neutral funding, no significant crowding
 * 
 * These thresholds are conservative - extreme crowding is typically > 0.1% (0.001)
 */
function getFundingBias(fundingRate: number): 'long_crowded' | 'short_crowded' | 'neutral' {
    // Guard against NaN/Infinity - treat invalid values as neutral
    if (!Number.isFinite(fundingRate)) return 'neutral';

    if (fundingRate > 0.0003) return 'long_crowded';
    if (fundingRate < -0.0003) return 'short_crowded';
    return 'neutral';
}
