/**
 * Debate Context Builder Helpers
 * 
 * Functions to build debate context strings from templates.
 * These replace hardcoded strings in CollaborativeFlow.ts
 */

import { DEBATE_CONTEXTS, DEBATE_TURN_INSTRUCTIONS } from './debateContexts';
// import { config } from '../../config'; // DEPRECATED: No longer needed after stage removal
import { safeNumber, cleanSymbol } from './promptHelpers';
import { formatTradingRulesForAI, getCriticalRulesSummary } from '../analyst/tradingRules';
import type { PortfolioPosition } from './builders';

/**
 * Build context for Coin Selection Debate (Stage 2)
 * 
 * ENHANCED: Now includes funding rate analysis per coin, trading rules,
 * AND current portfolio positions for portfolio-aware decision making
 * 
 * @param marketSummary - Formatted market data for all 8 coins
 * @param fundingAnalysis - Optional funding rate analysis for each coin
 * @param currentPositions - Optional current portfolio positions
 * @returns Complete debate context string
 */
export function buildCoinSelectionContext(
    marketSummary: string,
    fundingAnalysis?: Array<{
        symbol: string;
        fundingRate: number;
        fundingDirection: 'bullish' | 'bearish' | 'neutral';
    }>,
    currentPositions?: PortfolioPosition[]
): string {
    const ctx = DEBATE_CONTEXTS.coinSelection;

    // Build portfolio section if positions exist
    let portfolioSection = '';
    if (currentPositions && currentPositions.length > 0) {
        const positionsList = currentPositions.map(p => {
            const pnlSign = p.unrealizedPnlPercent >= 0 ? '+' : '';
            const holdDays = (p.holdTimeHours / 24).toFixed(1);
            return `  • ${cleanSymbol(p.symbol)} ${p.side}: Entry $${safeNumber(p.entryPrice, 2)} → $${safeNumber(p.currentPrice, 2)} | P&L: ${pnlSign}${safeNumber(p.unrealizedPnlPercent, 2)}% | Hold: ${holdDays}d`;
        }).join('\n');

        // Create list of position symbols for the constraint
        const positionSymbolsList = currentPositions.map(p => cleanSymbol(p.symbol)).join(', ');

        portfolioSection = `
═══════════════════════════════════════════════════════════════════════════════
CURRENT PORTFOLIO (${currentPositions.length} position${currentPositions.length > 1 ? 's' : ''})
═══════════════════════════════════════════════════════════════════════════════
${positionsList}

⚠️ MANAGE ACTION RULES:
- You can ONLY select "MANAGE" for coins WITH open positions: ${positionSymbolsList}
- Do NOT select MANAGE for coins without positions
- MANAGE triggers: P&L > +15% (take profits), P&L < -7% (cut losses), Hold > 5 days (stale thesis)
`;
    } else {
        portfolioSection = `
═══════════════════════════════════════════════════════════════════════════════
CURRENT PORTFOLIO: EMPTY (no open positions)
═══════════════════════════════════════════════════════════════════════════════
⚠️ No positions to manage - you MUST select LONG or SHORT for a new trade.
`;
    }

    // Build funding analysis section if provided
    let fundingSection = '';
    if (fundingAnalysis && Array.isArray(fundingAnalysis) && fundingAnalysis.length > 0) {
        const fundingLines: string[] = ['\nFUNDING RATE ANALYSIS (Critical for futures trading):'];
        for (const coin of fundingAnalysis) {
            // Validate each coin entry
            if (!coin || typeof coin.symbol !== 'string' || !Number.isFinite(coin.fundingRate)) {
                continue;
            }
            const fundingPercent = safeNumber(coin.fundingRate * 100, 4);
            // OPTIMIZED: Use cleanSymbol helper for single-pass cleaning
            const cleanSym = cleanSymbol(coin.symbol);
            const signal = coin.fundingDirection === 'bullish' ? '🟢 BULLISH' :
                coin.fundingDirection === 'bearish' ? '🔴 BEARISH' : '⚪ NEUTRAL';
            fundingLines.push(`  ${cleanSym}: ${fundingPercent}% (${signal})`);
        }
        // Only add section if we have valid entries (more than just the header)
        if (fundingLines.length > 1) {
            fundingLines.push('NOTE: Negative funding = shorts pay longs (bullish). Positive = longs pay shorts (bearish).');
            fundingSection = fundingLines.join('\n');
        }
    }

    // Add critical trading rules summary
    const rulesSection = getCriticalRulesSummary();

    return `${ctx.title}
${portfolioSection}
${marketSummary}${fundingSection}

${rulesSection}

TASK: Select TOP 3 opportunities. Each can be:
• NEW TRADE: "LONG" or "SHORT" on a coin
• MANAGE POSITION: "MANAGE" an existing position (close/reduce/adjust)

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

DATA CHECKLIST:
- Price, % change vs BTC, and 24h volume
- At least one microstructure metric (funding, OI, liquidations)
- For MANAGE picks: cite P&L %, hold time, or changed conditions
- Regime note (trend/chop) and any near-term catalyst
 
RESPONSE FORMAT:
- symbol: Exact WEEX symbol (e.g., "cmt_btcusdt")
- action: "LONG" | "SHORT" | "MANAGE"
- conviction: 1–10 (be honest; low-conviction picks hurt score)
- reason: ONE sentence with specific numbers

COMMON MISTAKES:
- Ignoring existing positions that need attention
- Adding correlated positions without managing existing exposure
- Vague statements without numbers`;
}

