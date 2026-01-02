/**
 * Position Management Prompts
 * 
 * Specialized prompts for the MANAGE action in Stage 2.
 * When analysts select MANAGE instead of LONG/SHORT, they're recommending
 * to close, reduce, or adjust an existing position.
 * 
 * WEEX API Reference:
 * - Close Position: POST /capi/v2/order/closePositions
 * - Modify TP/SL: POST /capi/v2/order/modifyTpSlOrder
 * - Adjust Margin: POST /capi/v2/account/adjustPositionMargin
 */

import { safeNumber, safePercent } from './promptHelpers';
import type { PortfolioPosition } from './builders';

/**
 * Management action types supported by the system
 */
export type ManageActionType =
    | 'CLOSE_FULL'      // Close entire position at market
    | 'CLOSE_PARTIAL'   // Reduce position size
    | 'TIGHTEN_STOP'    // Move stop-loss closer to entry
    | 'TAKE_PARTIAL'    // Take partial profits
    | 'ADJUST_TP'       // Adjust take-profit level
    | 'ADD_MARGIN';     // Add margin to isolated position

/**
 * Schema for MANAGE action response from AI
 * FIXED: Replaced 'any' types with proper TypeScript interfaces
 */
export interface ManageActionSchema {
    symbol: string;
    action: 'MANAGE';
    manageType: ManageActionType;
    conviction: number;  // 1-10
    reason: string;

    // Optional parameters based on manageType (strongly typed)
    closePercent?: number;      // For CLOSE_PARTIAL/TAKE_PARTIAL (1-100)
    newStopLoss?: number;       // For TIGHTEN_STOP (price value)
    newTakeProfit?: number;     // For ADJUST_TP (price value)
    marginAmount?: number;      // For ADD_MARGIN (USDT amount)
}

/**
 * Position health assessment criteria
 */
export interface PositionHealthMetrics {
    pnlStatus: 'PROFIT' | 'LOSS' | 'BREAKEVEN';
    pnlSeverity: 'CRITICAL' | 'WARNING' | 'HEALTHY';
    holdTimeStatus: 'FRESH' | 'MATURE' | 'STALE';
    fundingImpact: 'FAVORABLE' | 'NEUTRAL' | 'ADVERSE';
    thesisStatus: 'VALID' | 'WEAKENING' | 'INVALIDATED';
}

/**
 * Assess position health based on metrics
 * 
 * EDGE CASES HANDLED:
 * - Division by zero in funding calculation
 * - NaN/Infinity values in position data
 * - Missing optional fields
 */
