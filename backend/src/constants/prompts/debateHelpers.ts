/**
 * Debate Context Builder Helpers
 * 
 * Functions to build debate context strings from templates.
 * These replace hardcoded strings in CollaborativeFlow.ts
 */

import { DEBATE_CONTEXTS, DEBATE_TURN_INSTRUCTIONS } from './debateContexts';
import { config } from '../../config';
import { safeNumber } from './promptHelpers';

/**
 * Build context for Coin Selection Debate (Stage 2)
 * 
 * ENHANCED: Now includes funding rate analysis per coin
 * 
 * @param marketSummary - Formatted market data for all 8 coins
 * @param fundingAnalysis - Optional funding rate analysis for each coin
 * @returns Complete debate context string
 */
export function buildCoinSelectionContext(
    marketSummary: string,
    fundingAnalysis?: Array<{
        symbol: string;
        fundingRate: number;
        fundingDirection: 'bullish' | 'bearish' | 'neutral';
    }>
): string {
    const ctx = DEBATE_CONTEXTS.coinSelection;

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
            const signal = coin.fundingDirection === 'bullish' ? '🟢 BULLISH' :
                coin.fundingDirection === 'bearish' ? '🔴 BEARISH' : '⚪ NEUTRAL';
            fundingLines.push(`  ${coin.symbol}: ${fundingPercent}% (${signal})`);
        }
        // Only add section if we have valid entries (more than just the header)
        if (fundingLines.length > 1) {
            fundingLines.push('NOTE: Negative funding = shorts pay longs (bullish). Positive = longs pay shorts (bearish).');
            fundingSection = fundingLines.join('\n');
        }
    }

    return `${ctx.title}

${marketSummary}${fundingSection}

TASK: ${ctx.task}

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

DATA CHECKLIST:
- Price, % change vs BTC, and 24h volume
- At least one microstructure metric (funding, OI, liquidations)
- Regime note (trend/chop) and any near-term catalyst
- Crowding awareness if funding/OI are extreme
 - Catalyst taxonomy examples: token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes; prefer near-term catalysts (7–14 days) with dates/timelines
 
 RESPONSE FORMAT:
 - symbol: Exact WEEX symbol (e.g., "cmt_btcusdt")
 - direction: "LONG" or "SHORT"
 - conviction: 1–10 (be honest; low-conviction picks hurt score)
 - reason: ONE sentence with specific numbers from your methodology
 
 COMMON MISTAKES:
 - Vague statements without numbers, ignoring crowding or regime
 - Selecting multiple highly correlated picks without diversification
 - Overweighting price alone; missing volume/structure/funding`;
}

/**
 * Build context for Analysis Approach Debate (Stage 3)
 * 
 * Includes full market data (funding rate, volume, 24h range)
 * 
 * @param displaySymbol - Coin symbol (e.g., "SOL")
 * @param direction - Trade direction (LONG or SHORT)
 * @param priceStr - Formatted current price
 * @param changeStr - Formatted 24h change
 * @param marketData - Full market data including funding rate, volume, etc.
 * @returns Complete debate context string
 */
export function buildAnalysisApproachContext(
    displaySymbol: string,
    direction: 'LONG' | 'SHORT',
    priceStr: string,
    changeStr: string,
    marketData?: {
        volume24h?: number;
        fundingRate?: number;
        high24h?: number;
        low24h?: number;
    }
): string {
    const ctx = DEBATE_CONTEXTS.analysisApproach;

    // Build market data section
    // Added Number.isFinite checks for all numeric values
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
        if (parts.length > 0) {
            marketDataSection = `\n${parts.join('\n')}`;
        }
    }

    return `${ctx.title}

Coin: ${displaySymbol}/USDT
Selected Direction: ${direction}
Current Price: ${priceStr}
24h Change: ${changeStr}${marketDataSection}

TASK: ${ctx.task}

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

FRAMEWORK REQUIREMENTS:
- Method-specific metrics and techniques applied to this coin/direction
- Time horizon declared and risk/reward assessed over that horizon
- One cross-check from another methodology to avoid overfitting
- Expected insight types explained and tied to thesis improvement
 - Debate rather than repeat—quote a prior claim and bring NEW evidence or analysis
 
 RESPONSE FORMAT:
 - Methodology statement (1 sentence)
 - Metrics/techniques (2–3 sentences; method-specific)
 - Engagement (address one prior argument explicitly)
 - Cross-check (1 sentence from another lens)
 - Closing (1 sentence on added edge)
 
 COMMON MISTAKES:
 - Recommending trades or restarting thesis
 - Repeating generic metrics; no falsifiable claim or horizon`;
}

