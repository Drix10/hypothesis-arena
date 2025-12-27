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
import {
    safeNumber,
    safePrice,
    safePercent,
    sanitizeString,
    safeArrayJoin,
    validateRequired,
    formatPriceTargets
} from './promptHelpers';

/**
 * Build the coin selection prompt for Stage 2
 * Used by: CollaborativeFlow.ts → runCoinSelection()
 */
export function buildCoinSelectionPrompt(
    profile: AnalystAgent,
    marketSummary: string
): string {
    // Validate required fields
    validateRequired(profile.name, 'profile.name');
    validateRequired(profile.title, 'profile.title');
    validateRequired(marketSummary, 'marketSummary');

    const name = sanitizeString(profile.name, 100);
    const title = sanitizeString(profile.title, 200);
    const description = sanitizeString(profile.description, 500);
    const focusAreas = safeArrayJoin(profile.focusAreas, '\n', 10, '• No focus areas specified');

    return `You are ${name}, ${title}.

${description}

YOUR METHODOLOGY & FOCUS AREAS:
${focusAreas}

═══════════════════════════════════════════════════════════════════════════════
${marketSummary}
═══════════════════════════════════════════════════════════════════════════════

TASK: Select your TOP 3 trading opportunities from these 8 coins.

SCORING SYSTEM (your picks compete against other analysts):
• #1 pick = 3 points × conviction
• #2 pick = 2 points × conviction  
• #3 pick = 1 point × conviction

The coin with the highest TOTAL score across all analysts will be selected for deep analysis and potential execution.

SELECTION CRITERIA (apply your ${title} methodology):
1. MOMENTUM: Which coins show the strongest directional moves?
2. VOLUME: Is there conviction behind the price action?
3. FUNDING: Are traders positioned for a squeeze? (positive = crowded longs, negative = crowded shorts)
4. RELATIVE STRENGTH: Which coins are outperforming/underperforming the group?
5. YOUR EDGE: What does YOUR methodology see that others might miss?

OUTPUT REQUIREMENTS:
• symbol: Exact WEEX symbol (e.g., "cmt_btcusdt", "cmt_solusdt")
• direction: "LONG" (expecting price increase) or "SHORT" (expecting price decrease)
• conviction: 1-10 scale (BE HONEST - low conviction picks hurt your score)
  - 1-3: Speculative, weak signal
  - 4-6: Moderate confidence, some supporting data
  - 7-8: High confidence, strong signal alignment
  - 9-10: Exceptional setup, multiple confirming factors
• reason: ONE sentence with SPECIFIC data (e.g., "+5.2% with 2x avg volume" not "looks bullish")

Respond with JSON:
{
    "picks": [
        { "symbol": "cmt_solusdt", "direction": "LONG", "conviction": 8, "reason": "+4.2% outperforming BTC with negative funding suggesting short squeeze potential" },
        { "symbol": "cmt_btcusdt", "direction": "LONG", "conviction": 6, "reason": "Holding above 95k support with declining sell volume" },
        { "symbol": "cmt_dogeusdt", "direction": "SHORT", "conviction": 5, "reason": "Lagging the rally with extreme positive funding (0.08%) indicating crowded longs" }
    ]
}`;
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
    const title = sanitizeString(profile.title, 200);
    const description = sanitizeString(profile.description, 500);
    const focusAreas = safeArrayJoin(profile.focusAreas, '\n', 10, '- No focus areas specified');

    const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
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

    return `You are ${name}, ${title}.

${description}

YOUR KNOWN BIASES (acknowledge these in your analysis):
${focusAreas}

ANALYZE: ${displaySymbol}/USDT for a potential ${direction} position

MARKET DATA:
- Current Price: ${safePrice(marketData.currentPrice)}
- 24h High: ${safePrice(marketData.high24h)}
- 24h Low: ${safePrice(marketData.low24h)}
- 24h Range: ${range24h}% (price at ${priceInRange}% of range)
- 24h Change: ${change}
- 24h Volume: ${safeNumber(marketData.volume24h / 1e6, 1)}M
${fundingRateStr}

YOUR THESIS WILL BE JUDGED ON:
1. DATA QUALITY (25%): Use specific numbers, not vague claims
2. LOGIC (25%): Reasoning must follow from the data
3. RISK AWARENESS (25%): Acknowledge what could go wrong
4. CATALYST (25%): Clear price driver with timeline

Apply your ${title} methodology rigorously.

Respond with JSON:
{
    "recommendation": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
    "confidence": 0-100,
    "entry": number (suggested entry price),
    "targets": { "bull": number, "base": number, "bear": number },
    "stopLoss": number,
    "leverage": 1-5,
    "positionSize": 1-10,
    "thesis": "Your main argument in 2-3 sentences with SPECIFIC numbers",
    "bullCase": ["Point 1 with data", "Point 2 with data", "Point 3 with data"],
    "bearCase": ["Risk 1 - what invalidates thesis", "Risk 2", "Risk 3"],
    "keyMetrics": ["RSI: 65", "Volume: 1.2M", "Funding: 0.01%"],
    "catalyst": "What will trigger the move and WHEN",
    "timeframe": "Expected duration (e.g., '2-5 days')"
}`;
}