/**
 * Build context for Championship Debate (Stage 3)
 * 
 * All 8 analysts compete in championship debates.
 * Winner's thesis gets executed as a real trade.
 * 
 * @param displaySymbol - Coin symbol (e.g., "SOL")
 * @param priceStr - Formatted current price
 * @param changeStr - Formatted 24h change
 * @param previousWinners - Winners from previous stages with their key arguments
 * @param marketData - Full market data including funding rate, volume, etc.
 * @returns Complete debate context string
 */
export function buildChampionshipContext(
    displaySymbol: string,
    priceStr: string,
    changeStr: string,
    previousWinners: {
        coinSelector: string;
        coinSelectorArgument?: string;
    },
    marketData?: {
        volume24h?: number;
        fundingRate?: number;
        high24h?: number;
        low24h?: number;
        openInterest?: number;
    }
): string {
    const ctx = DEBATE_CONTEXTS.championship;

    // Build market data section
    // Added Number.isFinite checks for high24h/low24h/volume24h/fundingRate
    let marketDataSection = '';
    if (marketData) {
        const parts: string[] = [];
        if (marketData.high24h !== undefined && marketData.low24h !== undefined &&
            Number.isFinite(marketData.high24h) && Number.isFinite(marketData.low24h) &&
            marketData.high24h > 0 && marketData.low24h > 0) {
            parts.push(`24h Range: $${safeNumber(marketData.low24h, 2)} - $${safeNumber(marketData.high24h, 2)}`);
        }
        if (marketData.volume24h !== undefined && Number.isFinite(marketData.volume24h) && marketData.volume24h > 0) {
            parts.push(`24h Volume: $${safeNumber(marketData.volume24h / 1e6, 1)}M`);
        }
        if (marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)) {
            const fundingPercent = safeNumber(marketData.fundingRate * 100, 4);
            const fundingDirection = marketData.fundingRate > 0 ? 'longs pay shorts' : 'shorts pay longs';
            parts.push(`Funding Rate: ${fundingPercent}% (${fundingDirection})`);
        }
        if (marketData.openInterest !== undefined && Number.isFinite(marketData.openInterest) && marketData.openInterest > 0) {
            parts.push(`Open Interest: ${safeNumber(marketData.openInterest / 1e6, 1)}M`);
        }
        if (parts.length > 0) {
            marketDataSection = `\n${parts.join('\n')}`;
        }
    }

    // Build previous winners section - only Stage 2 (Coin Selection) is relevant now
    let winnersSection = `Previous Stage Winner:
- Stage 2 (Coin Selection): ${previousWinners.coinSelector || 'Unknown'}`;
    if (previousWinners.coinSelectorArgument && typeof previousWinners.coinSelectorArgument === 'string' && previousWinners.coinSelectorArgument.trim().length > 0) {
        const arg = previousWinners.coinSelectorArgument.trim();
        winnersSection += `\n  Key argument: "${arg.slice(0, 200)}${arg.length > 200 ? '...' : ''}"`;
    }

    return `${ctx.title}

Coin: ${displaySymbol}/USDT
Current Price: ${priceStr}
24h Change: ${changeStr}${marketDataSection}

${winnersSection}

${formatTradingRulesForAI()}

TASK: ${ctx.task}

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

INTEGRATION CHECKLIST:
- Tie new evidence directly to Stage 2 coin selection rationale
- Quantify improvements to risk/reward or probability
- Specify execution triggers (time/price/flow) and invalidation
- Provide one integrated thesis paragraph plus final parameters
 - Catalyst taxonomy examples: token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes; prefer near-term catalysts (7–14 days)
 
 RESPONSE FORMAT:
 - Thesis refinement (1–2 sentences referencing coin selection rationale)
 - New evidence or counter-evidence (2–3 sentences with numbers)
 - Final parameters: entry, targets, stop-loss
 - Catalyst and timeline (1 sentence), conviction level
 
 COMMON MISTAKES:
 - Restarting selection; ignoring coin selection rationale
 - Adding unrelated new arguments without integration
 - Missing parameters or catalyst timing`;
}

