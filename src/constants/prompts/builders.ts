/**
 * Prompt Builder Functions
 * 
 * Functions that build dynamic prompts for various stages of the trading pipeline.
 * These are extracted from service files and centralized here.
 * 
 * All functions include:
 * - Null/undefined guards
 * - Number validation before .toFixed()
 * - String sanitization
 * - Input validation
 */

import type { AnalystAgent } from '../analyst/types';
import type { ExtendedMarketData } from '../../services/ai/GeminiService';
import type { PromptAnalysisResult, PromptMarketData, PromptSpecialist } from './promptTypes';
import { THESIS_SYSTEM_PROMPTS } from './index';
import {
    safeNumber,
    safePrice,
    safePercent,
    sanitizeString,
    safeArrayJoin,
    validateRequired,
    formatPriceTargets,
    getCanonicalPrice,
    getSystemPrompt,
    cleanSymbol,
    getTradingConfig
} from './promptHelpers';
import { formatTradingRulesForAI } from '../analyst/tradingRules';

/**
 * Validate trading config object has all required properties
 * Guards against invalid config from getTradingConfig()
 * 
 * @param cfg - Trading config object to validate
 * @throws Error if config is invalid or missing required properties
 */
function validateTradingConfig(cfg: ReturnType<typeof getTradingConfig>): void {
    if (!cfg || typeof cfg !== 'object') {
        throw new Error('getTradingConfig() returned invalid config object');
    }

    // Validate numeric properties used in toFixed() calls
    const requiredNumericProps = [
        'targetProfitPercent', 'styleStopLossPercent', 'maxHoldHours',
        'minRiskRewardRatio', 'maxStopLossPercent', 'maxLeverage',
        'maxPositionSizePercent', 'maxConcurrentPositions', 'maxSameDirectionPositions',
        'maxWeeklyDrawdown', 'maxFundingAgainstPercent', 'netExposureLong',
        'netExposureShort', 'maxRiskPerTrade', 'maxConcurrentRisk', 'maxHoldDays'
    ] as const;

    for (const prop of requiredNumericProps) {
        const value = cfg[prop as keyof typeof cfg];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(
                `Invalid trading config: ${prop} is ${value}. ` +
                `Expected a finite number. Check your .env configuration.`
            );
        }
    }

    // Validate takeProfitThresholds object
    if (!cfg.takeProfitThresholds || typeof cfg.takeProfitThresholds !== 'object') {
        throw new Error('getTradingConfig() returned invalid takeProfitThresholds');
    }

    const thresholdProps = ['breakeven', 'partial25', 'partial50', 'partial75'] as const;
    for (const prop of thresholdProps) {
        if (!Number.isFinite(cfg.takeProfitThresholds[prop])) {
            throw new Error(
                `Invalid trading config: takeProfitThresholds.${prop} is ${cfg.takeProfitThresholds[prop]}. ` +
                `Expected a finite number.`
            );
        }
    }
}

/**
 * Get validated trading config
 * Wrapper around getTradingConfig() that ensures all values are valid
 * 
 * @returns Validated trading config object
 * @throws Error if config is invalid
 */
function getValidatedTradingConfig(): ReturnType<typeof getTradingConfig> {
    const cfg = getTradingConfig();
    validateTradingConfig(cfg);
    return cfg;
}

/**
 * Position info for portfolio-aware coin selection
 */
export interface PortfolioPosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    holdTimeHours: number;
    fundingPaid?: number;
}

/**
 * Build the coin selection prompt for Stage 2
 * Now includes portfolio positions so analysts can choose between:
 * 1. Opening a new position on a coin
 * 2. Managing an existing position (close, reduce, adjust)
 * 
 * Used by: CollaborativeFlow.ts → runCoinSelection()
 */