export function assessPositionHealth(position: PortfolioPosition): PositionHealthMetrics {
    // Validate input - use safe defaults for invalid values
    const pnlPercent = Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : 0;
    const holdTimeHours = Number.isFinite(position.holdTimeHours) && position.holdTimeHours >= 0 ? position.holdTimeHours : 0;
    const entryPrice = Number.isFinite(position.entryPrice) && position.entryPrice > 0 ? position.entryPrice : 1;
    const size = Number.isFinite(position.size) && position.size > 0 ? position.size : 1;

    // P&L Status - AGGRESSIVE profit-taking thresholds
    let pnlStatus: 'PROFIT' | 'LOSS' | 'BREAKEVEN';
    let pnlSeverity: 'CRITICAL' | 'WARNING' | 'HEALTHY';

    if (pnlPercent > 1) {
        pnlStatus = 'PROFIT';
        pnlSeverity = pnlPercent > 5 ? 'WARNING' : 'HEALTHY'; // Warning = take profits at +5%
    } else if (pnlPercent < -1) {
        pnlStatus = 'LOSS';
        pnlSeverity = pnlPercent < -7 ? 'CRITICAL' :
            pnlPercent < -4 ? 'WARNING' : 'HEALTHY';
    } else {
        pnlStatus = 'BREAKEVEN';
        pnlSeverity = 'HEALTHY';
    }

    // Hold Time Status - AGGRESSIVE time limits
    const holdDays = holdTimeHours / 24;
    let holdTimeStatus: 'FRESH' | 'MATURE' | 'STALE';
    if (holdDays < 1) {
        holdTimeStatus = 'FRESH';
    } else if (holdDays < 2) {
        holdTimeStatus = 'MATURE';
    } else {
        holdTimeStatus = 'STALE'; // After 2 days, position is stale
    }

    // Funding Impact (if available)
    let fundingImpact: 'FAVORABLE' | 'NEUTRAL' | 'ADVERSE' = 'NEUTRAL';
    if (position.fundingPaid !== undefined && Number.isFinite(position.fundingPaid)) {
        // Safe division - we validated entryPrice and size above
        const positionValue = entryPrice * size;
        if (positionValue > 0) {
            const fundingPercent = (position.fundingPaid / positionValue) * 100;
            if (Number.isFinite(fundingPercent)) {
                if (fundingPercent < -0.5) {
                    fundingImpact = 'FAVORABLE'; // We received funding
                } else if (fundingPercent > 1) {
                    fundingImpact = 'ADVERSE'; // Significant funding paid
                }
            }
        }
    }

    // Thesis Status - use unrealizedPnlPercent directly since it already accounts for direction
    // For LONG: negative pnl = price went down = thesis weakening
    // For SHORT: negative pnl = price went up = thesis weakening
    // unrealizedPnlPercent is already direction-aware, so we just check the magnitude
    let thesisStatus: 'VALID' | 'WEAKENING' | 'INVALIDATED';

    if (pnlPercent < -8) {
        thesisStatus = 'INVALIDATED';
    } else if (pnlPercent < -4) {
        thesisStatus = 'WEAKENING';
    } else {
        thesisStatus = 'VALID';
    }

    return { pnlStatus, pnlSeverity, holdTimeStatus, fundingImpact, thesisStatus };
}

/**
 * Build detailed position analysis for MANAGE decision
 * 
 * EDGE CASES HANDLED:
 * - Invalid/missing position data
 * - NaN values in calculations
 * - Empty symbol strings
 */
export function buildPositionAnalysis(position: PortfolioPosition): string {
    // Validate position object
    if (!position || typeof position !== 'object') {
        return 'Invalid position data';
    }

    const health = assessPositionHealth(position);

    // Safe value extraction with defaults
    const holdTimeHours = Number.isFinite(position.holdTimeHours) ? position.holdTimeHours : 0;
    const holdDays = (holdTimeHours / 24).toFixed(1);
    const pnlPercent = Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : 0;
    const pnlSign = pnlPercent >= 0 ? '+' : '';

    // Safe symbol extraction
    const symbol = typeof position.symbol === 'string' && position.symbol.length > 0
        ? position.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase()
        : 'UNKNOWN';
    const side = position.side === 'LONG' || position.side === 'SHORT' ? position.side : 'UNKNOWN';

    // Status indicators
    const pnlIcon = health.pnlStatus === 'PROFIT' ? '🟢' :
        health.pnlStatus === 'LOSS' ? '🔴' : '⚪';
    const severityIcon = health.pnlSeverity === 'CRITICAL' ? '🚨' :
        health.pnlSeverity === 'WARNING' ? '⚠️' : '✅';
    const holdIcon = health.holdTimeStatus === 'STALE' ? '⏰' :
        health.holdTimeStatus === 'MATURE' ? '📅' : '🆕';
    const thesisIcon = health.thesisStatus === 'INVALIDATED' ? '❌' :
        health.thesisStatus === 'WEAKENING' ? '⚡' : '✓';

    let analysis = `
┌─────────────────────────────────────────────────────────────────┐
│ POSITION: ${symbol} ${side}
├─────────────────────────────────────────────────────────────────┤
│ Entry: ${safeNumber(position.entryPrice, 4)} → Current: ${safeNumber(position.currentPrice, 4)}
│ Size: ${safeNumber(position.size, 4)} | P&L: ${pnlSign}${safeNumber(pnlPercent, 2)}% (${safeNumber(position.unrealizedPnl, 2)} USDT)
│ Hold Time: ${holdDays} days
├─────────────────────────────────────────────────────────────────┤
│ HEALTH ASSESSMENT:
│   ${pnlIcon} P&L Status: ${health.pnlStatus} ${severityIcon}
│   ${holdIcon} Hold Time: ${health.holdTimeStatus}
│   ${thesisIcon} Thesis: ${health.thesisStatus}`;

    if (position.fundingPaid !== undefined && Number.isFinite(position.fundingPaid)) {
        const fundingIcon = health.fundingImpact === 'ADVERSE' ? '💸' :
            health.fundingImpact === 'FAVORABLE' ? '💰' : '➖';
        analysis += `\n│   ${fundingIcon} Funding Impact: ${health.fundingImpact} (${safeNumber(position.fundingPaid, 2)} USDT)`;
    }

    analysis += '\n└─────────────────────────────────────────────────────────────────┘';

    return analysis;
}

