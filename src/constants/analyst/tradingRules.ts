/**
 * Comprehensive Trading Rules
 * 
 * ALL rules that AI analysts MUST follow when making trading recommendations.
 * These rules are injected into every debate context so analysts can make compliant recommendations.
 * 
 * WEEX API Documentation Reference: weex/INDEX.md
 * - Trade Endpoints: weex/trade/INDEX.md
 * - Account Endpoints: weex/account/INDEX.md
 * - Error Codes: weex/ERROR_CODES.md
 */

import { config } from '../../config';
import { GLOBAL_RISK_LIMITS } from './riskLimits';
import { RISK_COUNCIL_VETO_TRIGGERS } from './riskCouncil';

// FIXED: Cache trading rules to avoid regenerating 2000+ chars every call
let cachedTradingRules: string | null = null;

/**
 * Format all trading rules as a clear, structured string for AI context
 * OPTIMIZED: Results are cached after first call
 */
export function formatTradingRulesForAI(): string {
    if (cachedTradingRules) {
        return cachedTradingRules;
    }

    cachedTradingRules = `
═══════════════════════════════════════════════════════════════════
                    MANDATORY TRADING RULES
═══════════════════════════════════════════════════════════════════

⚠️ CRITICAL: ALL recommendations MUST comply with these rules.
   Karen (Risk Council) will VETO any trade that violates these limits.

───────────────────────────────────────────────────────────────────
📊 POSITION SIZING RULES
───────────────────────────────────────────────────────────────────
✓ Max Position Size: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_POSITION_PERCENT}% of account per trade
✓ Max Concurrent Positions: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS} positions at once
✓ Max Total Capital Deployed: ${GLOBAL_RISK_LIMITS.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT}% across all positions
✓ Min Balance to Trade: $${config.autonomous.minBalanceToTrade}

───────────────────────────────────────────────────────────────────
⚡ LEVERAGE RULES
───────────────────────────────────────────────────────────────────
✓ Max Leverage: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x (NEVER exceed this)
✓ Default Leverage: ${config.autonomous.defaultLeverage}x
✓ Liquidation Risk: At ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x, a ${(() => {
            // FIXED: Add division by zero guard
            const maxLev = RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE;
            if (!Number.isFinite(maxLev) || maxLev <= 0) {
                return '20.0'; // Fallback value
            }
            const distance = 100 / maxLev;
            return Number.isFinite(distance) ? distance.toFixed(1) : '20.0';
        })()}% move liquidates position

───────────────────────────────────────────────────────────────────
🛡️ STOP LOSS RULES (By Analyst Type)
───────────────────────────────────────────────────────────────────
⚠️ CRITICAL: Karen enforces a GLOBAL maximum of ${RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}% from entry.
   Analyst-specific limits below are GUIDELINES for methodology-specific risk tolerance.
   ALL stop losses must be ≤${RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}% to pass Risk Council review.

✓ VALUE (Warren):     Max ${config.autonomous.stopLossRequirements.VALUE}% from entry
✓ GROWTH (Cathie):    Max ${config.autonomous.stopLossRequirements.GROWTH}% from entry
✓ TECHNICAL (Jim):    Max ${config.autonomous.stopLossRequirements.TECHNICAL}% from entry
✓ MACRO (Ray):        Max ${config.autonomous.stopLossRequirements.MACRO}% from entry
✓ SENTIMENT (Elon):   Max ${config.autonomous.stopLossRequirements.SENTIMENT}% from entry
✓ RISK (Karen):       Max ${config.autonomous.stopLossRequirements.RISK}% from entry
✓ QUANT (Quant):      Max ${config.autonomous.stopLossRequirements.QUANT}% from entry
✓ CONTRARIAN (Devil): Max ${config.autonomous.stopLossRequirements.CONTRARIAN}% from entry

⚠️ CRITICAL: Stop loss MUST be set. No exceptions.
⚠️ At ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x leverage, a ${RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}% stop = ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE * RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}% account loss

───────────────────────────────────────────────────────────────────
🎯 TAKE PROFIT RULES
───────────────────────────────────────────────────────────────────
✓ Default Take Profit: ${config.autonomous.takeProfitPercent}% from entry
✓ Risk/Reward Ratio: Aim for at least 1.5:1 (TP should be 1.5x SL distance)

───────────────────────────────────────────────────────────────────
⚖️ PORTFOLIO BALANCE RULES
───────────────────────────────────────────────────────────────────
✓ Max Same Direction: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS} positions in same direction (LONG or SHORT)
✓ Max Sector Exposure: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_SECTOR_POSITIONS} positions in same sector
✓ Net LONG Exposure: ≤ ${RISK_COUNCIL_VETO_TRIGGERS.NET_EXPOSURE_LIMITS.LONG}% of portfolio
✓ Net SHORT Exposure: ≤ ${RISK_COUNCIL_VETO_TRIGGERS.NET_EXPOSURE_LIMITS.SHORT}% of portfolio

───────────────────────────────────────────────────────────────────
💰 FUNDING RATE RULES
───────────────────────────────────────────────────────────────────
✓ Max Funding Against: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST * 100}% per 8 hours
✓ Warning Threshold: ${config.autonomous.fundingWarnThresholdPercent * 100}% per 8 hours
✓ Check: If funding rate is high and against your position, reduce size or avoid

───────────────────────────────────────────────────────────────────
📉 DRAWDOWN RULES
───────────────────────────────────────────────────────────────────
✓ Max Weekly Drawdown: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}%
✓ If portfolio down >${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}% this week: REDUCE position sizes
✓ Max Risk Per Trade: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_RISK_PER_TRADE_PERCENT}% of account
✓ Max Concurrent Risk: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_RISK_PERCENT}% across all positions

───────────────────────────────────────────────────────────────────
🚪 POSITION MANAGEMENT RULES (MANAGE ACTION)
───────────────────────────────────────────────────────────────────

🚨 IMMEDIATE CLOSE TRIGGERS (NON-NEGOTIABLE):
✗ P&L < -7%: CLOSE IMMEDIATELY (no exceptions, no hoping)
✗ P&L < -5%: STRONGLY consider closing; re-validate thesis
✗ Thesis INVALIDATED: CLOSE regardless of P&L
✗ Hold time > 7 days with no progress: CLOSE (capital efficiency)

💰 PROFIT PROTECTION RULES:
✓ P&L > +10%: Move stop to BREAKEVEN (entry price)
✓ P&L > +15%: Take at least 50% profits OR tighten stop to +10%
✓ P&L > +20%: Take at least 75% profits
✓ NEVER let a +10% winner turn into a loser

⏰ TIME-BASED MANAGEMENT:
✓ Hold > 3 days: Review thesis - is catalyst still valid?
✓ Hold > 5 days: Re-evaluate urgently - stale thesis risk
✓ Hold > 7 days: Close unless NEW catalyst identified

💸 FUNDING RATE MANAGEMENT:
✓ Funding > 0.03% against position: Factor into daily cost
✓ Funding > 0.05% against position: Reduce expected hold time by 50%
✓ Cumulative funding > 1% of position value: Consider closing

❌ FORBIDDEN ACTIONS:
✗ NEVER average down on a losing position
✗ NEVER move stop-loss FURTHER from entry
✗ NEVER hold a position "hoping" it recovers
✗ NEVER ignore a -7% loss - ALWAYS close

───────────────────────────────────────────────────────────────────
🚨 CIRCUIT BREAKERS (Automatic Risk Reduction)
───────────────────────────────────────────────────────────────────

🟡 YELLOW ALERT (Caution):
   Triggers: BTC -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.BTC_DROP_4H}% in 4h OR 
            Portfolio -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.PORTFOLIO_DRAWDOWN_24H}% in 24h OR
            |Funding Rate| >${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.FUNDING_RATE_EXTREME}%
   Action: Reduce all leverage to 3x max, close speculative positions

🟠 ORANGE ALERT (High Risk):
   Triggers: BTC -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.BTC_DROP_4H}% in 4h OR 
            Portfolio -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.PORTFOLIO_DRAWDOWN_24H}% in 24h OR
            |Funding Rate| >${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.FUNDING_RATE_EXTREME}%
   Action: Reduce all leverage to 2x max, close small positions

🔴 RED ALERT (Emergency):
   Triggers: BTC -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.RED_ALERT.BTC_DROP_4H}% in 4h OR 
            Portfolio -${GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.RED_ALERT.PORTFOLIO_DRAWDOWN_24H}% in 24h
   Action: CLOSE ALL POSITIONS IMMEDIATELY

───────────────────────────────────────────────────────────────────
⏱️ TIMING RULES
───────────────────────────────────────────────────────────────────
✓ Min Trade Interval: ${config.autonomous.minTradeIntervalMs / 60000} minutes between trades per analyst
✓ Cycle Interval: ${config.autonomous.cycleIntervalMs / 60000} minutes between debate cycles
✓ Max Daily Trades: ${config.trading.maxDailyTrades} trades per day

───────────────────────────────────────────────────────────────────
📐 WEEX ORDER SPECIFICATIONS (CRITICAL - MUST COMPLY)
───────────────────────────────────────────────────────────────────
⚠️ WEEX has STRICT requirements for order parameters. Violations = INSTANT REJECTION.

📚 WEEX API DOCUMENTATION: weex/INDEX.md
   - Trade Endpoints: weex/trade/INDEX.md (17 endpoints)
   - Account Endpoints: weex/account/INDEX.md (11 endpoints)
   - Error Codes: weex/ERROR_CODES.md

🔹 APPROVED TRADING PAIRS (ONLY THESE):
   • cmt_btcusdt, cmt_ethusdt, cmt_solusdt, cmt_dogeusdt
   • cmt_xrpusdt, cmt_adausdt, cmt_bnbusdt, cmt_ltcusdt
   ❌ Trading other pairs = DISQUALIFICATION

🔹 PRICE PRECISION (varies by coin):
   • BTC (cmt_btcusdt): 1 decimal place, 0.1 step (e.g., 86400.0, 86400.1, 86400.2)
     ❌ INVALID: 86400.42 (too many decimals)
     ✅ VALID: 86400.4
   
   • ETH/SOL/Other coins: Check contract specs (typically 2 decimals, 0.01 step)
   
   • Rule: ALWAYS use contract-specific tick_size and priceEndStep
   • System automatically rounds prices to correct precision

🔹 SIZE PRECISION:
   • Minimum order size: 0.0001 (for most contracts)
   • Size decimals: 4-5 decimal places (varies by contract)
   • Rule: ALWAYS use contract-specific minOrderSize and size_increment
   • System automatically rounds sizes to correct precision

🔹 ORDER TYPES (WEEX API):
   • type: 1=Open LONG, 2=Open SHORT, 3=Close LONG, 4=Close SHORT
   • order_type: 0=Normal, 1=Post-Only, 2=FOK, 3=IOC
   • match_price: 0=Limit, 1=Market
   • marginMode: 1=Cross, 3=Isolated

🔹 POSITION MANAGEMENT ENDPOINTS:
   • Close Position: POST /capi/v2/order/closePositions (weight: 40/50)
   • Place TP/SL: POST /capi/v2/order/placeTpSlOrder (weight: 2/5)
   • Modify TP/SL: POST /capi/v2/order/modifyTpSlOrder (weight: 2/5)
   • Get Positions: GET /capi/v2/account/position/allPosition (weight: 10/15)

🔹 RATE LIMITS:
   • General: 1000 requests per 10 seconds (IP and UID)
   • Place/Cancel Orders: 10 requests per second
   • Close All Positions: Weight 40 (IP) / 50 (UID) - use sparingly

🔹 LEVERAGE LIMITS (per contract):
   • Min: 1x (all contracts)
   • Max: Up to 500x (varies by contract, check specs)
   • BTC typically: 500x max
   • System validates against contract-specific limits

🔹 POSITION SIZE LIMITS (per contract):
   • minOrderSize: Minimum order quantity (e.g., 0.0001 BTC)
   • maxOrderSize: Maximum single order (e.g., 100,000 BTC)
   • maxPositionSize: Maximum total position (e.g., 1,000,000 BTC)
   • System validates against these limits before submission

⚠️ CRITICAL: Contract specifications are fetched from WEEX API on engine start.
   If specs are missing, orders will be REJECTED. System logs warnings if using fallback values.

───────────────────────────────────────────────────────────────────
📋 KAREN'S VETO CHECKLIST (Risk Council Stage 4)
───────────────────────────────────────────────────────────────────
Karen will VETO if ANY of these fail:
${Array.isArray(RISK_COUNCIL_VETO_TRIGGERS.CHECKLIST) && RISK_COUNCIL_VETO_TRIGGERS.CHECKLIST.length > 0
            ? RISK_COUNCIL_VETO_TRIGGERS.CHECKLIST.map((rule, i) => `${i + 1}. ${rule}`).join('\n')
            : '⚠️ ERROR: CHECKLIST array is empty or invalid - check riskCouncil.ts configuration'}

═══════════════════════════════════════════════════════════════════
                    RECOMMENDATION FORMAT
═══════════════════════════════════════════════════════════════════

When making recommendations, ALWAYS specify:
1. Direction: LONG or SHORT
2. Entry Price: Current market price or specific level
3. Position Size: 1-10 scale (will be converted to % of account)
4. Leverage: 1-${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x (NEVER exceed ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x)
5. Stop Loss: Price level (must be ≤${RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}% from entry)
6. Take Profit: Price level (aim for 1.5x+ risk/reward)
7. Timeframe: Expected holding period
8. Confidence: 1-100% (how confident you are)

═══════════════════════════════════════════════════════════════════

⚠️ REMEMBER: These rules exist to protect the portfolio from catastrophic losses.
   Better to miss an opportunity than to blow up the account.
   When in doubt, be MORE conservative, not less.

═══════════════════════════════════════════════════════════════════
`;

    return cachedTradingRules;
}

