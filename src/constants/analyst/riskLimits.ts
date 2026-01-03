/**
 * Global Risk Management Constants
 * 
 * Applied to ALL analysts regardless of methodology.
 * Designed to prevent catastrophic losses in leveraged crypto trading.
 * 
 * IMPORTANT: Any changes to MAX_SAFE_LEVERAGE require:
 * 1. Risk assessment review
 * 2. Stop loss adjustment validation
 * 3. Stakeholder sign-off
 * 4. Integration/backtest validation
 */

export const GLOBAL_RISK_LIMITS = {
    // Maximum leverage allowed by the system
    // WARNING: High leverage significantly increases liquidation risk
    // At 5x leverage, a 20% adverse move = liquidation
    // At 3x leverage, a 33% adverse move = liquidation (safer)
    // This is the ABSOLUTE MAXIMUM - config.autonomous.maxLeverage can be lower but not higher
    // CRITICAL: Do NOT increase without risk assessment and stakeholder sign-off
    MAX_SAFE_LEVERAGE: 5, // Absolute max 5x leverage (safe default)
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
    // These values are calibrated for MAX_SAFE_LEVERAGE of 5x:
    // At 5x leverage with 5% stop = 25% account loss on that position (manageable)
    // At 5x leverage with 8% stop = 40% account loss on that position (aggressive)
    // IMPORTANT: If leverage increases, stop losses MUST be tightened proportionally
    // Formula: effective_risk = leverage × stop_percent
    // Target: effective_risk ≤ 40% per position
    STOP_LOSS_REQUIREMENTS: {
        TECHNICAL: 4, // Max -4% from entry or key support breaks (5x × 4% = 20% risk)
        MACRO: 5, // Max -5% from entry or macro thesis invalidates (5x × 5% = 25% risk)
        RISK: 4, // Max -4% from entry (most conservative) (5x × 4% = 20% risk)
        QUANT: 5 // Max -5% from entry or statistical edge disappears (5x × 5% = 25% risk)
    }
};
