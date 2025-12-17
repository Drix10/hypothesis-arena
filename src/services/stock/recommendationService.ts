/**
 * Recommendation Service
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
    const currentPrice = stockData.quote.price;

    // Calculate weighted price targets (pass current price for fallback)
    const priceTarget = calculateWeightedPriceTarget(theses, tournamentResult, currentPrice);

    // Calculate upside
    const upside = currentPrice > 0
        ? ((priceTarget.base - currentPrice) / currentPrice) * 100
        : 0;

    // Determine final recommendation (weight champion's view more heavily)
    const recommendation = determineRecommendation(
        consensus,
        tournamentResult.champion,
        upside
    );

    // Calculate confidence and consensus strength
    const confidence = calculateConfidence(theses, tournamentResult);
    const consensusStrength = calculateConsensusStrength(theses);

    // Risk assessment
    const riskLevel = assessRiskLevel(stockData, theses);

    // Position sizing suggestion
    const suggestedAllocation = calculateSuggestedAllocation(
        confidence,
        riskLevel,
        consensusStrength
    );

    // Extract key arguments
    const { topBullArguments, topBearArguments } = extractTopArguments(theses, tournamentResult);

    // Key risks and catalysts
    const keyRisks = extractKeyRisks(theses);
    const keyCatalysts = extractKeyCatalysts(theses);

    // Dissenting views
    const dissentingViews = findDissentingViews(theses, recommendation);

    // Executive summary
    const executiveSummary = generateExecutiveSummary(
        stockData,
        recommendation,
        confidence,
        priceTarget,
        upside,
        tournamentResult.champion
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
    // Return sensible defaults based on current price if no theses
    if (theses.length === 0) {
        const safePrice = currentPrice > 0 ? currentPrice : 100;
        return {
            bull: safePrice * 1.2,
            base: safePrice,
            bear: safePrice * 0.8,
            timeframe: '1Y'
        };
    }

    // Weight by confidence and tournament performance
    let totalWeight = 0;
    let bullSum = 0, baseSum = 0, bearSum = 0;

    for (const thesis of theses) {
        // Base weight from confidence (ensure non-zero)
        let weight = Math.max(thesis.confidence, 1) / 100;

        // Bonus for tournament champion
        if (tournamentResult.champion?.agentId === thesis.agentId) {
            weight *= 1.5;
        }

        // Bonus for debate winners
        const debateWins = tournamentResult.allDebates.filter(d =>
            (d.winner === 'bull' && d.bullThesis.agentId === thesis.agentId) ||
            (d.winner === 'bear' && d.bearThesis.agentId === thesis.agentId)
        ).length;
        weight *= (1 + debateWins * 0.1);

        totalWeight += weight;
        bullSum += thesis.priceTarget.bull * weight;
        baseSum += thesis.priceTarget.base * weight;
        bearSum += thesis.priceTarget.bear * weight;
    }

    // Safe division with fallback
    const safeDivide = (sum: number) => totalWeight > 0 ? sum / totalWeight : 0;

    return {
        bull: safeDivide(bullSum),
        base: safeDivide(baseSum),
        bear: safeDivide(bearSum),
        timeframe: '1Y'
    };
}

function determineRecommendation(
    consensus: ReturnType<typeof calculateConsensus>,
    champion: InvestmentThesis | null,
    upside: number
): FinalRecommendation['recommendation'] {
    // Start with consensus
    let rec = consensus.consensusRecommendation;

    // Adjust based on upside potential
    if (upside > 30 && rec === 'hold') rec = 'buy';
    if (upside > 50 && rec === 'buy') rec = 'strong_buy';
    if (upside < -20 && rec === 'hold') rec = 'sell';
    if (upside < -30 && rec === 'sell') rec = 'strong_sell';

    // Champion's view gets extra weight
    if (champion) {
        const champRec = champion.recommendation;
        // If champion strongly disagrees with consensus, moderate
        if (
            (champRec === 'strong_sell' && (rec === 'buy' || rec === 'strong_buy')) ||
            (champRec === 'strong_buy' && (rec === 'sell' || rec === 'strong_sell'))
        ) {
            rec = 'hold';
        }
    }

    return rec;
}

function calculateConfidence(
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult
): number {
    if (theses.length === 0) return 0;

    // Base confidence from average thesis confidence (safe division)
    const avgConfidence = theses.reduce((sum, t) => sum + t.confidence, 0) / theses.length;

    // Adjust based on consensus strength (safe division)
    const { bullCount, bearCount, holdCount } = calculateConsensus(theses);
    const maxCount = Math.max(bullCount, bearCount, holdCount, 1);
    const consensusBonus = (maxCount / Math.max(theses.length, 1)) * 20;

    // Adjust based on debate clarity (clear winners = higher confidence)
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

    // Volatility risk
    if (stockData.technicals.volatility > 50) riskScore += 3;
    else if (stockData.technicals.volatility > 30) riskScore += 2;
    else if (stockData.technicals.volatility > 20) riskScore += 1;

    // Debt risk
    const debtToEquity = stockData.fundamentals.debtToEquity;
    if (debtToEquity !== null) {
        if (debtToEquity > 2) riskScore += 2;
        else if (debtToEquity > 1) riskScore += 1;
    }

    // Sentiment risk (extreme sentiment = risk)
    const sentimentScore = Math.abs(stockData.sentiment.overallScore);
    if (sentimentScore > 0.7) riskScore += 1;

    // Analyst disagreement risk
    const { bullCount, bearCount } = calculateConsensus(theses);
    if (Math.abs(bullCount - bearCount) <= 1 && theses.length > 4) {
        riskScore += 1; // High disagreement
    }

    if (riskScore >= 5) return 'very_high';
    if (riskScore >= 3) return 'high';
    if (riskScore >= 1) return 'medium';
    return 'low';
}

function calculateSuggestedAllocation(
    confidence: number,
    riskLevel: FinalRecommendation['riskLevel'],
    consensusStrength: number
): number {
    // Base allocation from confidence
    let allocation = confidence / 20; // 0-5%

    // Adjust for risk
    const riskMultiplier = {
        low: 1.2,
        medium: 1.0,
        high: 0.7,
        very_high: 0.4
    };
    allocation *= riskMultiplier[riskLevel];

    // Adjust for consensus
    allocation *= (consensusStrength / 100);

    // Cap at 10%
    return Math.min(10, Math.max(0, Math.round(allocation * 10) / 10));
}


function extractTopArguments(
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult
): { topBullArguments: string[]; topBearArguments: string[] } {
    const bullArgs: string[] = [];
    const bearArgs: string[] = [];

    // Prioritize champion's arguments
    if (tournamentResult.champion) {
        bullArgs.push(...tournamentResult.champion.bullCase.slice(0, 2));
        bearArgs.push(...tournamentResult.champion.bearCase.slice(0, 2));
    }

    // Add from other theses
    for (const thesis of theses) {
        if (thesis.agentId === tournamentResult.champion?.agentId) continue;

        for (const arg of thesis.bullCase) {
            if (!bullArgs.includes(arg) && bullArgs.length < 5) {
                bullArgs.push(arg);
            }
        }
        for (const arg of thesis.bearCase) {
            if (!bearArgs.includes(arg) && bearArgs.length < 5) {
                bearArgs.push(arg);
            }
        }
    }

    // Add winning arguments from debates
    for (const debate of tournamentResult.allDebates) {
        const winningArgs = debate.winningArguments ?? [];
        for (const arg of winningArgs) {
            if (!arg) continue; // Skip null/undefined arguments
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
        for (const risk of thesis.risks) {
            const normalized = risk.toLowerCase().trim();
            riskCounts.set(normalized, (riskCounts.get(normalized) || 0) + 1);
        }
    }

    // Sort by frequency and return top 5
    return Array.from(riskCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([risk]) => risk.charAt(0).toUpperCase() + risk.slice(1));
}

function extractKeyCatalysts(theses: InvestmentThesis[]): string[] {
    const catalystCounts = new Map<string, number>();

    for (const thesis of theses) {
        for (const catalyst of thesis.catalysts) {
            const normalized = catalyst.toLowerCase().trim();
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

        // Find those who disagree with consensus
        if ((isBullish && thesisBearish) || (isBearish && thesisBullish)) {
            const analyst = getAnalystById(thesis.agentId);
            if (analyst) {
                dissenting.push({
                    agentName: analyst.name,
                    position: thesis.recommendation.replace('_', ' ').toUpperCase(),
                    reasoning: thesis.summary || thesis.bearCase[0] || 'Disagrees with consensus'
                });
            }
        }
    }

    return dissenting.slice(0, 3);
}

function generateExecutiveSummary(
    stockData: StockAnalysisData,
    recommendation: FinalRecommendation['recommendation'],
    confidence: number,
    priceTarget: PriceTarget,
    upside: number,
    champion: InvestmentThesis | null
): string {
    const recText = recommendation.replace('_', ' ').toUpperCase();
    const ticker = stockData.ticker;
    const price = stockData.quote.price.toFixed(2);
    const targetPrice = priceTarget.base.toFixed(2);

    let summary = `Our analysis of ${ticker} results in a ${recText} recommendation with ${confidence.toFixed(0)}% confidence. `;
    summary += `At $${price}, we see ${upside >= 0 ? 'upside' : 'downside'} of ${Math.abs(upside).toFixed(1)}% to our $${targetPrice} base case target. `;

    if (champion) {
        const analyst = getAnalystById(champion.agentId);
        if (analyst) {
            summary += `The ${analyst.title} perspective prevailed in our debate tournament, emphasizing ${champion.bullCase[0]?.toLowerCase() || 'key fundamentals'}.`;
        }
    }

    return summary;
}

function getDataSourcesUsed(stockData: StockAnalysisData): string[] {
    const sources: string[] = ['Yahoo Finance'];

    if (stockData.dataQuality.hasNews) sources.push('News Sentiment');
    if (stockData.dataQuality.hasTechnicals) sources.push('Technical Analysis');
    if (stockData.dataQuality.hasAnalystRatings) sources.push('Wall Street Analysts');
    if (stockData.dataQuality.hasFundamentals) sources.push('Financial Statements');

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