/**
 * Build prompt for a single debate turn
 * 
 * TOKEN OPTIMIZATION: This function does NOT include the full analyst system prompt
 * to save tokens. Instead, it relies on:
 * 1. The debate context (market data, previous winners, trading rules)
 * 2. The analyst's methodology name for self-identification
 * 3. Previous debate arguments for engagement
 * 
 * This saves ~800 lines × 4-8 analysts × turns = massive token reduction.
 * 
 * FIXES APPLIED:
 * - Added echo chamber prevention for later turns
 * - Added stop-loss diversity tracking
 * - Added explicit direction requirement
 * - Added self-assessment calibration
 * 
 * @param analystName - Name of the analyst
 * @param analystMethodology - Analyst's methodology key
 * @param previousArguments - Previous debate arguments (formatted)
 * @param turnNumber - Current turn number
 * @param totalTurns - Total turns in debate
 * @returns Prompt for generating this turn
 */
export function buildDebateTurnPrompt(
    analystName: string,
    analystMethodology: string,
    previousArguments: string,
    turnNumber: number,
    totalTurns: number,
    stage: 2 | 3 | 4 | 5,
    allPreviousTurns?: Array<{
        analystName: string;
        argument: string;
        direction?: 'LONG' | 'SHORT';
        stopLoss?: number;
        keyPoint?: string;
    }>
): string {
    // Determine turn type based on position in debate
    let turnType: string;
    const openingCutoff = Math.ceil(totalTurns / 3);
    const closingStart = totalTurns - Math.ceil(totalTurns / 3) + 1;

    if (turnNumber <= openingCutoff) {
        turnType = DEBATE_TURN_INSTRUCTIONS.opening;
    } else if (turnNumber >= closingStart) {
        turnType = DEBATE_TURN_INSTRUCTIONS.closing;
    } else {
        turnType = DEBATE_TURN_INSTRUCTIONS.rebuttal;
    }

    const hasPreviousArgs = previousArguments && previousArguments.trim().length > 0;

    // Build summary of earlier turns (beyond the last 3)
    let earlierTurnsSummary = '';
    if (allPreviousTurns && allPreviousTurns.length > 3) {
        // Filter out any null/undefined entries
        const validTurns = allPreviousTurns.filter(t => t && t.analystName);
        if (validTurns.length > 3) {
            const earlierTurns = validTurns.slice(0, -3);
            const directionCounts: Record<string, number> = { LONG: 0, SHORT: 0 };
            const stopLosses: number[] = [];
            const keyPointsByAnalyst: Record<string, string[]> = {};

            for (const turn of earlierTurns) {
                if (turn.direction) {
                    directionCounts[turn.direction]++;
                }
                if (turn.stopLoss && Number.isFinite(turn.stopLoss) && turn.stopLoss > 0) {
                    stopLosses.push(turn.stopLoss);
                }
                if (turn.keyPoint && turn.keyPoint.trim().length > 0) {
                    if (!keyPointsByAnalyst[turn.analystName]) {
                        keyPointsByAnalyst[turn.analystName] = [];
                    }
                    keyPointsByAnalyst[turn.analystName].push(turn.keyPoint);
                }
            }

            const summaryParts: string[] = [];
            summaryParts.push(`SUMMARY OF EARLIER TURNS (${earlierTurns.length} turns before the last 3):`);

            const totalDirections = directionCounts.LONG + directionCounts.SHORT;
            if (totalDirections > 0) {
                summaryParts.push(`- Direction consensus: ${directionCounts.LONG} LONG vs ${directionCounts.SHORT} SHORT`);
            }

            // FIXED: Check array length before Math.min/max
            if (stopLosses.length > 0) {
                const minSL = Math.min(...stopLosses);
                const maxSL = Math.max(...stopLosses);
                if (Number.isFinite(minSL) && Number.isFinite(maxSL)) {
                    summaryParts.push(`- Stop-loss range mentioned: ${minSL.toFixed(2)} - ${maxSL.toFixed(2)}`);
                }
            }

            // FIXED: Only add "Key arguments made:" if there are actual arguments
            const analystSummaries: string[] = [];
            for (const [analyst, points] of Object.entries(keyPointsByAnalyst)) {
                if (points.length > 0 && points[0]) {
                    const point = points[0].trim();
                    if (point.length > 0) {
                        analystSummaries.push(`  - ${analyst}: "${point.slice(0, 100)}${point.length > 100 ? '...' : ''}"`);
                    }
                }
            }
            if (analystSummaries.length > 0) {
                summaryParts.push(`- Key arguments made:`);
                summaryParts.push(...analystSummaries);
            }

            // Only add summary if we have meaningful content beyond the header
            if (summaryParts.length > 1) {
                earlierTurnsSummary = summaryParts.join('\n') + '\n\n';
            }
        }
    }

    // Analyze previous arguments for echo chamber detection
    let echoWarning = '';
    let stopLossWarning = '';

    if (hasPreviousArgs) {
        // Count LONG vs SHORT recommendations in previous arguments
        // Use more specific patterns to avoid false positives from phrases like "as long as" or "short-term"
        // Match: "recommend LONG", "I recommend LONG", "go LONG", "position: LONG", "LONG position"
        const longPatterns = [
            /\brecommend\s+LONG\b/gi,
            /\bgo\s+LONG\b/gi,
            /\bposition[:\s]+LONG\b/gi,
            /\bLONG\s+position\b/gi,
            /\bLONG\s+(?:on|for)\b/gi,
            /\bopen(?:ing)?\s+(?:a\s+)?LONG\b/gi
        ];
        const shortPatterns = [
            /\brecommend\s+SHORT\b/gi,
            /\bgo\s+SHORT\b/gi,
            /\bposition[:\s]+SHORT\b/gi,
            /\bSHORT\s+position\b/gi,
            /\bSHORT\s+(?:on|for)\b/gi,
            /\bopen(?:ing)?\s+(?:a\s+)?SHORT\b/gi
        ];

        let longCount = 0;
        let shortCount = 0;
        for (const pattern of longPatterns) {
            longCount += (previousArguments.match(pattern) || []).length;
        }
        for (const pattern of shortPatterns) {
            shortCount += (previousArguments.match(pattern) || []).length;
        }
        const totalRecs = longCount + shortCount;

        if (totalRecs >= 3) {
            const dominantDirection = longCount > shortCount ? 'LONG' : 'SHORT';
            const dominantPercent = Math.round((Math.max(longCount, shortCount) / totalRecs) * 100);

            if (dominantPercent >= 75) {
                echoWarning = `
⚠️ ECHO CHAMBER WARNING: ${dominantPercent}% of previous arguments favor ${dominantDirection}.
- If you AGREE with the majority, you MUST provide UNIQUE data points not yet mentioned
- If you DISAGREE, this is your chance to present a contrarian view with strong evidence
- The market rarely rewards consensus - consider what the majority might be missing
- Your methodology may reveal risks or opportunities others have overlooked
`;
            }
        }

        // Detect stop-loss clustering with more flexible patterns
        // Match: "stop-loss: $76.50", "stop loss at 76.50", "SL: 76.50", "stop at $76", "stops around 76"
        const stopLossPatterns = [
            /stop[- ]?loss[:\s]+\$?([\d,.]+)/gi,
            /\bSL[:\s]+\$?([\d,.]+)/gi,
            /stop(?:s)?\s+(?:at|around|near)\s+\$?([\d,.]+)/gi,
            /invalidation\s+(?:at|around|below|above)\s+\$?([\d,.]+)/gi
        ];

        const stopLossValues: number[] = [];
        for (const pattern of stopLossPatterns) {
            let match;
            // Reset lastIndex for global regex
            pattern.lastIndex = 0;
            while ((match = pattern.exec(previousArguments)) !== null) {
                const value = parseFloat(match[1].replace(/,/g, ''));
                if (Number.isFinite(value) && value > 0) {
                    stopLossValues.push(value);
                }
            }
        }

        // Check for clustering only in stages where stop-loss is relevant (4 and 5)
        if ((stage === 4 || stage === 5) && stopLossValues.length >= 2) {
            const sortedStops = [...stopLossValues].sort((a, b) => a - b);
            const minStop = sortedStops[0];
            const maxStop = sortedStops[sortedStops.length - 1];
            const avgStop = sortedStops.reduce((a, b) => a + b, 0) / sortedStops.length;
            const range = maxStop - minStop;
            const rangePercent = avgStop > 0 ? (range / avgStop) * 100 : 0;

            if (rangePercent < 5) { // Stops clustered within 5%
                stopLossWarning = `
⚠️ STOP-LOSS CLUSTERING DETECTED: ${stopLossValues.length} analysts have stops within ${rangePercent.toFixed(1)}% range ($${minStop.toFixed(2)} - $${maxStop.toFixed(2)}).
- Clustered stops are VULNERABLE to liquidity hunts by market makers
- Use YOUR methodology to calculate a DIFFERENTIATED stop-loss level
- Consider: ATR-based, structure-based, or volatility-adjusted stops
- If you place your stop at the same level as others, JUSTIFY why it's still correct
`;
            }
        }
    }

    // Select stage-specific general instructions
    // OPTIMIZED: Only stage2 (Coin Selection) and stage3 (Championship) remain
    // Stage 4 (Risk Council) uses stage3 instructions
    // Stage 5 parameter is used for position management (MANAGE action flow)
    let generalInstructions: string;
    switch (stage) {
        case 2:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage2;
            break;
        case 3:
        case 4:
        case 5:
            // Championship, Risk Council, and Position Management all use stage3 instructions
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage3;
            break;
        default:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage2;
    }

    return `You are ${analystName}, an elite crypto analyst specializing in ${analystMethodology} methodology.

YOUR METHODOLOGY: ${analystMethodology.toUpperCase()}
You must apply your specific analytical framework, scorecards, and evaluation criteria.
Your unique edge comes from your methodology - use it to differentiate your argument.
${echoWarning}${stopLossWarning}
${earlierTurnsSummary}${hasPreviousArgs ? `═══════════════════════════════════════════════════════════════
PREVIOUS ARGUMENTS IN THIS DEBATE (you MUST engage with these):
═══════════════════════════════════════════════════════════════
${previousArguments}

` : ''}═══════════════════════════════════════════════════════════════
YOUR TURN: ${turnNumber} of ${totalTurns}
═══════════════════════════════════════════════════════════════
${turnType}

${generalInstructions}
Word Limit:
- 150–200 words; judges penalize under 120 or over 200
Response Format:
- Opening (1 sentence with a specific number)
- Main (2–3 sentences; 3–4 metrics)
- Engagement (quote and address one prior claim)
- Close (1 sentence on why your view wins)
Quality Checklist:
- Use exact numbers and stage-appropriate metrics
- Directly engage prior arguments; avoid repetition
- Declare horizon; include one cross-check where relevant`;
}