/**
 * Build context for Risk Assessment Debate (Stage 4)
 * 
 * ENHANCED: Now includes full market data for risk assessment
 * 
 * @param displaySymbol - Coin symbol (e.g., "SOL")
 * @param proposedThesis - The winning thesis from Stage 3
 * @param priceStr - Formatted current price
 * @param priceTargets - Formatted price targets
 * @param marketData - Full market data including funding rate, volume, volatility
 * @returns Complete debate context string
 */
export function buildRiskAssessmentContext(
    displaySymbol: string,
    proposedThesis: {
        analystName: string;
        positionSize: number;
        riskLevel: string;
        direction?: 'LONG' | 'SHORT';
    },
    priceStr: string,
    priceTargets: { bull: string; base: string; bear: string },
    marketData?: {
        volume24h?: number;
        fundingRate?: number;
        high24h?: number;
        low24h?: number;
        change24h?: number;
    }
): string {
    const ctx = DEBATE_CONTEXTS.riskAssessment;

    // Build market data section for risk assessment
    let marketDataSection = '';
    if (marketData) {
        const parts: string[] = [];
        // FIXED: Added Number.isFinite checks for all numeric values
        if (marketData.change24h !== undefined && Number.isFinite(marketData.change24h)) {
            const changeStr = marketData.change24h >= 0 ? `+${safeNumber(marketData.change24h, 2)}%` : `${safeNumber(marketData.change24h, 2)}%`;
            parts.push(`24h Change: ${changeStr}`);
        }
        if (marketData.high24h !== undefined && marketData.low24h !== undefined &&
            Number.isFinite(marketData.high24h) && Number.isFinite(marketData.low24h) && marketData.low24h > 0) {
            const range = marketData.high24h - marketData.low24h;
            const rangePercent = (range / marketData.low24h) * 100;
            if (Number.isFinite(rangePercent)) {
                parts.push(`24h Range: ${safeNumber(marketData.low24h, 2)} - ${safeNumber(marketData.high24h, 2)} (${safeNumber(rangePercent, 1)}% volatility)`);
            }
        }
        if (marketData.volume24h !== undefined && Number.isFinite(marketData.volume24h) && marketData.volume24h > 0) {
            parts.push(`24h Volume: ${safeNumber(marketData.volume24h / 1e6, 1)}M`);
        }
        if (marketData.fundingRate !== undefined && Number.isFinite(marketData.fundingRate)) {
            const fundingPercent = safeNumber(marketData.fundingRate * 100, 4);
            const fundingDirection = marketData.fundingRate > 0 ? 'longs pay shorts' : 'shorts pay longs';
            parts.push(`Funding Rate: ${fundingPercent}% (${fundingDirection})`);
            const autonomousCfg = (config && (config as any).autonomous) ? (config as any).autonomous : {};
            const thresholdPct = Number.isFinite(autonomousCfg?.fundingWarnThresholdPercent)
                ? autonomousCfg.fundingWarnThresholdPercent
                : 0.01;
            const threshold = Number.isFinite(thresholdPct) ? (thresholdPct / 100) : 0;
            if (proposedThesis.direction) {
                if ((proposedThesis.direction === 'LONG' && marketData.fundingRate > threshold) ||
                    (proposedThesis.direction === 'SHORT' && marketData.fundingRate < -threshold)) {
                    parts.push(`⚠️ RISK: Funding rate is AGAINST the proposed ${proposedThesis.direction} position!`);
                }
            }
        }
        if (parts.length > 0) {
            marketDataSection = `\n${parts.join('\n')}\n`;
        }
    }

    return `${ctx.title}

Coin: ${displaySymbol}/USDT
Current Price: ${priceStr}${marketDataSection}
Proposed Thesis by ${proposedThesis.analystName}:
- Direction: ${proposedThesis.direction || 'Not specified'}
- Targets: Bull ${priceTargets.bull}, Base ${priceTargets.base}, Bear ${priceTargets.bear}
- Position Size: ${safeNumber(proposedThesis.positionSize, 0)}/10
- Risk Level: ${proposedThesis.riskLevel}

TASK: ${ctx.task}

${(() => {
            const autonomous = (config && (config as any).autonomous) ? (config as any).autonomous : {};
            const maxPositionSizePercent = Number.isFinite(autonomous?.maxPositionSizePercent) ? autonomous.maxPositionSizePercent : 10;
            const maxLeverage = Number.isFinite(autonomous?.maxLeverage) ? autonomous.maxLeverage : 5;
            const stopLossPercent = Number.isFinite(autonomous?.stopLossPercent) ? autonomous.stopLossPercent : 10;
            return `HARD RULES: Max position ${safeNumber(maxPositionSizePercent, 0)}%, Max leverage ${safeNumber(maxLeverage, 0)}x, Max stop loss ${safeNumber(stopLossPercent, 0)}% from entry`;
        })()}

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

DATA CHECKLIST:
- Volatility/range metrics supporting stop placement
- Funding/OI crowding and adverse-move scenarios
- Distances (%) to stop and targets to quantify risk/reward
 - Consider catalyst timing risk when relevant (unlock schedules, listings, mainnet/testnet launches, governance votes)

OUTPUT FORMAT:
- Position size (1–10), leverage (1–5x), stop-loss level
- Invalidation triggers and scenario notes
 
 COMMON MISTAKES:
 - Platitudes without numbers; violating max leverage/stop rules
 - Ignoring crowding or adverse-move scenarios
 - Not linking invalidation to Stage 3 thesis`;
}