/**
 * Build MANAGE action decision prompt
 * Used when an analyst selects MANAGE for a position
 * 
 * EDGE CASES HANDLED:
 * - Invalid position data
 * - Missing market context fields
 * - NaN values
 */
export function buildManageDecisionPrompt(
    position: PortfolioPosition,
    marketContext: {
        btcChange24h: number;
        fundingRate?: number;
        volatility24h?: number;
    }
): string {
    // Validate inputs
    if (!position || typeof position !== 'object') {
        return 'Invalid position data for MANAGE decision';
    }
    if (!marketContext || typeof marketContext !== 'object') {
        marketContext = { btcChange24h: 0 };
    }

    const health = assessPositionHealth(position);
    const positionAnalysis = buildPositionAnalysis(position);

    // Safe symbol extraction
    const displaySymbol = typeof position.symbol === 'string' && position.symbol.length > 0
        ? position.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase()
        : 'UNKNOWN';
    const side = position.side === 'LONG' || position.side === 'SHORT' ? position.side : 'UNKNOWN';

    // Build urgency assessment
    let urgencyLevel = 'NORMAL';
    let urgencyReason = '';

    if (health.pnlSeverity === 'CRITICAL' && health.pnlStatus === 'LOSS') {
        urgencyLevel = 'HIGH';
        urgencyReason = 'Position approaching stop-loss territory';
    } else if (health.thesisStatus === 'INVALIDATED') {
        urgencyLevel = 'HIGH';
        urgencyReason = 'Original thesis no longer valid';
    } else if (health.pnlSeverity === 'WARNING' && health.pnlStatus === 'PROFIT') {
        urgencyLevel = 'MEDIUM';
        urgencyReason = 'Significant unrealized profits at risk';
    } else if (health.holdTimeStatus === 'STALE') {
        urgencyLevel = 'MEDIUM';
        urgencyReason = 'Position held beyond typical timeframe';
    }

    // Safe market context values
    const btcChange = Number.isFinite(marketContext.btcChange24h) ? marketContext.btcChange24h : 0;
    const fundingRateStr = marketContext.fundingRate !== undefined && Number.isFinite(marketContext.fundingRate)
        ? `- Funding Rate: ${safeNumber(marketContext.fundingRate * 100, 4)}%`
        : '';
    const volatilityStr = marketContext.volatility24h !== undefined && Number.isFinite(marketContext.volatility24h)
        ? `- 24h Volatility: ${safeNumber(marketContext.volatility24h, 2)}%`
        : '';

    return `═══════════════════════════════════════════════════════════════════════════════
POSITION MANAGEMENT DECISION - ${displaySymbol} ${side}
═══════════════════════════════════════════════════════════════════════════════

${positionAnalysis}

MARKET CONTEXT:
- BTC 24h: ${safePercent(btcChange, 2, true)}
${fundingRateStr}
${volatilityStr}

URGENCY: ${urgencyLevel}${urgencyReason ? ` - ${urgencyReason}` : ''}

═══════════════════════════════════════════════════════════════════════════════
MANAGEMENT OPTIONS
═══════════════════════════════════════════════════════════════════════════════

1. CLOSE_FULL - Close entire position at market
   Use when: Thesis invalidated, stop-loss hit, or taking full profits

2. CLOSE_PARTIAL - Reduce position size (specify %)
   Use when: De-risking, taking partial profits, or reducing exposure

3. TIGHTEN_STOP - Move stop-loss closer to entry/current price
   Use when: Protecting profits, reducing risk after favorable move

4. TAKE_PARTIAL - Close portion at profit (specify %)
   Use when: Locking in gains while maintaining exposure

5. ADJUST_TP - Modify take-profit level
   Use when: Market conditions suggest different target

6. ADD_MARGIN - Add margin to isolated position (specify amount)
   Use when: Position near liquidation, need to increase margin buffer
   RESTRICTIONS: Only for isolated positions with P&L >= -3%, no prior averaging down,
   and no active rule-forced closure conditions (P&L must be > -7%)

═══════════════════════════════════════════════════════════════════════════════
DECISION RULES (MUST FOLLOW)
═══════════════════════════════════════════════════════════════════════════════

🚨 IMMEDIATE CLOSE TRIGGERS:
- P&L < -7% → CLOSE_FULL (cut losses before stop)
- Thesis INVALIDATED → CLOSE_FULL (don't hope for recovery)
- Hold time > 7 days with no progress → CLOSE_FULL (capital efficiency)

⚠️ PROFIT PROTECTION TRIGGERS (AGGRESSIVE - TAKE PROFITS EARLY):
- P&L > +5% → Consider TAKE_PARTIAL (25-50%) to lock in gains
- P&L > +8% → TAKE_PARTIAL (50%) or TIGHTEN_STOP to +4%
- P&L > +10% → Strongly consider CLOSE_FULL or TAKE_PARTIAL (75%)
- P&L > +15% → CLOSE_FULL - don't be greedy, secure the win

📊 FUNDING CONSIDERATIONS:
- If funding ADVERSE and > 0.03%/8h → Factor into hold decision
- Daily funding cost > 0.1% → Reduce hold time expectations

🚫 ADD_MARGIN RESTRICTIONS:
- ONLY allowed if P&L >= -3% (not deeply underwater)
- P&L < -7%: MUST close position immediately (system enforced)
- NEVER allowed if position was previously averaged down
- ONLY for isolated positions with short-term liquidity issues
- Must have valid thesis and no invalidation signals

RESPOND WITH JSON:
{
    "symbol": "${position.symbol || 'unknown'}",
    "action": "MANAGE",
    "manageType": "CLOSE_FULL" | "CLOSE_PARTIAL" | "TIGHTEN_STOP" | "TAKE_PARTIAL" | "ADJUST_TP" | "ADD_MARGIN",
    "conviction": 1-10,
    "reason": "One sentence with specific numbers",
    "closePercent": number (if CLOSE_PARTIAL or TAKE_PARTIAL),
    "newStopLoss": number (if TIGHTEN_STOP),
    "newTakeProfit": number (if ADJUST_TP),
    "marginAmount": number (if ADD_MARGIN)
}`;
}