export function buildCoinSelectionPrompt(
    profile: AnalystAgent,
    marketSummary: string,
    currentPositions: PortfolioPosition[] = []
): string {
    // Validate required fields
    validateRequired(profile.name, 'profile.name');
    validateRequired(profile.title, 'profile.title');
    validateRequired(marketSummary, 'marketSummary');

    const name = sanitizeString(profile.name, 100);

    // Get validated config values for dynamic limits
    const cfg = getValidatedTradingConfig();

    // For coin selection, we don't include the full system prompt because:
    // 1. The analyst doesn't know the action yet (LONG/SHORT/MANAGE)
    // 2. Including 800+ lines per analyst per turn is massive token waste
    // 3. The analyst's core identity and focus areas are sufficient for selection
    const coreIdentity = `You are ${name}, ${profile.title}.
Focus areas: ${profile.focusAreas.join(', ')}`;

    // Build portfolio section if positions exist
    let portfolioSection = '';
    if (currentPositions.length > 0) {
        const positionsList = currentPositions.map(p => {
            const pnlSign = p.unrealizedPnlPercent >= 0 ? '+' : '';
            // FIXED: Validate holdTimeHours before toFixed() to prevent NaN
            const holdTimeHours = Number.isFinite(p.holdTimeHours) && p.holdTimeHours >= 0 ? p.holdTimeHours : 0;
            const holdDays = (holdTimeHours / 24).toFixed(1);
            // Use cleanSymbol helper for consistent case-insensitive symbol cleaning
            const displaySymbol = cleanSymbol(p.symbol);
            return `  • ${displaySymbol} ${p.side}: Entry ${safeNumber(p.entryPrice, 2)} → Current ${safeNumber(p.currentPrice, 2)} | P&L: ${pnlSign}${safeNumber(p.unrealizedPnlPercent, 2)}% (${safeNumber(p.unrealizedPnl, 2)}) | Hold: ${holdDays} days${p.fundingPaid ? ` | Funding paid: ${safeNumber(p.fundingPaid, 2)}` : ''}`;
        }).join('\n');

        portfolioSection = `
═══════════════════════════════════════════════════════════════════════════════
CURRENT PORTFOLIO (${currentPositions.length} open position${currentPositions.length > 1 ? 's' : ''})
═══════════════════════════════════════════════════════════════════════════════
${positionsList}

⚠️ PORTFOLIO MANAGEMENT OPTION:
If an existing position needs urgent attention (take profit, cut loss, adjust), you can select it instead of a new coin. Use action "MANAGE" with the position symbol.

Consider managing a position if:
- P&L > +5% (lock in profits early)
- P&L < -5% (cut losses before stop)
- Hold time > 2 days (thesis may be stale)
- Funding costs eating into profits
- Market conditions changed against the position
`;
    }

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• Treat methodology as an ANALYTICAL LENS, not a directive
• Obey TASK and CONSTRAINTS exactly; output must match requirements

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - STAGE 2: OPPORTUNITY SELECTION
═══════════════════════════════════════════════════════════════════════════════

You are one of 4 analysts (Ray, Jim, Quant, Elon) selecting the BEST action for the portfolio.

This is Stage 2 of the Hypothesis Arena collaborative pipeline:
- Stage 1 (Market Conditions): Assessed trading environment
- Stage 2 (YOU ARE HERE): Select best opportunity - NEW TRADE or MANAGE EXISTING
- Stage 3 (Championship): All 8 analysts compete in debates for execution
- Stage 4 (Risk Council): Karen reviews the winner
${portfolioSection}
${marketSummary}

TASK: Select your TOP 3 opportunities. Each can be:
1. NEW TRADE: Open a position on one of the 8 coins (action: "LONG" or "SHORT")
2. MANAGE POSITION: Close/reduce/adjust an existing position (action: "MANAGE")

SCORING SYSTEM (your picks compete against other analysts):
• #1 pick = 3 points × conviction
• #2 pick = 2 points × conviction  
• #3 pick = 1 point × conviction

The opportunity with the highest TOTAL score will be selected for deep analysis.

SELECTION CRITERIA (apply YOUR FULL METHODOLOGY):
1. Use YOUR analytical frameworks, scorecards, and checklists
2. Compare NEW opportunities vs MANAGING existing positions
3. Prioritize capital preservation - managing a losing position may be more urgent than a new trade
4. Consider portfolio correlation - don't add more of the same direction

TRADING STYLE - ${cfg.isScalping ? 'HIGH FREQUENCY SCALPING' : 'SWING TRADING'}:
┌─────────────────────────────────────────────────────────────────────────────┐
│ ${cfg.isScalping ? 'WE ARE A QUANT FIRM - PREFER QUICK TRADES (SHORT DURATION)' : 'SWING TRADING - LARGER MOVES, LONGER HOLDS'}             │
│                                                                             │
│ ${cfg.isScalping ? 'IDEAL SETUPS:' : 'IDEAL SETUPS:'}                                                               │
│   • ${cfg.isScalping ? `Clear momentum with ${cfg.targetProfitPercent}% move potential in hours` : `Strong trend with ${cfg.targetProfitPercent}% move potential over days`}                        │
│   • ${cfg.isScalping ? 'High volume coins with tight spreads' : 'Clear catalyst with defined timeline'}                                    │
│   • ${cfg.isScalping ? 'Breakout/breakdown setups near key levels' : 'Technical breakout with fundamental support'}                               │
│   • Funding rate favoring our direction                                     │
│                                                                             │
│ TARGETS: TP ${cfg.targetProfitPercent}% | SL ${cfg.styleStopLossPercent}% | Max Hold ${cfg.maxHoldHours}h | Min R/R ${cfg.minRiskRewardRatio}:1              │
└─────────────────────────────────────────────────────────────────────────────┘

DECISION FRAMEWORK (TWO-STEP):
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: MANAGE vs TRADE (evaluate MANAGE first - 50/50 importance)         │
│   MANAGE if: P&L > +${cfg.takeProfitThresholds.partial25}% (take profits!), P&L < -${cfg.styleStopLossPercent}%, hold > ${Math.round(cfg.maxHoldHours / 24 * 10) / 10} day${cfg.maxHoldHours >= 24 ? 's' : ''}            │
│   TRADE only if: No positions need attention AND clear ${cfg.isScalping ? 'scalp' : 'swing'} opportunity   │
│                                                                             │
│ STEP 2: If TRADE → LONG vs SHORT based on market setup                     │
└─────────────────────────────────────────────────────────────────────────────┘

QUALITY BAR:
- Use specific NUMBERS in your reason
- Include microstructure metrics (funding, OI, liquidations)
- For MANAGE picks: cite specific P&L, hold time, or changed conditions
- Avoid generic claims—cite specific data points

OUTPUT REQUIREMENTS:
• symbol: Exact WEEX symbol (e.g., "cmt_btcusdt", "cmt_solusdt")
• action: "MANAGE" | "LONG" | "SHORT" (evaluate MANAGE first!)
  - MANAGE = close, reduce, or adjust existing position (PRIORITY)
  - LONG/SHORT = open new position (only if no positions need attention)
• conviction: 1-10 scale
• reason: ONE sentence with SPECIFIC data

${coreIdentity}

Respond with JSON:
{
    "picks": [
        { "symbol": "cmt_ethusdt", "action": "MANAGE", "conviction": 9, "reason": "Position at +8% profit for 3 days, funding turning against us at 0.04%, TAKE_PARTIAL 50% to lock gains" },
        { "symbol": "cmt_solusdt", "action": "LONG", "conviction": 7, "reason": "+4.2% outperforming BTC with negative funding -0.02% suggesting short squeeze potential" },
        { "symbol": "cmt_btcusdt", "action": "SHORT", "conviction": 5, "reason": "Rejection at 98k resistance with rising OI suggesting overleveraged longs" }
    ]
}

Respond ONLY with valid JSON. No markdown or extra prose.`;
}

/**
 * Build the specialist analysis prompt for Stage 3
 * Used by: CollaborativeFlow.ts → runSpecialistAnalysis()
 */
export function buildSpecialistPrompt(
    profile: AnalystAgent,
    marketData: ExtendedMarketData,
    direction: 'LONG' | 'SHORT'
): string {
    // Validate required fields
    validateRequired(profile.name, 'profile.name');
    validateRequired(profile.title, 'profile.title');
    validateRequired(marketData.symbol, 'marketData.symbol');

    const name = sanitizeString(profile.name, 100);
    const displaySymbol = cleanSymbol(marketData.symbol);
    const change = safePercent(marketData.change24h, 2, true);

    // Guard against division by zero in range calculations with Number.isFinite checks
    const low24h = Number.isFinite(marketData.low24h) ? marketData.low24h : 0;
    const high24h = Number.isFinite(marketData.high24h) ? marketData.high24h : 0;
    const currentPrice = Number.isFinite(marketData.currentPrice) ? marketData.currentPrice : 0;

    // Calculate range with explicit zero-range check
    let range24h = 'N/A';
    let priceInRange = '50.0';

    if (high24h > 0 && low24h > 0 && high24h !== low24h) {
        const rangeDenom = low24h > 0 ? low24h : (currentPrice > 0 ? currentPrice : 1);
        const rangeValue = ((high24h - low24h) / rangeDenom * 100);
        range24h = Number.isFinite(rangeValue) ? rangeValue.toFixed(2) : 'N/A';

        // Calculate price position in range
        const priceRangeDenom = high24h - low24h;
        if (priceRangeDenom > 0 && Number.isFinite(currentPrice)) {
            const positionValue = ((currentPrice - low24h) / priceRangeDenom * 100);
            priceInRange = Number.isFinite(positionValue) ? positionValue.toFixed(1) : '50.0';
        }
    } else if (high24h === low24h && high24h > 0) {
        range24h = '0.00'; // Explicitly show zero range
        priceInRange = '50.0';
    }

    const fundingDirection = marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)
        ? (marketData.fundingRate > 0 ? 'longs paying shorts' : 'shorts paying longs')
        : 'N/A';

    const fundingRateStr = marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)
        ? `- Funding Rate: ${safeNumber(marketData.fundingRate * 100, 4)}% (${fundingDirection})`
        : '';

    // Add prominent funding warning when against proposed direction
    // Threshold: 0.01% (0.0001) is considered significant
    let fundingWarningStr = '';
    if (marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)) {
        const fundingAgainstDirection = (direction === 'LONG' && marketData.fundingRate > 0.0001) ||
            (direction === 'SHORT' && marketData.fundingRate < -0.0001);
        if (fundingAgainstDirection) {
            const fundingCost = Math.abs(marketData.fundingRate * 100);
            fundingWarningStr = `
⚠️ FUNDING RATE WARNING ⚠️
The funding rate is AGAINST your ${direction} position!
- Current funding: ${safeNumber(fundingCost, 4)}% per 8 hours
- Daily cost: ~${safeNumber(fundingCost * 3, 4)}% (3 funding periods)
- This will ERODE your profits over time
- Consider this cost in your risk/reward calculation
`;
        }
    }

    // GET THE FILTERED SYSTEM PROMPT FOR THIS ANALYST
    // For specialist analysis (LONG/SHORT), filter out management sections to save tokens
    const fullSystemPrompt = getSystemPrompt(profile.methodology, THESIS_SYSTEM_PROMPTS, direction);

    // Get validated config values for dynamic limits
    const cfg = getValidatedTradingConfig();

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• Methodology-Only Mode: Use your methodology as an analytical LENS
• DO NOT recommend a different coin or direction in Stage 3

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - STAGE 3: CHAMPIONSHIP DEBATE
═══════════════════════════════════════════════════════════════════════════════

You are competing in the CHAMPIONSHIP DEBATE for ${displaySymbol}/USDT ${direction} position.

This is Stage 3 of the Hypothesis Arena collaborative pipeline:
- Stage 1 (Market Scan): Assessed trading environment
- Stage 2 (Coin Selection): 4 analysts selected ${displaySymbol} as the top opportunity
- Stage 3 (YOU ARE HERE): All 8 analysts compete in championship debate
- Stage 4 (Risk Council): Karen will review the winning thesis
- Stage 5 (Execution): Place trade on WEEX
- Stage 6 (Position Management): Monitor and adjust

MARKET DATA:
- Current Price: ${safePrice(marketData.currentPrice)}
- 24h High: ${safePrice(marketData.high24h)}
- 24h Low: ${safePrice(marketData.low24h)}
- 24h Range: ${range24h}% (price at ${priceInRange}% of range)
- 24h Change: ${change}
- 24h Volume: ${safeNumber((marketData.volume24h ?? 0) / 1e6, 1)}M
${fundingRateStr}${fundingWarningStr}

TOURNAMENT JUDGING CRITERIA (Your thesis will be scored on):
1. DATA QUALITY (25%): Use specific numbers, not vague claims
   - Reference actual market data (price, volume, funding, OI)
   - Quantify risks and targets with specific numbers
   - Use on-chain metrics where relevant (TVL, MVRV, active addresses)
   - Avoid vague language like "could", "might", "possibly"

2. LOGIC (25%): Reasoning must follow from the data
   - Arguments are internally consistent
   - Conclusions match the evidence presented
   - Cause-effect relationships are clear
   - No logical fallacies or contradictions

3. RISK AWARENESS (25%): Acknowledge what could go wrong
   - Has realistic bear case with specific scenarios
   - Stop loss is reasonable (≤${cfg.maxStopLossPercent}% from entry)
   - Identifies thesis invalidation triggers
   - Acknowledges own biases and blind spots

4. CATALYST (25%): Clear price driver with timeline
   - Specific catalyst identified (not just "will go up")
   - Timeline specified (when will catalyst occur)
   - Expected impact quantified (how much move)
   - Explains why catalyst will move price

EXECUTION REQUIREMENTS:
- Apply YOUR FULL METHODOLOGY from your system prompt above
- Use your analytical frameworks, scorecards, and checklists
- Cite specific metrics relevant to your methodology
- Build a complete thesis that will win debates in Stage 4
- Leverage: 1-${cfg.maxLeverage}x max (crypto volatility requires tight risk management)
- Position size: 1-10 scale (scaled to conviction and risk)
- Stop loss: ≤${cfg.maxStopLossPercent}% from entry unless justified by volatility/structure
- Time horizon: ${cfg.isScalping ? `SCALPING - target ${cfg.targetProfitPercent}% moves over hours to ${cfg.maxHoldDays.toFixed(1)} days` : `SWING - target ${cfg.targetProfitPercent}% moves over ${cfg.maxHoldDays.toFixed(0)} days`}

TRADING STYLE - ${cfg.isScalping ? 'HIGH FREQUENCY SCALPING' : 'SWING TRADING'}:
┌─────────────────────────────────────────────────────────────────────────────┐
│ ${cfg.isScalping ? 'WE ARE A QUANT TRADING FIRM - VOLUME OVER SIZE' : 'SWING TRADING - QUALITY OVER QUANTITY'}                              │
│                                                                             │
│ TARGET PARAMETERS (from config):                                            │
│   • Take Profit: ${cfg.targetProfitPercent}% from entry                                           │
│   • Stop Loss: ${cfg.styleStopLossPercent}% from entry                                             │
│   • Risk/Reward: ${cfg.minRiskRewardRatio}:1 minimum                                            │
│   • Max Hold: ${cfg.maxHoldHours} hours (${cfg.maxHoldDays.toFixed(1)} days)                                          │
│                                                                             │
│ PROFIT TAKING THRESHOLDS:                                                   │
│   • +${cfg.takeProfitThresholds.breakeven}%: Move stop to breakeven                                        │
│   • +${cfg.takeProfitThresholds.partial25}%: Take 25% profits                                              │
│   • +${cfg.takeProfitThresholds.partial50}%: Take 50% profits                                              │
│   • +${cfg.takeProfitThresholds.partial75}%: Take 75% profits                                              │
└─────────────────────────────────────────────────────────────────────────────┘

DEBATE PREPARATION:
Your thesis will compete against 2 other specialists in Stage 4. To win:
- Lead with your strongest data points (cite specific numbers)
- Quantify your edge (why is this opportunity mispriced?)
- Acknowledge counterarguments preemptively (shows risk awareness)
- Provide clear invalidation triggers (what proves you wrong?)
- Tie to near-term catalysts with probability estimates

DATA CHECKLIST:
- Price, % change, 24h range position, and volume
- Funding rate direction and cost analysis if against position
- Method-specific metrics (e.g., Z-score, TVL, MVRV, basis, OI)
- Risk/reward distances (%) and invalidation triggers
- One cross-check from another methodology to avoid overfitting

Apply your ${name} methodology rigorously. This is a DEEP analysis, not a quick take.

ANALYST METHODOLOGY REFERENCE (read after stage instructions):
${fullSystemPrompt}

Respond with JSON:
{
    "recommendation": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
    "confidence": 0-100,
    "entry": number (suggested entry price),
    "targets": { "bull": number, "base": number, "bear": number },
    "stopLoss": number,
    "leverage": 1-${cfg.maxLeverage},
    "positionSize": 1-10,
    "thesis": "Your main argument in 2-3 sentences with SPECIFIC numbers and methodology",
    "bullCase": ["Point 1 with data", "Point 2 with data", "Point 3 with data"],
    "bearCase": ["Risk 1 - what invalidates thesis", "Risk 2", "Risk 3"],
    "keyMetrics": ["Metric 1: value", "Metric 2: value", "Metric 3: value"],
    "catalyst": "What will trigger the move and WHEN (be specific)",
    "timeframe": "Expected duration (e.g., '2-5 days', '1-2 weeks')"
}

Respond ONLY with valid JSON. No markdown or extra prose.`;
}