/**
 * Build the risk council prompt for Stage 5
 * Used by: CollaborativeFlow.ts → runRiskCouncil()
 */
export function buildRiskCouncilPrompt(
    profile: AnalystAgent,
    champion: PromptAnalysisResult,
    marketData: ExtendedMarketData,
    accountBalance: number,
    currentPositions: Array<{ symbol: string; side: string; size: number }>,
    recentPnL: { day: number; week: number }
): string {
    // Validate required fields
    validateRequired(profile.name, 'profile.name');
    validateRequired(profile.title, 'profile.title');
    validateRequired(champion.analystName, 'champion.analystName');
    validateRequired(marketData.symbol, 'marketData.symbol');

    const name = sanitizeString(profile.name, 100);
    const title = sanitizeString(profile.title, 200);
    const championName = sanitizeString(champion.analystName, 100);
    const thesis = sanitizeString(champion.thesis, 500);

    const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
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
    const positionPercent = (champion.positionSize / 10) * 30; // Max 30% at size 10

    // Check for correlation with existing positions
    const sameDirectionPositions = currentPositions.filter(p =>
        (direction === 'LONG' && p.side.toLowerCase().includes('long')) ||
        (direction === 'SHORT' && p.side.toLowerCase().includes('short'))
    );
    const correlationWarning = sameDirectionPositions.length > 0
        ? `WARNING: ${sameDirectionPositions.length} existing ${direction} position(s): ${sameDirectionPositions.map(p => p.symbol).join(', ')}`
        : 'OK - No correlation with existing positions';

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

    return `You are ${name}, ${title} - THE RISK MANAGER.

You have VETO POWER over all trades. Your job is to PROTECT THE PORTFOLIO.

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
- Position Size: ${safeNumber(champion.positionSize, 0)}/10 (${safeNumber(positionPercent, 1)}% of account)

ACCOUNT STATE:
- Balance: ${safeNumber(accountBalance, 2)}
- Current Positions: ${currentPositions.length > 0 ? currentPositions.map(p => `${p.symbol} ${p.side}`).join(', ') : 'None'}
- 24h P&L: ${safePercent(recentPnL.day, 2, true)}
- 7d P&L: ${safePercent(recentPnL.week, 2, true)}

MARKET CONDITIONS:
- ${displaySymbol} 24h Change: ${safePercent(marketData.change24h, 2, true)}
- ${fundingWarning}
- ${correlationWarning}

YOUR CHECKLIST (from FLOW.md):
[ ] Position size ≤30% of account? (Currently: ${safeNumber(positionPercent, 1)}%)
[ ] Stop loss ≤10% from entry? (Currently: ${safeNumber(stopLossDistance, 2)}%)
[ ] Leverage ≤5x? (Max allowed)
[ ] Not overexposed to one direction? (${sameDirectionPositions.length} same-direction positions)
[ ] Funding rate acceptable? (≤0.05% against us)
[ ] Recent drawdown acceptable? (7d: ${safePercent(recentPnL.week, 2)})

VETO TRIGGERS (MUST veto if ANY are true):
X Stop loss >10% from entry
X Position would exceed 30% of account
X Already have 3+ positions open
X 7d drawdown >10% (reduce risk, no new trades)
X Funding rate >0.05% against position direction

Respond with JSON:
{
    "approved": true/false,
    "adjustments": {
        "positionSize": number (1-10, reduce if needed),
        "leverage": number (1-5, reduce if volatility high),
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

    // Handle keyMetrics which can be Record<string, any> or string[]
    const bullMetrics = Array.isArray(bullAnalysis.keyMetrics)
        ? JSON.stringify(bullAnalysis.keyMetrics)
        : JSON.stringify(bullAnalysis.keyMetrics || {});
    const bearMetrics = Array.isArray(bearAnalysis.keyMetrics)
        ? JSON.stringify(bearAnalysis.keyMetrics)
        : JSON.stringify(bearAnalysis.keyMetrics || {});

    const price = marketData.price ?? marketData.currentPrice ?? 0;
    const priceStr = safePrice(price, price > 0 && price < 1 ? 6 : 2);
    const changeStr = safePercent(marketData.change24h, 2, true);
    const volumeStr = marketData.volume24h
        ? `24h Volume: ${marketData.volume24h.toLocaleString()}`
        : '';

    return `You are moderating a ${roundLabel} debate between two elite crypto analysts about ${displaySymbol}/USDT.

═══════════════════════════════════════════════════════════════════════════════
BULL ANALYST: ${bullName} ${bullAnalysis.analystEmoji} (${bullAnalysis.analystTitle})
═══════════════════════════════════════════════════════════════════════════════
Recommendation: ${bullAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(bullAnalysis.confidence, 0)}%
Thesis: ${bullThesis}
Bull Case: ${bullBullCase}
Key Metrics: ${bullMetrics}

═══════════════════════════════════════════════════════════════════════════════
BEAR ANALYST: ${bearName} ${bearAnalysis.analystEmoji} (${bearAnalysis.analystTitle})
═══════════════════════════════════════════════════════════════════════════════
Recommendation: ${bearAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${safeNumber(bearAnalysis.confidence, 0)}%
Thesis: ${bearThesis}
Bear Case: ${bearBearCase}
Key Metrics: ${bearMetrics}

═══════════════════════════════════════════════════════════════════════════════
MARKET DATA
═══════════════════════════════════════════════════════════════════════════════
Current Price: ${priceStr}
24h Change: ${changeStr}
${volumeStr}

═══════════════════════════════════════════════════════════════════════════════
DEBATE INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════════════
Generate a 4-turn debate (2 turns each, alternating). Each turn should:
1. Reference SPECIFIC data points and metrics
2. Counter the opponent's previous argument
3. Stay true to the analyst's methodology
4. Be 80-120 words per turn

Score each analyst on (from prompts judging criteria):
- Data Quality (0-100): How well they use specific numbers and metrics
- Logic Coherence (0-100): How well-structured and reasoned their arguments are
- Risk Acknowledgment (0-100): How well they acknowledge counterarguments
- Catalyst Identification (0-100): How well they identify price catalysts

Respond in JSON format:
{
    "turns": [
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Opening argument with data", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Rebuttal with counter-data", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bull", "analystName": "${bullName}", "argument": "Counter-argument", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bear", "analystName": "${bearName}", "argument": "Final point", "strength": 1-10, "dataPointsReferenced": ["metric1"]}
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

    return `You are a hedge fund CIO making a FINAL DECISION on ${displaySymbol}/USDT.

MARKET CONTEXT:
- Current Price: ${safePrice(marketData.currentPrice)}
- 24h Change: ${safePercent(marketData.change24h, 2, true)}
${fundingStr}

COMPETING THESES:
${analystSummaries}

JUDGING CRITERIA (score each 0-25):
1. DATA QUALITY: Uses specific numbers, not vague claims
2. LOGIC: Reasoning follows from data
3. RISK AWARENESS: Acknowledges what could go wrong
4. CATALYST: Clear price driver with timeline

Select the SINGLE BEST thesis. The winner's recommendation will be EXECUTED as a real trade.

Respond with JSON:
{
    "winner": "${specialists[0].analystId}" (analyst ID of winner - must be one of: ${analystIds}),
    "reasoning": "Why this thesis is strongest",
    "scores": {
        "${specialists[0].analystId}": { "data": 0-25, "logic": 0-25, "risk": 0-25, "catalyst": 0-25, "total": 0-100 }
        // ... scores for each analyst
    }
}`;
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

    return `You are a hedge fund CIO judging a ${roundLabel} debate about ${displaySymbol}/USDT.

===============================================================================
${roundLabel}: ${nameA} vs ${nameB}
===============================================================================

MARKET CONTEXT:
- Current Price: ${priceStr}
- 24h Change: ${changeStr}
${fundingStr}

-------------------------------------------------------------------------------
ANALYST A: ${nameA} ${analystA.analystEmoji} (${titleA})
-------------------------------------------------------------------------------
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

-------------------------------------------------------------------------------
ANALYST B: ${nameB} ${analystB.analystEmoji} (${titleB})
-------------------------------------------------------------------------------
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

===============================================================================
JUDGING CRITERIA (from FLOW.md)
===============================================================================

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
   - Stop loss is reasonable

4. CATALYST (25%):
   - Clear price driver identified
   - Timeline specified
   - Expected impact quantified

The winner's thesis will be EXECUTED as a real trade. Choose wisely.

Respond with JSON containing:
- winner: The analyst ID who won ("${analystA.analystId}" or "${analystB.analystId}")
- winnerScore: Scores for the winner { data, logic, risk, catalyst, total }
- loserScore: Scores for the loser { data, logic, risk, catalyst, total }
- reasoning: Why the winner won
- keyDifferentiator: The single most important factor`;
}
