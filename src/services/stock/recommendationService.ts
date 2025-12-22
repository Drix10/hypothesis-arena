/**
 * Recommendation Service - ENHANCED
 * 
 * Synthesizes all analyst theses and debate results into a final
 * investment recommendation with confidence intervals and risk assessment.
 */

import {
    InvestmentThesis,
    FinalRecommendation,
    StockAnalysisData,
    PriceTarget
} from '../../types/stock';
import { TournamentResult } from './stockTournamentService';
import { calculateConsensus, getAnalystById } from './analystService';

// ═══════════════════════════════════════════════════════════════════════════════
// RECOMMENDATION GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate final recommendation from tournament results
 */
export function generateFinalRecommendation(
    stockData: StockAnalysisData,
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult
): FinalRecommendation {
    const consensus = calculateConsensus(theses);
    const currentPrice = stockData.quote?.price ?? 0;

    const priceTarget = calculateWeightedPriceTarget(theses, tournamentResult, currentPrice);

    const upside = currentPrice > 0
        ? ((priceTarget.base - currentPrice) / currentPrice) * 100
        : 0;

    const recommendation = determineRecommendation(consensus, tournamentResult.champion, upside);
    const confidence = calculateConfidence(theses, tournamentResult);
    const consensusStrength = calculateConsensusStrength(theses);
    const riskLevel = assessRiskLevel(stockData, theses);
    const suggestedAllocation = calculateSuggestedAllocation(confidence, riskLevel, consensusStrength);
    const { topBullArguments, topBearArguments } = extractTopArguments(theses, tournamentResult);
    const keyRisks = extractKeyRisks(theses);
    const keyCatalysts = extractKeyCatalysts(theses);
    const dissentingViews = findDissentingViews(theses, recommendation);

    const executiveSummary = generateExecutiveSummary(
        stockData, recommendation, confidence, priceTarget,
        upside, tournamentResult.champion, riskLevel, consensusStrength
    );

    return {
        ticker: stockData.ticker,
        generatedAt: Date.now(),
        recommendation,
        confidence,
        consensusStrength,
        priceTarget,
        currentPrice,
        upside,
        suggestedAllocation,
        riskLevel,
        topBullArguments,
        topBearArguments,
        keyRisks,
        keyCatalysts,
        dissentingViews,
        executiveSummary,
        analystsContributed: theses.length,
        debatesCompleted: tournamentResult.allDebates.length,
        dataSourcesUsed: getDataSourcesUsed(stockData)
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateWeightedPriceTarget(
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult,
    currentPrice: number = 0
): PriceTarget {
    const safePrice = currentPrice > 0 ? currentPrice : 100;

    if (theses.length === 0) {
        return { bull: safePrice * 1.2, base: safePrice, bear: safePrice * 0.8, timeframe: '1Y' };
    }

    let totalWeight = 0;
    let bullSum = 0, baseSum = 0, bearSum = 0;

    for (const thesis of theses) {
        // Skip theses with invalid price targets
        if (!thesis.priceTarget || !Number.isFinite(thesis.priceTarget.base)) {
            continue;
        }

        let weight = Math.max(thesis.confidence, 1) / 100;

        if (tournamentResult.champion?.agentId === thesis.agentId) {
            weight *= 1.5;
        }

        const debateWins = tournamentResult.allDebates.filter(d =>
            (d.winner === 'bull' && d.bullThesis.agentId === thesis.agentId) ||
            (d.winner === 'bear' && d.bearThesis.agentId === thesis.agentId)
        ).length;
        weight *= (1 + debateWins * 0.1);

        totalWeight += weight;
        bullSum += (thesis.priceTarget.bull ?? safePrice * 1.2) * weight;
        baseSum += (thesis.priceTarget.base ?? safePrice) * weight;
        bearSum += (thesis.priceTarget.bear ?? safePrice * 0.8) * weight;
    }

    // Fallback if no valid theses contributed
    if (totalWeight <= 0) {
        return { bull: safePrice * 1.2, base: safePrice, bear: safePrice * 0.8, timeframe: '1Y' };
    }

    return {
        bull: bullSum / totalWeight,
        base: baseSum / totalWeight,
        bear: bearSum / totalWeight,
        timeframe: '1Y'
    };
}

function determineRecommendation(
    consensus: ReturnType<typeof calculateConsensus>,
    champion: InvestmentThesis | null,
    upside: number
): FinalRecommendation['recommendation'] {
    let rec = consensus.consensusRecommendation;

    // Upside-based adjustments
    if (upside > 30 && rec === 'hold') rec = 'buy';
    if (upside > 50 && rec === 'buy') rec = 'strong_buy';
    if (upside < -20 && rec === 'hold') rec = 'sell';
    if (upside < -30 && rec === 'sell') rec = 'strong_sell';

    // Champion influence - the tournament winner should have significant weight
    if (champion) {
        const champRec = champion.recommendation;
        const champConfidence = champion.confidence;

        // If champion strongly disagrees with consensus, move toward neutral
        if (
            (champRec === 'strong_sell' && (rec === 'buy' || rec === 'strong_buy')) ||
            (champRec === 'strong_buy' && (rec === 'sell' || rec === 'strong_sell'))
        ) {
            rec = 'hold';
        }

        // Champion with high confidence can upgrade recommendations
        if (champConfidence > 75) {
            if (champRec === 'strong_buy' && rec === 'buy') rec = 'strong_buy';
            if (champRec === 'strong_sell' && rec === 'sell') rec = 'strong_sell';
        }

        // NEW: Champion should influence HOLD consensus toward their direction
        // If consensus is HOLD but champion has a directional view with decent confidence,
        // the final recommendation should lean toward the champion's view
        if (rec === 'hold' && champConfidence >= 60) {
            if (champRec === 'strong_buy' || champRec === 'buy') {
                // Champion is bullish - move from HOLD toward BUY
                rec = 'buy';
            } else if (champRec === 'strong_sell' || champRec === 'sell') {
                // Champion is bearish - move from HOLD toward SELL
                rec = 'sell';
            }
        }

        // If champion has very high confidence (>80%), they can override moderate consensus
        if (champConfidence > 80) {
            if (champRec === 'strong_buy' && rec !== 'sell' && rec !== 'strong_sell') {
                rec = 'strong_buy';
            } else if (champRec === 'strong_sell' && rec !== 'buy' && rec !== 'strong_buy') {
                rec = 'strong_sell';
            }
        }
    }

    return rec;
}

function calculateConfidence(theses: InvestmentThesis[], tournamentResult: TournamentResult): number {
    if (theses.length === 0) return 0;

    const avgConfidence = theses.reduce((sum, t) => sum + t.confidence, 0) / theses.length;

    const { bullCount, bearCount, holdCount } = calculateConsensus(theses);
    const maxCount = Math.max(bullCount, bearCount, holdCount, 1);
    const consensusBonus = (maxCount / Math.max(theses.length, 1)) * 20;

    let debateClarity = 0;
    for (const debate of tournamentResult.allDebates) {
        const scoreDiff = Math.abs(debate.scores.bullScore - debate.scores.bearScore);
        debateClarity += Math.min(scoreDiff / 20, 1);
    }
    const debateBonus = tournamentResult.allDebates.length > 0
        ? (debateClarity / tournamentResult.allDebates.length) * 10
        : 0;

    return Math.min(100, Math.max(0, avgConfidence + consensusBonus + debateBonus));
}

function calculateConsensusStrength(theses: InvestmentThesis[]): number {
    if (theses.length === 0) return 0;
    const { bullCount, bearCount, holdCount } = calculateConsensus(theses);
    const maxCount = Math.max(bullCount, bearCount, holdCount, 1);
    return Math.round((maxCount / Math.max(theses.length, 1)) * 100);
}


function assessRiskLevel(
    stockData: StockAnalysisData,
    theses: InvestmentThesis[]
): FinalRecommendation['riskLevel'] {
    let riskScore = 0;

    const volatility = stockData.technicals?.volatility ?? 0;
    if (volatility > 50) riskScore += 3;
    else if (volatility > 30) riskScore += 2;
    else if (volatility > 20) riskScore += 1;

    const debtToEquity = stockData.fundamentals?.debtToEquity;
    if (debtToEquity !== null && debtToEquity !== undefined) {
        if (debtToEquity > 2) riskScore += 2;
        else if (debtToEquity > 1) riskScore += 1;
    }

    const sentimentScore = Math.abs(stockData.sentiment?.overallScore ?? 0);
    if (sentimentScore > 0.7) riskScore += 1;

    const { bullCount, bearCount } = calculateConsensus(theses);
    if (Math.abs(bullCount - bearCount) <= 1 && theses.length > 4) {
        riskScore += 1;
    }

    const pe = stockData.fundamentals?.peRatio;
    if (pe !== null && pe !== undefined) {
        if (pe < 0) riskScore += 2;
        else if (pe > 50) riskScore += 1;
    }

    const rsi = stockData.technicals?.rsi14 ?? 50;
    if (rsi < 20 || rsi > 80) riskScore += 1;

    if (riskScore >= 6) return 'very_high';
    if (riskScore >= 4) return 'high';
    if (riskScore >= 2) return 'medium';
    return 'low';
}

function calculateSuggestedAllocation(
    confidence: number,
    riskLevel: FinalRecommendation['riskLevel'],
    consensusStrength: number
): number {
    let allocation = confidence / 20;

    const riskMultiplier = { low: 1.2, medium: 1.0, high: 0.7, very_high: 0.4 };
    allocation *= riskMultiplier[riskLevel];
    allocation *= (consensusStrength / 100);

    return Math.min(10, Math.max(0, Math.round(allocation * 10) / 10));
}

function extractTopArguments(
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult
): { topBullArguments: string[]; topBearArguments: string[] } {
    const bullArgs: string[] = [];
    const bearArgs: string[] = [];

    if (tournamentResult.champion) {
        const champBullCase = tournamentResult.champion.bullCase ?? [];
        const champBearCase = tournamentResult.champion.bearCase ?? [];
        bullArgs.push(...champBullCase.filter(Boolean).slice(0, 2));
        bearArgs.push(...champBearCase.filter(Boolean).slice(0, 2));
    }

    for (const thesis of theses) {
        if (thesis.agentId === tournamentResult.champion?.agentId) continue;

        // Safe iteration with null checks
        const thesisBullCase = thesis.bullCase ?? [];
        const thesisBearCase = thesis.bearCase ?? [];

        for (const arg of thesisBullCase) {
            if (arg && !bullArgs.includes(arg) && bullArgs.length < 5) {
                bullArgs.push(arg);
            }
        }
        for (const arg of thesisBearCase) {
            if (arg && !bearArgs.includes(arg) && bearArgs.length < 5) {
                bearArgs.push(arg);
            }
        }
    }

    for (const debate of tournamentResult.allDebates) {
        const winningArgs = debate.winningArguments ?? [];
        for (const arg of winningArgs) {
            if (!arg) continue;
            const target = debate.winner === 'bull' ? bullArgs : bearArgs;
            const argPrefix = arg.slice(0, 50);
            if (target.length < 5 && !target.some(a => a && a.includes(argPrefix))) {
                target.push(arg);
            }
        }
    }

    return {
        topBullArguments: bullArgs.slice(0, 5),
        topBearArguments: bearArgs.slice(0, 5)
    };
}

function extractKeyRisks(theses: InvestmentThesis[]): string[] {
    const riskCounts = new Map<string, number>();

    for (const thesis of theses) {
        const risks = thesis.risks ?? [];
        for (const risk of risks) {
            if (!risk || typeof risk !== 'string') continue;
            const normalized = risk.toLowerCase().trim();
            if (normalized.length === 0) continue;
            riskCounts.set(normalized, (riskCounts.get(normalized) || 0) + 1);
        }
    }

    return Array.from(riskCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([risk]) => risk.charAt(0).toUpperCase() + risk.slice(1));
}

function extractKeyCatalysts(theses: InvestmentThesis[]): string[] {
    const catalystCounts = new Map<string, number>();

    for (const thesis of theses) {
        const catalysts = thesis.catalysts ?? [];
        for (const catalyst of catalysts) {
            if (!catalyst || typeof catalyst !== 'string') continue;
            const normalized = catalyst.toLowerCase().trim();
            if (normalized.length === 0) continue;
            catalystCounts.set(normalized, (catalystCounts.get(normalized) || 0) + 1);
        }
    }

    return Array.from(catalystCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([catalyst]) => catalyst.charAt(0).toUpperCase() + catalyst.slice(1));
}

function findDissentingViews(
    theses: InvestmentThesis[],
    finalRec: FinalRecommendation['recommendation']
): FinalRecommendation['dissentingViews'] {
    const dissenting: FinalRecommendation['dissentingViews'] = [];

    const isBullish = finalRec === 'strong_buy' || finalRec === 'buy';
    const isBearish = finalRec === 'strong_sell' || finalRec === 'sell';

    for (const thesis of theses) {
        const thesisBullish = thesis.recommendation === 'strong_buy' || thesis.recommendation === 'buy';
        const thesisBearish = thesis.recommendation === 'strong_sell' || thesis.recommendation === 'sell';

        if ((isBullish && thesisBearish) || (isBearish && thesisBullish)) {
            const analyst = getAnalystById(thesis.agentId);
            if (analyst) {
                // Safe array access for reasoning
                const reasoning = thesis.summary
                    || (thesis.bearCase && thesis.bearCase.length > 0 ? thesis.bearCase[0] : null)
                    || 'Disagrees with consensus';

                dissenting.push({
                    agentName: analyst.name,
                    position: thesis.recommendation.replace('_', ' ').toUpperCase(),
                    reasoning
                });
            }
        }
    }

    return dissenting.slice(0, 3);
}


/**
 * Generate executive summary - ENHANCED
 * More comprehensive summary with key data points and actionable insights
 */
function generateExecutiveSummary(
    stockData: StockAnalysisData,
    recommendation: FinalRecommendation['recommendation'],
    confidence: number,
    priceTarget: PriceTarget,
    upside: number,
    champion: InvestmentThesis | null,
    riskLevel: FinalRecommendation['riskLevel'],
    consensusStrength: number
): string {
    const recText = recommendation.replace('_', ' ').toUpperCase();
    const ticker = stockData.ticker;
    const companyName = stockData.profile?.name || ticker;
    const price = stockData.quote?.price?.toFixed(2) ?? '0.00';
    const targetPrice = priceTarget.base.toFixed(2);

    let summary = `${recText} | ${companyName} (${ticker}) @ $${price}\n\n`;

    summary += `Our multi-analyst framework yields a ${recText} recommendation with ${confidence.toFixed(0)}% confidence. `;

    if (upside >= 0) {
        summary += `We see ${upside.toFixed(1)}% upside to our $${targetPrice} base case target `;
        summary += `(range: $${priceTarget.bear.toFixed(2)} bear to $${priceTarget.bull.toFixed(2)} bull). `;
    } else {
        summary += `Current valuation implies ${Math.abs(upside).toFixed(1)}% downside risk to our $${targetPrice} fair value estimate. `;
    }

    if (consensusStrength >= 75) {
        summary += `Strong analyst consensus (${consensusStrength}%) supports this view. `;
    } else if (consensusStrength <= 50) {
        summary += `Note: Analyst views are divided (${consensusStrength}% consensus), suggesting uncertainty. `;
    }

    if (champion) {
        const analyst = getAnalystById(champion.agentId);
        if (analyst) {
            // Safe array access with fallback chain
            const keyArg = (champion.bullCase && champion.bullCase.length > 0 ? champion.bullCase[0] : null)
                || champion.summary
                || 'key fundamentals';
            const truncatedArg = keyArg.length > 100 ? keyArg.slice(0, 97) + '...' : keyArg;
            summary += `\n\nThe ${analyst.title} perspective prevailed in our debate tournament: "${truncatedArg}"`;
        }
    }

    if (riskLevel === 'high' || riskLevel === 'very_high') {
        summary += `\n\nRisk Alert: This is a ${riskLevel.replace('_', ' ')} risk investment. Position sizing should reflect elevated uncertainty.`;
    }

    const pe = stockData.fundamentals?.peRatio;
    const rsi = stockData.technicals?.rsi14;
    const sentiment = stockData.sentiment?.overallScore;

    const metrics: string[] = [];
    if (pe !== null && pe !== undefined) {
        metrics.push(`P/E: ${pe.toFixed(1)}`);
    }
    if (rsi !== null && rsi !== undefined) {
        const rsiLabel = rsi < 30 ? ' (oversold)' : rsi > 70 ? ' (overbought)' : '';
        metrics.push(`RSI: ${rsi.toFixed(0)}${rsiLabel}`);
    }
    if (sentiment !== null && sentiment !== undefined) {
        const sentLabel = sentiment > 0.2 ? 'bullish' : sentiment < -0.2 ? 'bearish' : 'neutral';
        metrics.push(`Sentiment: ${sentLabel}`);
    }

    if (metrics.length > 0) {
        summary += `\n\nKey Metrics: ${metrics.join(' | ')}`;
    }

    return summary;
}

function getDataSourcesUsed(stockData: StockAnalysisData): string[] {
    const sources: string[] = ['Yahoo Finance'];

    if (stockData.dataQuality?.hasNews) sources.push('News Sentiment');
    if (stockData.dataQuality?.hasTechnicals) sources.push('Technical Analysis');
    if (stockData.dataQuality?.hasAnalystRatings) sources.push('Wall Street Analysts');
    if (stockData.dataQuality?.hasFundamentals) sources.push('Financial Statements');

    return sources;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUICK RECOMMENDATION (Without full tournament)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a quick recommendation from theses without running debates
 */
export function generateQuickRecommendation(
    stockData: StockAnalysisData,
    theses: InvestmentThesis[]
): FinalRecommendation {
    const emptyTournament: TournamentResult = {
        quarterfinals: [],
        semifinals: [],
        final: null,
        champion: theses.length > 0
            ? theses.reduce((best, t) => t.confidence > best.confidence ? t : best)
            : null,
        allDebates: []
    };

    return generateFinalRecommendation(stockData, theses, emptyTournament);
}