/**
 * Build the risk council prompt for Stage 4
 * Used by: CollaborativeFlow.ts → runRiskCouncil()
 * 
 * Includes unrealized PnL from open positions
 */
export function buildRiskCouncilPrompt(
    profile: AnalystAgent,
    champion: PromptAnalysisResult,
    marketData: ExtendedMarketData,
    accountBalance: number,
    currentPositions: Array<{ symbol: string; side: string; size: number; entryPrice?: number; unrealizedPnl?: number }>,
    recentPnL: { day: number; week: number }
): string {
    // Validate required fields
    validateRequired(profile.name, 'profile.name');
    validateRequired(profile.title, 'profile.title');
    validateRequired(champion.analystName, 'champion.analystName');
    validateRequired(marketData.symbol, 'marketData.symbol');

    const name = sanitizeString(profile.name, 100);
    const championName = sanitizeString(champion.analystName, 100);
    const thesis = sanitizeString(champion.thesis, 500);

    const displaySymbol = cleanSymbol(marketData.symbol);
    const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
    const direction = isBullish ? 'LONG' : 'SHORT';

    // Calculate key risk metrics with division by zero guards and Number.isFinite checks
    const currentPrice = Number.isFinite(marketData.currentPrice) && marketData.currentPrice > 0
        ? marketData.currentPrice
        : 1;

    const bearTarget = champion.priceTarget?.bear ?? currentPrice;
    const baseTarget = champion.priceTarget?.base ?? currentPrice;

    const stopLossDistance = Math.abs((bearTarget - currentPrice) / currentPrice * 100);
    const takeProfitDistance = Math.abs((baseTarget - currentPrice) / currentPrice * 100);
    const riskRewardRatio = stopLossDistance > 0 ? takeProfitDistance / stopLossDistance : 0;

    // Get validated config values for dynamic limits
    const cfg = getValidatedTradingConfig();

    // Validate and clamp positionSize to expected range (0-10)
    const validatedPositionSize = Math.max(0, Math.min(10, Number(champion.positionSize) || 0));
    const positionPercent = (validatedPositionSize / 10) * cfg.maxPositionSizePercent; // Max position % at size 10

    // Check for correlation with existing positions
    const sameDirectionPositions = currentPositions.filter(p =>
        (direction === 'LONG' && p.side.toLowerCase().includes('long')) ||
        (direction === 'SHORT' && p.side.toLowerCase().includes('short'))
    );
    const correlationWarning = sameDirectionPositions.length > 0
        ? `WARNING: ${sameDirectionPositions.length} existing ${direction} position(s): ${sameDirectionPositions.map(p => p.symbol).join(', ')}`
        : 'OK - No correlation with existing positions';

    // Calculate total unrealized PnL from open positions
    let unrealizedPnLSection = '';
    const positionsWithPnL = currentPositions.filter(p => p.unrealizedPnl !== undefined && Number.isFinite(p.unrealizedPnl));
    if (positionsWithPnL.length > 0) {
        const totalUnrealizedPnL = positionsWithPnL.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
        const unrealizedPercent = accountBalance > 0 ? (totalUnrealizedPnL / accountBalance) * 100 : 0;
        unrealizedPnLSection = `- Unrealized P&L: ${safeNumber(totalUnrealizedPnL, 2)} USDT (${safePercent(unrealizedPercent, 2, true)})`;

        // Add warning if unrealized loss is significant
        if (unrealizedPercent < -5) {
            unrealizedPnLSection += `\n  ⚠️ WARNING: Significant unrealized loss - consider reducing new position size`;
        }
    }

    // Funding rate analysis with safety checks
    const fundingRate = marketData.fundingRate ?? 0;
    const fundingAgainstUs = marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate) && (
        (direction === 'LONG' && fundingRate > 0) ||
        (direction === 'SHORT' && fundingRate < 0)
    );
    const fundingWarning = fundingAgainstUs && Math.abs(fundingRate) > 0.0005
        ? `WARNING - FUNDING AGAINST US: ${safeNumber(fundingRate * 100, 4)}%`
        : marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)
            ? `OK - Funding rate acceptable: ${safeNumber(fundingRate * 100, 4)}%`
            : '- Funding rate: N/A';

    const priceTargets = formatPriceTargets(champion.priceTarget);

    // GET THE FILTERED SYSTEM PROMPT FOR KAREN (RISK MANAGER)
    // For risk council, we're evaluating a trade (LONG/SHORT), so filter out management sections
    const fullSystemPrompt = getSystemPrompt(profile.methodology, THESIS_SYSTEM_PROMPTS, direction);

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• You are THE RISK MANAGER with veto power; follow RULES strictly
• Output MUST match the specified JSON structure

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - STAGE 4: RISK COUNCIL REVIEW
═══════════════════════════════════════════════════════════════════════════════