/**
 * Build portfolio-wide management summary
 * Shows all positions that may need attention
 * 
 * EDGE CASES HANDLED:
 * - Empty positions array
 * - Invalid position objects in array
 * - NaN values in calculations
 */
export function buildPortfolioManagementSummary(positions: PortfolioPosition[]): string {
    // Validate input
    if (!Array.isArray(positions)) {
        return 'Invalid positions data.';
    }

    if (positions.length === 0) {
        return 'No open positions to manage.';
    }

    // Filter out invalid positions
    const validPositions = positions.filter(pos =>
        pos &&
        typeof pos === 'object' &&
        typeof pos.symbol === 'string' &&
        (pos.side === 'LONG' || pos.side === 'SHORT')
    );

    if (validPositions.length === 0) {
        return 'No valid positions to manage.';
    }

    const needsAttention: Array<{ position: PortfolioPosition; health: PositionHealthMetrics; priority: number }> = [];

    for (const pos of validPositions) {
        const health = assessPositionHealth(pos);
        let priority = 0;

        // Calculate priority score
        if (health.pnlSeverity === 'CRITICAL') priority += 100;
        if (health.pnlSeverity === 'WARNING') priority += 50;
        if (health.thesisStatus === 'INVALIDATED') priority += 80;
        if (health.thesisStatus === 'WEAKENING') priority += 30;
        if (health.holdTimeStatus === 'STALE') priority += 40;
        if (health.fundingImpact === 'ADVERSE') priority += 20;

        // Profit-taking opportunities also need attention - AGGRESSIVE thresholds
        const pnlPercent = Number.isFinite(pos.unrealizedPnlPercent) ? pos.unrealizedPnlPercent : 0;
        if (health.pnlStatus === 'PROFIT' && pnlPercent > 5) {
            priority += 70; // High priority to take profits at +5%
        }

        needsAttention.push({ position: pos, health, priority });
    }

    // Sort by priority (highest first)
    needsAttention.sort((a, b) => b.priority - a.priority);

    let summary = `
═══════════════════════════════════════════════════════════════════════════════
PORTFOLIO MANAGEMENT SUMMARY (${validPositions.length} position${validPositions.length > 1 ? 's' : ''})
═══════════════════════════════════════════════════════════════════════════════
`;

    for (const { position, health, priority } of needsAttention) {
        const symbol = typeof position.symbol === 'string'
            ? position.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase()
            : 'UNKNOWN';
        const pnlPercent = Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : 0;
        const pnlSign = pnlPercent >= 0 ? '+' : '';
        const holdTimeHours = Number.isFinite(position.holdTimeHours) ? position.holdTimeHours : 0;
        const holdDays = (holdTimeHours / 24).toFixed(1);

        const priorityLabel = priority >= 80 ? '🚨 HIGH' :
            priority >= 40 ? '⚠️ MEDIUM' : '✅ LOW';

        let actionHint = '';
        if (health.pnlSeverity === 'CRITICAL' && health.pnlStatus === 'LOSS') {
            actionHint = '→ Consider CLOSE_FULL';
        } else if (health.thesisStatus === 'INVALIDATED') {
            actionHint = '→ Consider CLOSE_FULL';
        } else if (health.pnlStatus === 'PROFIT' && pnlPercent > 5) {
            actionHint = '→ TAKE_PARTIAL or CLOSE_FULL - secure profits!';
        } else if (health.holdTimeStatus === 'STALE') {
            actionHint = '→ CLOSE_FULL - position too old, free up capital';
        }

        summary += `
${priorityLabel} PRIORITY | ${symbol} ${position.side}
  P&L: ${pnlSign}${safeNumber(pnlPercent, 2)}% | Hold: ${holdDays}d | Thesis: ${health.thesisStatus}
  ${actionHint}
`;
    }

    return summary;
}

