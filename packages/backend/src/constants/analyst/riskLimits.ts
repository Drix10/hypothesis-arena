/**
 * Global Risk Management Constants
 * 
 * Applied to ALL analysts regardless of methodology.
 * Designed to prevent catastrophic losses in leveraged crypto trading.
 */

export const GLOBAL_RISK_LIMITS = {
    MAX_SAFE_LEVERAGE: 5, // Never exceed 5x leverage in crypto
    MAX_POSITION_SIZE_PERCENT: 30, // Max 30% of portfolio in single position (matches FLOW.md and RISK_COUNCIL_VETO_TRIGGERS)

    // Maximum total capital allocated across all leveraged positions (not leveraged notional)
    // Example: If account = 1000 USDT and MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT = 30:
    //   - Can have 1 position at 30% (300 USDT capital)
    //   - Or 2 positions at 15% each (150 USDT capital each)
    //   - Or 3 positions at 10% each (100 USDT capital each)
    // This limits total capital at risk across all positions, not the sum of leveraged notional values
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: 30,

    CIRCUIT_BREAKERS: {
        // Level 1: Yellow Alert - Reduce Risk
        YELLOW_ALERT: {
            BTC_DROP_4H: 10, // BTC drops >10% in 4 hours
            FUNDING_RATE_EXTREME: 0.25, // |Funding rate| >0.25% (absolute value)
            PORTFOLIO_DRAWDOWN_24H: 10, // Portfolio down >10% in 24 hours
            ACTION: 'Reduce all leverage to 3x max, close speculative positions'
        },
        // Level 2: Orange Alert - Major Risk Reduction
        ORANGE_ALERT: {
            BTC_DROP_4H: 15, // BTC drops >15% in 4 hours
            FUNDING_RATE_EXTREME: 0.4, // |Funding rate| >0.4% (absolute value)
            PORTFOLIO_DRAWDOWN_24H: 15, // Portfolio down >15% in 24 hours
            ACTION: 'Reduce all leverage to 2x max, close all positions with size <5'
        },
        // Level 3: Red Alert - Emergency Exit
        RED_ALERT: {
            BTC_DROP_4H: 20, // BTC drops >20% in 4 hours (liquidation cascade)
            PORTFOLIO_DRAWDOWN_24H: 25, // Portfolio down >25% in 24 hours
            ACTION: 'Close ALL leveraged positions immediately, convert to stablecoins'
        }
    },

    // Stop loss requirements by analyst methodology (percentage from entry price)
    // Calibrated for MAX_SAFE_LEVERAGE = 5x. At 5x leverage, a 20% stop = 100% account loss.
    // These values ensure worst-case (leverage × stopPercent) stays below ~90% liquidation threshold.
    // If MAX_SAFE_LEVERAGE changes, these values must be updated proportionally.
    STOP_LOSS_REQUIREMENTS: {
        VALUE: 12, // Max -12% from entry or 200-week MA break (5x × 12% = 60% notional loss)
        GROWTH: 12, // Max -12% from entry or narrative breaks (5x × 12% = 60% notional loss)
        TECHNICAL: 8, // Max -8% from entry or key support breaks (5x × 8% = 40% notional loss)
        MACRO: 12, // Max -12% from entry or macro thesis invalidates (5x × 12% = 60% notional loss)
        SENTIMENT: 10, // Max -10% from entry or sentiment reverses (5x × 10% = 50% notional loss)
        RISK: 8, // Max -8% from entry (most conservative, 5x × 8% = 40% notional loss)
        QUANT: 10, // Max -10% from entry or statistical edge disappears (5x × 10% = 50% notional loss)
        CONTRARIAN: 8 // Max -8% from entry or extreme becomes more extreme (5x × 8% = 40% notional loss)
    }
};

/**
 * @deprecated Use GLOBAL_RISK_LIMITS.MAX_POSITION_SIZE_PERCENT instead.
 * This alias exists for backward compatibility with code that referenced MAX_POSITION_SIZE.
 */
export const MAX_POSITION_SIZE = GLOBAL_RISK_LIMITS.MAX_POSITION_SIZE_PERCENT;

/**
 * @deprecated Use GLOBAL_RISK_LIMITS.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT instead.
 * This alias exists for backward compatibility with code that referenced MAX_TOTAL_LEVERAGE_EXPOSURE.
 */
export const MAX_TOTAL_LEVERAGE_EXPOSURE = GLOBAL_RISK_LIMITS.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT;