You are ${name} - THE RISK MANAGER with VETO POWER over all trades.

This is Stage 4 of the Hypothesis Arena collaborative pipeline:
- Stage 1 (Market Scan): Assessed trading environment
- Stage 2 (Coin Selection): 4 analysts selected ${displaySymbol}
- Stage 3 (Championship): ${championName} won the championship debate with all 8 analysts competing
- Stage 4 (YOU ARE HERE): You review the winning thesis and APPROVE or VETO
- Stage 5 (Execution): Place trade on WEEX
- Stage 6 (Position Management): Monitor and adjust

Your job is to PROTECT THE PORTFOLIO using your full risk management methodology above.

PROPOSED TRADE:
- Symbol: ${displaySymbol}/USDT
- Direction: ${direction}
- Champion: ${championName} (${safeNumber(champion.confidence, 0)}% confidence)
- Thesis: ${thesis}

TRADE PARAMETERS:
- Entry: ${safePrice(marketData.currentPrice)}
- Take Profit: ${priceTargets.base} (+${safeNumber(takeProfitDistance, 2)}%)
- Stop Loss: ${priceTargets.bear} (-${safeNumber(stopLossDistance, 2)}%)
- Risk/Reward: 1:${safeNumber(riskRewardRatio, 2)}
- Position Size: ${safeNumber(validatedPositionSize, 0)}/10 (${safeNumber(positionPercent, 1)}% of account)
- Proposed Leverage: ${(() => {
            // Validate and clamp leverage with NaN/Infinity guards
            const rawLeverage = champion.leverage ?? 1;
            const validLeverage = Number.isFinite(rawLeverage) && rawLeverage >= 1 ? rawLeverage : 1;
            const clampedLeverage = Math.min(cfg.maxLeverage, Math.max(1, validLeverage));
            return safeNumber(clampedLeverage, 1);
        })()}x (max ${cfg.maxLeverage}x allowed)