/**
 * Trading rules specific to position management
 * Cross-referenced with WEEX API documentation
 */
export const MANAGE_TRADING_RULES = `
═══════════════════════════════════════════════════════════════════════════════
POSITION MANAGEMENT RULES (MANDATORY - ENFORCED BY SYSTEM)
═══════════════════════════════════════════════════════════════════════════════

🚨 LOSS MANAGEMENT (NON-NEGOTIABLE - SYSTEM ENFORCED):
1. P&L < -7%: MUST close position immediately (no exceptions)
2. P&L < -5%: Strongly consider closing; thesis must be re-validated
3. Never average down on a losing position
4. Never move stop-loss further from entry to "give it room"
5. ADD_MARGIN forbidden if P&L < -3% (system will reject)
6. P&L < -7%: MUST close position immediately (system enforced)

💰 PROFIT MANAGEMENT (AGGRESSIVE - SECURE GAINS EARLY):
1. P&L > +3%: Move stop to breakeven (entry price) - protect the trade
2. P&L > +5%: Take at least 25% profits AND tighten stop to +2%
3. P&L > +8%: Take at least 50% profits AND tighten stop to +4%
4. P&L > +10%: Take at least 75% profits - don't let winners reverse
5. Never let a +5% winner turn into a loser - PROTECT GAINS

⏰ TIME-BASED RULES (AGGRESSIVE - CAPITAL EFFICIENCY):
1. Hold > 2 days: Re-evaluate thesis - is the move happening?
2. Hold > 3 days: Close unless strong momentum with clear catalyst
3. Hold > 5 days: CLOSE_FULL - stale positions waste capital
4. Crypto moves fast - if it's not working in 48h, it's probably not working

💸 FUNDING RATE RULES:
1. Funding > 0.03% against position: Factor into daily cost
2. Funding > 0.05% against position: Reduce hold time by 50%
3. Cumulative funding > 1% of position: Consider closing

🛡️ ADD_MARGIN RESTRICTIONS (CRITICAL - SYSTEM ENFORCED):
1. ONLY allowed if P&L >= -3% (not deeply underwater)
2. NEVER allowed if P&L < -7% (must close position instead)
3. NEVER allowed if position was previously averaged down
4. ONLY for ISOLATED margin positions (not cross margin)
5. Must have valid thesis with no invalidation signals
6. Max margin add = 50% of position value (system enforced)
7. Requires isolatedPositionId from WEEX position data

📊 WEEX API EXECUTION REFERENCE:
┌─────────────────────────────────────────────────────────────────┐
│ CLOSE_FULL:                                                     │
│   Endpoint: POST /capi/v2/order/closePositions                  │
│   Weight: IP=40, UID=50                                         │
│   Params: { symbol: "cmt_btcusdt" }                             │
│   Response: [{ positionId, success, successOrderId, errorMsg }] │
├─────────────────────────────────────────────────────────────────┤
│ CLOSE_PARTIAL / TAKE_PARTIAL:                                   │
│   Endpoint: POST /capi/v2/order/placeOrder                      │
│   Weight: IP=2, UID=5                                           │
│   Params: { symbol, type: "3"(close long)/"4"(close short),     │
│            size, match_price: "1" (market) }                    │
├─────────────────────────────────────────────────────────────────┤
│ TIGHTEN_STOP / ADJUST_TP:                                       │
│   Endpoint: POST /capi/v2/order/modifyTpSlOrder                 │
│   Weight: IP=2, UID=5                                           │
│   Params: { orderId, triggerPrice, executePrice: "0" (market) } │
│   Note: If no existing order, use placeTpSlOrder instead        │
├─────────────────────────────────────────────────────────────────┤
│ ADD_MARGIN:                                                     │
│   Endpoint: POST /capi/v2/account/adjustMargin                  │
│   Weight: IP=15, UID=30                                         │
│   Params: { isolatedPositionId, collateralAmount: "+X" (add) }  │
│   Note: ONLY for isolated positions, requires position ID       │
└─────────────────────────────────────────────────────────────────┘

⚠️ IMMEDIATE ACTION TRIGGERS (CIRCUIT BREAKER):

CIRCUIT BREAKER DEFINITIONS (from GLOBAL_RISK_LIMITS):
┌─────────────────────────────────────────────────────────────────┐
│ YELLOW (CAUTION):                                               │
│   Triggers: BTC drops >10% in 4h OR portfolio down >10% in 24h  │
│             OR |funding rate| >0.25%                            │
│   Meaning: Elevated risk, reduce exposure                       │
│   Action: Reduce all leverage to 3x max, close speculative      │
│           positions, no new high-risk trades                    │
├─────────────────────────────────────────────────────────────────┤
│ ORANGE (HIGH RISK):                                             │
│   Triggers: BTC drops >15% in 4h OR portfolio down >15% in 24h  │
│             OR |funding rate| >0.4%                             │
│   Meaning: Major market stress, defensive posture required      │
│   Action: Reduce all leverage to 2x max, close all positions    │
│           with size <5, close losing positions                  │
├─────────────────────────────────────────────────────────────────┤
│ RED (EMERGENCY):                                                │
│   Triggers: BTC drops >20% in 4h OR portfolio down >25% in 24h  │
│   Meaning: Liquidation cascade risk, capital preservation mode  │
│   Action: CLOSE ALL positions immediately (system override)     │
│           Convert to stablecoins, no new trades until clear     │
└─────────────────────────────────────────────────────────────────┘

- BTC flash crash > 5%: Close all altcoin positions
`;