/**
 * Clear the trading rules cache (for testing or when rules change)
 */
export function clearTradingRulesCache(): void {
    cachedTradingRules = null;
}

/**
 * Get a concise summary of the most critical rules for quick reference
 */
export function getCriticalRulesSummary(): string {
    return `
🚨 CRITICAL RULES (MUST FOLLOW):
• Max Position: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_POSITION_PERCENT}% | Max Leverage: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE}x | Max Stop Loss: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE}%
• Max Concurrent: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS} positions | Max Same Direction: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS}
• Weekly Drawdown Limit: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}% | Risk/Trade: ${RISK_COUNCIL_VETO_TRIGGERS.MAX_RISK_PER_TRADE_PERCENT}%
`;
}

/**
 * Export all rules as a structured object for programmatic access
 */
export const ALL_TRADING_RULES = {
    POSITION_SIZING: {
        MAX_POSITION_PERCENT: RISK_COUNCIL_VETO_TRIGGERS.MAX_POSITION_PERCENT,
        MAX_CONCURRENT_POSITIONS: RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS,
        MAX_TOTAL_CAPITAL_DEPLOYED: GLOBAL_RISK_LIMITS.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT,
        MIN_BALANCE_TO_TRADE: config.autonomous.minBalanceToTrade
    },
    LEVERAGE: {
        MAX_LEVERAGE: RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE,
        DEFAULT_LEVERAGE: config.autonomous.defaultLeverage,
        // FIXED: Add division by zero guard
        LIQUIDATION_DISTANCE_AT_MAX: (() => {
            const maxLev = RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE;
            if (!Number.isFinite(maxLev) || maxLev <= 0) {
                return 20; // Fallback: 20% at 5x leverage
            }
            return 100 / maxLev;
        })()
    },
    STOP_LOSS: {
        MAX_DISTANCE_PERCENT: RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE,
        BY_ANALYST: config.autonomous.stopLossRequirements,
        ENFORCEMENT_MULTIPLIER: config.autonomous.stopLossEnforcementMultiplier
    },
    TAKE_PROFIT: {
        DEFAULT_PERCENT: config.autonomous.takeProfitPercent,
        MIN_RISK_REWARD_RATIO: 1.5
    },
    PORTFOLIO_BALANCE: {
        MAX_SAME_DIRECTION: RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS,
        MAX_SECTOR_POSITIONS: RISK_COUNCIL_VETO_TRIGGERS.MAX_SECTOR_POSITIONS,
        NET_EXPOSURE_LIMITS: RISK_COUNCIL_VETO_TRIGGERS.NET_EXPOSURE_LIMITS
    },
    FUNDING_RATE: {
        MAX_AGAINST_DECIMAL: RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST,
        WARNING_THRESHOLD_DECIMAL: config.autonomous.fundingWarnThresholdPercent
    },
    DRAWDOWN: {
        MAX_WEEKLY_PERCENT: RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN,
        MAX_RISK_PER_TRADE: RISK_COUNCIL_VETO_TRIGGERS.MAX_RISK_PER_TRADE_PERCENT,
        MAX_CONCURRENT_RISK: RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_RISK_PERCENT
    },
    CIRCUIT_BREAKERS: GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS,
    TIMING: {
        MIN_TRADE_INTERVAL_MS: config.autonomous.minTradeIntervalMs,
        CYCLE_INTERVAL_MS: config.autonomous.cycleIntervalMs,
        MAX_DAILY_TRADES: config.trading.maxDailyTrades
    },
    WEEX_SPECIFICATIONS: {
        PRICE_PRECISION: {
            BTC_DECIMALS: 1,
            BTC_TICK_SIZE: 0.1,
            DEFAULT_DECIMALS: 2,
            DEFAULT_TICK_SIZE: 0.01,
            NOTE: 'Contract-specific values fetched from WEEX API on engine start'
        },
        SIZE_PRECISION: {
            MIN_ORDER_SIZE: 0.0001,
            SIZE_DECIMALS: 4,
            NOTE: 'Contract-specific values fetched from WEEX API on engine start'
        },
        ORDER_PARAMETERS: {
            MAX_CLIENT_OID_LENGTH: 40,
            ORDER_TYPES: {
                OPEN_LONG: '1',
                OPEN_SHORT: '2',
                CLOSE_LONG: '3',
                CLOSE_SHORT: '4'
            },
            ORDER_EXECUTION_TYPES: {
                NORMAL: '0',
                POST_ONLY: '1',
                FOK: '2',
                IOC: '3'
            },
            MATCH_PRICE: {
                LIMIT: '0',
                MARKET: '1'
            },
            // FIXED: Consistent type usage - MARGIN_MODE uses string values like other parameters
            MARGIN_MODE: {
                CROSS: '1',
                ISOLATED: '3'
            }
        },
        LEVERAGE_LIMITS: {
            MIN: 1,
            MAX: 500,
            NOTE: 'Max leverage varies by contract, validated against WEEX specs'
        },
        POSITION_LIMITS: {
            NOTE: 'minOrderSize, maxOrderSize, maxPositionSize are contract-specific'
        }
    }
};