ACCOUNT STATE:
- Available Balance: ${safeNumber(accountBalance, 2)} USDT
- Proposed Margin Usage: ${safeNumber(positionPercent, 1)}% (${safeNumber(accountBalance * positionPercent / 100, 2)} USDT)
- Current Positions: ${currentPositions.length > 0 ? currentPositions.map(p => `${p.symbol} ${p.side}`).join(', ') : 'None'}
${unrealizedPnLSection ? unrealizedPnLSection + '\n' : ''}- 24h P&L: ${safePercent(recentPnL.day, 2, true)}
- 7d P&L: ${safePercent(recentPnL.week, 2, true)}

IMPORTANT - NET EXPOSURE CALCULATION:
"Net exposure" refers to the MARGIN USED (not notional value with leverage).
- Proposed margin for this trade: ${safeNumber(positionPercent, 1)}% of portfolio
- Net exposure limit: ≤${cfg.netExposureLong}% for LONG, ≤${cfg.netExposureShort}% for SHORT (margin used, not notional)
- With leverage, notional value will be higher, but the LIMIT APPLIES TO MARGIN USED
- Example: 20% margin with ${cfg.maxLeverage}x leverage = ${20 * cfg.maxLeverage}% notional, but only 20% net exposure ✅
- This allows ~${Math.floor(cfg.netExposureLong / cfg.maxPositionSizePercent)} max-size positions (${cfg.maxPositionSizePercent}% each) to run concurrently

MARKET CONDITIONS:
- ${displaySymbol} 24h Change: ${safePercent(marketData.change24h, 2, true)}
- ${fundingWarning}
- ${correlationWarning}

${formatTradingRulesForAI()}

YOUR CHECKLIST (from FLOW.md):
[ ] Position size ≤${cfg.maxPositionSizePercent}% of account? (Currently: ${safeNumber(positionPercent, 1)}%)
[ ] Stop loss ≤${cfg.maxStopLossPercent}% from entry? (Currently: ${safeNumber(stopLossDistance, 2)}%)
[ ] Leverage ≤${cfg.maxLeverage}x? (Max allowed)
[ ] Not overexposed to one direction? (${sameDirectionPositions.length}/${cfg.maxSameDirectionPositions} same-direction positions)
[ ] Funding rate acceptable? (≤${cfg.maxFundingAgainstPercent.toFixed(2)}% against us)
[ ] Recent drawdown acceptable? (7d: ${safePercent(recentPnL.week, 2)}, limit: ${cfg.maxWeeklyDrawdown}%)
[ ] Correlation & Regime: BTC beta/regime risk acceptable? (reduce size if beta > 0.7 or in chop)
[ ] Portfolio Heat: risk per trade ≤${cfg.maxRiskPerTrade}% of account; concurrent risk ≤${cfg.maxConcurrentRisk}%
[ ] Net Exposure: net LONG ≤${cfg.netExposureLong}% or net SHORT ≤${cfg.netExposureShort}% (reduce size if exceeded)

DECISION CRITERIA:
- PREFER ADJUSTING over VETOING - only veto for hard blockers (max positions, weekly drawdown)
- If position size exceeds limit → ADJUST DOWN to ${cfg.maxPositionSizePercent}% and APPROVE
- If stop loss too wide → TIGHTEN stop loss and APPROVE
- If leverage too high → REDUCE leverage and APPROVE
- Approve with adjustments unless a HARD BLOCKER exists

HARD BLOCKERS (MUST veto - cannot be adjusted):
X Already at MAX_CONCURRENT_POSITIONS limit (currently: ${currentPositions.length}/${cfg.maxConcurrentPositions})
X 7d drawdown >${cfg.maxWeeklyDrawdown}% (reduce risk, no new trades)
X Same direction limit reached (${sameDirectionPositions.length}/${cfg.maxSameDirectionPositions} ${direction} positions)