/**
 * Build context for Championship Debate (Stage 5)
 * 
 * ENHANCED: Now includes full market data and previous winners' key arguments
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
        analysisApproach: string;
        riskAssessment: string;
        coinSelectorArgument?: string;
        analysisApproachArgument?: string;
        riskAssessmentArgument?: string;
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

    // Build previous winners section with their key arguments
    // FIXED: Added null/undefined checks for arguments
    let winnersSection = `Previous Winners:
- Stage 2 (Coin Selection): ${previousWinners.coinSelector || 'Unknown'}`;
    if (previousWinners.coinSelectorArgument && typeof previousWinners.coinSelectorArgument === 'string' && previousWinners.coinSelectorArgument.trim().length > 0) {
        const arg = previousWinners.coinSelectorArgument.trim();
        winnersSection += `\n  Key argument: "${arg.slice(0, 200)}${arg.length > 200 ? '...' : ''}"`;
    }
    winnersSection += `\n- Stage 3 (Analysis Approach): ${previousWinners.analysisApproach || 'Unknown'}`;
    if (previousWinners.analysisApproachArgument && typeof previousWinners.analysisApproachArgument === 'string' && previousWinners.analysisApproachArgument.trim().length > 0) {
        const arg = previousWinners.analysisApproachArgument.trim();
        winnersSection += `\n  Key argument: "${arg.slice(0, 200)}${arg.length > 200 ? '...' : ''}"`;
    }
    winnersSection += `\n- Stage 4 (Risk Assessment): ${previousWinners.riskAssessment || 'Unknown'}`;
    if (previousWinners.riskAssessmentArgument && typeof previousWinners.riskAssessmentArgument === 'string' && previousWinners.riskAssessmentArgument.trim().length > 0) {
        const arg = previousWinners.riskAssessmentArgument.trim();
        winnersSection += `\n  Key argument: "${arg.slice(0, 200)}${arg.length > 200 ? '...' : ''}"`;
    }

    return `${ctx.title}

Coin: ${displaySymbol}/USDT
Current Price: ${priceStr}
24h Change: ${changeStr}${marketDataSection}

${winnersSection}

TASK: ${ctx.task}

JUDGING: ${ctx.judging}

WORD LIMIT:
- 150–200 words; under 120 too thin; >200 penalized

INTEGRATION CHECKLIST:
- Tie new evidence directly to prior-stage winner arguments
- Quantify improvements to risk/reward or probability
- Specify execution triggers (time/price/flow) and invalidation
- Provide one integrated thesis paragraph plus final parameters
 - Catalyst taxonomy examples: token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes; prefer near-term catalysts (7–14 days)
 
 RESPONSE FORMAT:
 - Thesis refinement (1–2 sentences referencing prior winners)
 - New evidence or counter-evidence (2–3 sentences with numbers)
 - Final parameters: entry, targets, stop-loss
 - Catalyst and timeline (1 sentence), conviction level
 
 COMMON MISTAKES:
 - Restarting selection; ignoring prior winners
 - Adding unrelated new arguments without integration
 - Missing parameters or catalyst timing`;
}

/**
 * Build prompt for a single debate turn
 * 
 * IMPORTANT: This now includes the FULL analyst system prompt (800+ lines)
 * to ensure the AI uses the complete methodology, not just a brief description.
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
    let generalInstructions: string;
    switch (stage) {
        case 2:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage2;
            break;
        case 3:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage3;
            break;
        case 4:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage4;
            break;
        case 5:
            generalInstructions = DEBATE_TURN_INSTRUCTIONS.general.stage5;
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