// FIXED Issue 13: Moved imports to top of file (standard convention)
import { getSystemPrompt } from './promptHelpers';
import { THESIS_SYSTEM_PROMPTS } from './index';
import type { AnalystAgent } from '../analyst/types';

/**
 * Build complete management prompt for Karen (Risk Manager)
 * Used when MANAGE action is selected in Stage 2
 * 
 * FIXED Issue 14: Replaced 'any' types with proper interfaces
 * 
 * @param profile - Karen's analyst profile
 * @param position - Position to manage
 * @param marketData - Current market data for the position's symbol
 * @returns Complete prompt for management decision
 */
export function buildManagePrompt(
    profile: AnalystAgent,
    position: {
        symbol: string;
        side: 'LONG' | 'SHORT';
        size: number;
        entryPrice: number;
        currentPrice: number;
        unrealizedPnl: number;
        unrealizedPnlPercent: number;
        holdTimeHours: number;
        fundingPaid?: number;
    },
    marketData: {
        change24h?: number;
        fundingRate?: number;
        high24h?: number;
        low24h?: number;
        currentPrice?: number;
    }
): string {
    // Convert to PortfolioPosition format
    const portfolioPosition: PortfolioPosition = {
        symbol: position.symbol,
        side: position.side,
        size: position.size,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        unrealizedPnl: position.unrealizedPnl,
        unrealizedPnlPercent: position.unrealizedPnlPercent,
        holdTimeHours: position.holdTimeHours,
        fundingPaid: position.fundingPaid
    };

    // Build market context
    const marketContext = {
        btcChange24h: marketData.change24h || 0,
        fundingRate: marketData.fundingRate,
        volatility24h: marketData.high24h && marketData.low24h && marketData.currentPrice
            ? ((marketData.high24h - marketData.low24h) / marketData.currentPrice) * 100
            : undefined
    };

    // Get the system prompt for Karen (Risk Manager)
    // For position management, use MANAGE action to get only management-relevant sections
    const fullSystemPrompt = getSystemPrompt(profile.methodology, THESIS_SYSTEM_PROMPTS, 'MANAGE');

    // Build the complete prompt
    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• You are THE RISK MANAGER with decision power over position management
• Output MUST match the specified JSON structure

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - POSITION MANAGEMENT (MANAGE Action)
═══════════════════════════════════════════════════════════════════════════════

You are ${profile.name} - THE RISK MANAGER deciding how to manage an existing position.

This is the Position Management flow (triggered by MANAGE action in Stage 2):
- Stage 2 (Coin Selection): Analysts selected MANAGE for this position
- Position Management (YOU ARE HERE): Decide the specific management action

Your job is to PROTECT THE PORTFOLIO using your full risk management methodology.

${buildManageDecisionPrompt(portfolioPosition, marketContext)}

RISK METHODOLOGY REFERENCE (read after stage instructions):
${fullSystemPrompt}

Respond ONLY with valid JSON matching the structure above. No markdown or extra prose.`;
}