ADJUSTABLE ISSUES (FIX and APPROVE - do NOT veto):
→ Position size >${cfg.maxPositionSizePercent}%? → Set positionSize to fit within ${cfg.maxPositionSizePercent}%
→ Stop loss >${cfg.maxStopLossPercent}%? → Tighten stopLoss to ≤${cfg.maxStopLossPercent}% from entry
→ Leverage too high? → Reduce leverage to safe level
→ Funding rate high? → Reduce position size, still APPROVE

RISK METHODOLOGY REFERENCE (read after stage instructions):
${fullSystemPrompt}

Respond with JSON:
{
    "approved": true/false,
    "adjustments": {
        "positionSize": number (1-10, reduce if needed),
        "leverage": number (1-${cfg.maxLeverage}, reduce if volatility high),
        "stopLoss": number (tighter stop loss price if needed)
    },
    "warnings": ["Warning 1", "Warning 2"],
    "vetoReason": "Only if approved=false, explain which rule was violated"
}`;
}

/**
 * Build the debate prompt for Stage 4
 * Used by: GeminiService.ts → generateDebate()
 */
export function buildDebatePrompt(
    roundLabel: string,
    displaySymbol: string,
    bullAnalysis: PromptAnalysisResult,
    bearAnalysis: PromptAnalysisResult,
    marketData: PromptMarketData
): string {
    // Validate required fields
    validateRequired(roundLabel, 'roundLabel');
    validateRequired(displaySymbol, 'displaySymbol');
    validateRequired(bullAnalysis.analystName, 'bullAnalysis.analystName');
    validateRequired(bearAnalysis.analystName, 'bearAnalysis.analystName');

    const bullName = sanitizeString(bullAnalysis.analystName, 100);
    const bearName = sanitizeString(bearAnalysis.analystName, 100);
    const bullThesis = sanitizeString(bullAnalysis.thesis, 500);
    const bearThesis = sanitizeString(bearAnalysis.thesis, 500);

    const bullBullCase = safeArrayJoin(bullAnalysis.bullCase, ' | ', 3);
    const bearBearCase = safeArrayJoin(bearAnalysis.bearCase, ' | ', 3);

    // Handle keyMetrics which can be Record<string, unknown> or string[]
    const bullMetrics = Array.isArray(bullAnalysis.keyMetrics)
        ? JSON.stringify(bullAnalysis.keyMetrics)
        : JSON.stringify(bullAnalysis.keyMetrics || {});
    const bearMetrics = Array.isArray(bearAnalysis.keyMetrics)
        ? JSON.stringify(bearAnalysis.keyMetrics)
        : JSON.stringify(bearAnalysis.keyMetrics || {});

    // Use canonical price field with backward compatibility
    const price = getCanonicalPrice(marketData) ?? 0;
    const priceStr = safePrice(price, price > 0 && price < 1 ? 6 : 2);
    const changeStr = safePercent(marketData.change24h, 2, true);
    const volumeStr = marketData.volume24h
        ? `24h Volume: ${marketData.volume24h.toLocaleString()}`
        : '';

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• Focus on DEBATE QUALITY: data, logic, risk, catalysts
• Obey TURN STRUCTURE and OUTPUT FORMAT exactly

You are moderating a ${roundLabel} debate between two elite crypto analysts about ${displaySymbol}/USDT.

BULL ANALYST: ${bullName} ${bullAnalysis.analystEmoji} (${bullAnalysis.analystTitle})
Recommendation: ${bullAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(bullAnalysis.confidence, 0)}%
Thesis: ${bullThesis}
Bull Case: ${bullBullCase}
Key Metrics: ${bullMetrics}

BEAR ANALYST: ${bearName} ${bearAnalysis.analystEmoji} (${bearAnalysis.analystTitle})
Recommendation: ${bearAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(bearAnalysis.confidence, 0)}%
Thesis: ${bearThesis}
Bear Case: ${bearBearCase}
Key Metrics: ${bearMetrics}

MARKET DATA
Current Price: ${priceStr}
24h Change: ${changeStr}
${volumeStr}

DATA CHECKLIST:
- On-chain (e.g., TVL, MVRV, active addresses, exchange flows)
- Microstructure (e.g., funding, OI, liquidations, basis, volume profile)
- Timeframe alignment between targets and catalysts
- Crowding awareness if funding/OI are extreme

DEBATE INSTRUCTIONS
Generate a 12-turn debate (6 turns each, alternating). This is a DEEP, SUBSTANTIVE debate between elite analysts.

TURN STRUCTURE:
- Turns 1-2: Opening statements with full thesis and key data
- Turns 3-4: Risk cases, invalidation triggers, and bear/bull scenarios
- Turns 5-8: Deep dive into contentious points - attack opponent's assumptions with data
- Turns 9-10: Address opponent's strongest arguments with counter-evidence
- Turns 11-12: Closing arguments summarizing why your thesis wins

Each turn should:
1. Reference SPECIFIC data points and metrics (cite numbers, not vague claims)
2. Directly counter the opponent's previous argument (engage, don't ignore)
3. Stay true to the analyst's methodology and personality
4. Be 120-180 words per turn (substantive, not superficial)

Turn Requirements (crypto-specific):
- Include at least ONE on-chain metric (e.g., TVL, MVRV, active addresses, realized cap) AND ONE microstructure metric (e.g., funding rate, OI, liquidations, volume profile, basis).
- If leverage is mentioned, quantify liquidation math and adverse-move scenarios with specific numbers.
- Tie arguments to specific catalysts with probability estimates and timing.
- Challenge opponent's assumptions with data, not just assertions.
- Acknowledge strong counter-arguments before refuting them.

Judging Pitfalls to Avoid:
- Price-only arguments without supporting metrics.
- Ignoring funding/OI crowding risk or regime (trend vs chop).
- Timeframe mismatch (targets/catalysts not aligned to debate horizon).
- Methodology drift or contradiction; missing invalidation/risks.
- Talking past opponent instead of engaging their points.

Score each analyst on (from prompts judging criteria):
- Data Quality (0-100): How well they use specific numbers and metrics
- Logic Coherence (0-100): How well-structured and reasoned their arguments are
- Risk Acknowledgment (0-100): How well they acknowledge counterarguments
- Catalyst Identification (0-100): How well they identify price catalysts

Respond in JSON format:
{
    "turns": [
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Opening statement with thesis and data", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2", "metric3"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Opening counter-thesis with data", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Risk case and invalidation triggers", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Risk case and thesis defense", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Attack bear's key assumption with data", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Defend assumption and counter-attack", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Deep dive into contentious metric", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Challenge bull's interpretation with data", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Address bear's strongest point", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Address bull's strongest point", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Closing argument - why thesis wins", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Closing argument - why thesis wins", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]}
    ],
    "winner": "bull" | "bear" | "draw",
    "scores": {
        "bullScore": 0-100,
        "bearScore": 0-100,
        "dataQuality": {"bull": 0-100, "bear": 0-100},
        "logicCoherence": {"bull": 0-100, "bear": 0-100},
        "riskAcknowledgment": {"bull": 0-100, "bear": 0-100},
        "catalystIdentification": {"bull": 0-100, "bear": 0-100}
    },
    "winningArguments": ["Key winning point 1", "Key winning point 2", "Key winning point 3"],
    "summary": "One paragraph summary of the debate outcome and why the winner prevailed"
}
Respond ONLY with valid JSON matching this exact structure.`;
}

/**
 * Build the single-judge fallback prompt for Stage 4
 * Used by: CollaborativeFlow.ts → runSingleJudgeFallback()
 * When debate matches fail, this prompt has Gemini score all theses against each other
 */
export function buildSingleJudgeFallbackPrompt(
    displaySymbol: string,
    specialists: PromptSpecialist[],
    marketData: PromptMarketData
): string {
    // Validate inputs
    validateRequired(displaySymbol, 'displaySymbol');

    if (!Array.isArray(specialists) || specialists.length === 0) {
        throw new Error('specialists array must be non-empty');
    }

    // GET KAREN'S (RISK MANAGER) FULL SYSTEM PROMPT
    // She's the one judging when tournament debates fail
    // Validates that the methodology exists and throws clear error if not
    const karenPrompt = getSystemPrompt('risk', THESIS_SYSTEM_PROMPTS);

    const analystSummaries = specialists.map((s, i) => {
        const name = sanitizeString(s.analystName, 100);
        const title = sanitizeString(s.analystTitle, 200);
        const thesis = sanitizeString(s.thesis, 500);
        const bullCase = safeArrayJoin(s.bullCase, '; ', 2);
        const bearCase = safeArrayJoin(s.bearCase, '; ', 2);
        const priceTargets = formatPriceTargets(s.priceTarget);

        return `
ANALYST ${i + 1}: ${name} (${title})
- Recommendation: ${s.recommendation.toUpperCase().replace('_', ' ')}
- Confidence: ${safeNumber(s.confidence, 0)}%
- Position Size: ${safeNumber(s.positionSize, 0)}/10
- Thesis: ${thesis}
- Bull Case: ${bullCase}
- Bear Case: ${bearCase}
- Price Targets: Bull ${priceTargets.bull}, Base ${priceTargets.base}, Bear ${priceTargets.bear}
`;
    }).join('\n');

    const analystIds = specialists.map(s => `"${s.analystId}"`).join(', ');
    const fundingStr = marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)
        ? `- Funding Rate: ${safeNumber(marketData.fundingRate * 100, 4)}%`
        : '';

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• You are in SINGLE-JUDGE mode; make a FINAL decision
• Focus on RISK-ADJUSTED strength; obey JSON output requirements

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - STAGE 4: SINGLE-JUDGE FALLBACK (Tournament Failed)
═══════════════════════════════════════════════════════════════════════════════

The tournament debates failed, so YOU (Karen, Risk Manager) must make the FINAL DECISION.

Apply your FULL RISK MANAGEMENT METHODOLOGY to select the SINGLE BEST thesis.

MARKET CONTEXT:
- Symbol: ${displaySymbol}/USDT
- Current Price: ${safePrice(marketData.currentPrice)}
- 24h Change: ${safePercent(marketData.change24h, 2, true)}
${fundingStr}

COMPETING THESES:
${analystSummaries}

JUDGING CRITERIA (score each 0-25):
1. DATA QUALITY: Uses specific numbers, not vague claims
2. LOGIC: Reasoning follows from data
3. RISK AWARENESS: Acknowledges what could go wrong (YOUR PRIMARY STRENGTH)
4. CATALYST: Clear price driver with timeline

Select the SINGLE BEST thesis. The winner's recommendation will be EXECUTED as a real trade.

Apply YOUR RISK MANAGEMENT FRAMEWORK:
- Evaluate liquidation risk at proposed leverage
- Calculate funding rate drag
- Assess downside scenarios and tail risks
- Check position sizing against portfolio limits
- Verify stop loss distances are acceptable
- Consider volatility regime and market conditions

Crypto-Specific Reminders:
- Prefer on-chain metrics (TVL, MVRV, active addresses, exchange flows) and microstructure (funding, OI, liquidations, basis)
- If leverage is proposed, include liquidation math and funding drag/carry implications
- Catalysts: token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes; near-term (7–14 days) with date/timeline and expected impact
- Debate rather than repeat—address the opponent’s strongest claim with numbers and risk-adjusted reasoning
- Penalize vague statements; reward quantified, time-bound, risk-aware theses

RISK METHODOLOGY REFERENCE (read after stage instructions):
${karenPrompt}

Respond with JSON:
{
    "winner": "${specialists[0].analystId}" (analyst ID of winner - must be one of: ${analystIds}),
    "reasoning": "Why this thesis is strongest from a RISK-ADJUSTED perspective",
    "scores": {
        "${specialists[0].analystId}": { "data": 0-25, "logic": 0-25, "risk": 0-25, "catalyst": 0-25, "total": 0-100 }
        // ... scores for each analyst
    }
}

Respond ONLY with valid JSON. No markdown or extra prose.`;
}


/**
 * Build the tournament debate match prompt for Stage 4
 * Used by: CollaborativeFlow.ts → runDebateMatch()
 * Judges a head-to-head debate between two analysts
 */
export function buildTournamentDebatePrompt(
    roundLabel: string,
    displaySymbol: string,
    analystA: {
        analystId: string;
        analystName: string;
        analystEmoji: string;
        analystTitle: string;
        recommendation: string;
        confidence: number;
        positionSize: number;
        thesis: string;
        bullCase?: string[];
        bearCase?: string[];
        priceTarget: { bull: number; base: number; bear: number };
        catalysts?: string[];
    },
    analystB: {
        analystId: string;
        analystName: string;
        analystEmoji: string;
        analystTitle: string;
        recommendation: string;
        confidence: number;
        positionSize: number;
        thesis: string;
        bullCase?: string[];
        bearCase?: string[];
        priceTarget: { bull: number; base: number; bear: number };
        catalysts?: string[];
    },
    marketData: { currentPrice: number; change24h: number; fundingRate?: number }
): string {
    // Validate required fields
    validateRequired(roundLabel, 'roundLabel');
    validateRequired(displaySymbol, 'displaySymbol');
    validateRequired(analystA.analystId, 'analystA.analystId');
    validateRequired(analystA.analystName, 'analystA.analystName');
    validateRequired(analystB.analystId, 'analystB.analystId');
    validateRequired(analystB.analystName, 'analystB.analystName');

    // GET KAREN'S (RISK MANAGER) FULL SYSTEM PROMPT
    // She's the one judging the tournament debates
    // Validates that the methodology exists and throws clear error if not
    const karenPrompt = getSystemPrompt('risk', THESIS_SYSTEM_PROMPTS);

    // Sanitize analyst A data
    const nameA = sanitizeString(analystA.analystName, 100);
    const titleA = sanitizeString(analystA.analystTitle, 200);
    const thesisA = sanitizeString(analystA.thesis, 500);
    const bullCaseA = safeArrayJoin(analystA.bullCase, '\n', 3, '- N/A');
    const bearCaseA = safeArrayJoin(analystA.bearCase, '\n', 3, '- N/A');
    const priceTargetsA = formatPriceTargets(analystA.priceTarget);
    const catalystA = analystA.catalysts?.[0] ? sanitizeString(analystA.catalysts[0], 200) : 'Not specified';

    // Sanitize analyst B data
    const nameB = sanitizeString(analystB.analystName, 100);
    const titleB = sanitizeString(analystB.analystTitle, 200);
    const thesisB = sanitizeString(analystB.thesis, 500);
    const bullCaseB = safeArrayJoin(analystB.bullCase, '\n', 3, '- N/A');
    const bearCaseB = safeArrayJoin(analystB.bearCase, '\n', 3, '- N/A');
    const priceTargetsB = formatPriceTargets(analystB.priceTarget);
    const catalystB = analystB.catalysts?.[0] ? sanitizeString(analystB.catalysts[0], 200) : 'Not specified';

    // Format market data safely
    const priceStr = safePrice(marketData.currentPrice);
    const changeStr = safePercent(marketData.change24h, 2, true);
    const fundingStr = marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)
        ? `- Funding Rate: ${safeNumber(marketData.fundingRate * 100, 4)}%`
        : '';

    return `═══════════════════════════════════════════════════════════════════════════════
PRIORITY DIRECTIVE - STAGE OVERRIDES
═══════════════════════════════════════════════════════════════════════════════
• Stage-specific instructions OVERRIDE persona/system prompts
• You are JUDGING a tournament debate; focus on criteria and risk
• Output MUST follow the specified JSON structure

═══════════════════════════════════════════════════════════════════════════════
COLLABORATIVE FLOW - STAGE 4: TOURNAMENT JUDGING (${roundLabel})
═══════════════════════════════════════════════════════════════════════════════

You are Karen, the Risk Manager, judging a ${roundLabel} debate about ${displaySymbol}/USDT.

Apply your FULL RISK MANAGEMENT METHODOLOGY to judge this debate.

${roundLabel}: ${nameA} vs ${nameB}

MARKET CONTEXT:
- Current Price: ${priceStr}
- 24h Change: ${changeStr}
${fundingStr}

ANALYST A: ${nameA} ${analystA.analystEmoji} (${titleA})

Recommendation: ${analystA.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(analystA.confidence, 0)}%
Position Size: ${safeNumber(analystA.positionSize, 0)}/10

THESIS: ${thesisA}

BULL CASE:
${bullCaseA}

BEAR CASE (Risks Acknowledged):
${bearCaseA}

PRICE TARGETS:
- Bull: ${priceTargetsA.bull}
- Base: ${priceTargetsA.base}
- Bear: ${priceTargetsA.bear}

CATALYST: ${catalystA}

ANALYST B: ${nameB} ${analystB.analystEmoji} (${titleB})

Recommendation: ${analystB.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(analystB.confidence, 0)}%
Position Size: ${safeNumber(analystB.positionSize, 0)}/10

THESIS: ${thesisB}

BULL CASE:
${bullCaseB}

BEAR CASE (Risks Acknowledged):
${bearCaseB}

PRICE TARGETS:
- Bull: ${priceTargetsB.bull}
- Base: ${priceTargetsB.base}
- Bear: ${priceTargetsB.bear}

CATALYST: ${catalystB}

JUDGING CRITERIA (from FLOW.md)

Score each analyst on these criteria (0-25 points each):

1. DATA QUALITY (25%): 
   - Uses specific numbers, not vague claims
   - References actual market data
   - Quantifies risks and targets

2. LOGIC (25%):
   - Reasoning is sound and follows from data
   - Arguments are internally consistent
   - Conclusions match the evidence

3. RISK AWARENESS (25%):
   - Acknowledges what could go wrong
   - Has realistic bear case
   - Stop loss is reasonable (≤10% from entry)
   - Considers liquidation risk and funding drag

4. CATALYST (25%):
   - Clear price driver identified
   - Timeline specified (prefer 7-14 days)
   - Expected impact quantified

Apply YOUR RISK MANAGEMENT FRAMEWORK:
- Evaluate liquidation risk at proposed leverage
- Calculate funding rate drag
- Assess downside scenarios and tail risks
- Check position sizing against portfolio limits
- Verify stop loss distances are acceptable
- Consider volatility regime and market conditions

Crypto-Specific Reminders:
- Prefer on-chain metrics (TVL, MVRV, active addresses, exchange flows) and microstructure (funding, OI, liquidations)
- If leverage is discussed, include liquidation math and funding drag/carry
- Near-term catalysts (7–14 days) with probability and impact are stronger

RISK METHODOLOGY REFERENCE (read after stage instructions):
${karenPrompt}

The winner's thesis will be EXECUTED as a real trade. Choose wisely.

Respond with JSON containing:
- winner: The analyst ID who won ("${analystA.analystId}" or "${analystB.analystId}")
- winnerScore: Scores for the winner { data, logic, risk, catalyst, total }
- loserScore: Scores for the loser { data, logic, risk, catalyst, total }
- reasoning: Why the winner won from a RISK-ADJUSTED perspective
- keyDifferentiator: The single most important factor`;
}
