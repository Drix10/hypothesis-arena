/**
 * Analyst Service
 * 
 * Generates investment theses from the 8 analyst agents using AI.
 * Each analyst receives relevant data and generates their unique perspective.
 */

import { GoogleGenAI } from '@google/genai';
import {
    AnalystAgent,
    AnalystMethodology,
    InvestmentThesis,
    StockAnalysisData,
    PriceTarget
} from '../../types/stock';
import {
    ANALYST_PROFILES,
    THESIS_SYSTEM_PROMPTS,
    ANALYST_DATA_FOCUS,
    buildThesisPrompt,
    getAllAnalysts
} from '../../constants/analystPrompts';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ThesisGenerationResult {
    analyst: AnalystAgent;
    thesis: InvestmentThesis | null;
    error: string | null;
}

interface ParsedThesis {
    recommendation: string;
    confidence: number;
    priceTarget: { bull: number; base: number; bear: number };
    bullCase: string[];
    bearCase: string[];
    keyMetrics: Record<string, string>;
    catalysts: string[];
    summary: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

function formatMetric(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return value.toFixed(2);
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return (value * 100).toFixed(1) + '%';
}

function formatLargeNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    if (value >= 1e12) return (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(2) + 'K';
    return value.toFixed(0);
}


/**
 * Format stock data for a specific analyst's focus areas
 */
function formatDataForAnalyst(
    data: StockAnalysisData,
    methodology: AnalystMethodology
): string {
    const focus = ANALYST_DATA_FOCUS[methodology];
    const sections: string[] = [];

    // Always include basic quote info (with safe defaults)
    const price = data.quote?.price ?? 0;
    const changePercent = data.quote?.changePercent ?? 0;
    const changeSign = changePercent >= 0 ? '+' : '';
    sections.push(
        `CURRENT PRICE: $${price.toFixed(2)} (${changeSign}${changePercent.toFixed(2)}%)\n` +
        `Market Cap: ${formatLargeNumber(data.quote?.marketCap)}\n` +
        `Volume: ${formatLargeNumber(data.quote?.volume)} (Avg: ${formatLargeNumber(data.quote?.avgVolume)})`
    );

    // Company profile
    if (focus.primary.includes('profile') || focus.secondary.includes('profile')) {
        const desc = data.profile?.description || '';
        sections.push(
            `COMPANY: ${data.profile?.name ?? 'Unknown'}\n` +
            `Sector: ${data.profile?.sector ?? 'Unknown'} | Industry: ${data.profile?.industry ?? 'Unknown'}\n` +
            desc.slice(0, 300) + (desc.length > 300 ? '...' : '')
        );
    }

    // Fundamentals
    if (focus.primary.includes('fundamentals') || focus.secondary.includes('fundamentals')) {
        const f = data.fundamentals;
        sections.push(
            'FUNDAMENTALS:\n' +
            `P/E Ratio: ${formatMetric(f?.peRatio)} | Forward P/E: ${formatMetric(f?.forwardPE)}\n` +
            `PEG Ratio: ${formatMetric(f?.pegRatio)} | P/B: ${formatMetric(f?.priceToBook)}\n` +
            `EPS (TTM): ${formatMetric(f?.eps)} | Forward EPS: ${formatMetric(f?.epsForward)}\n` +
            `Revenue Growth: ${formatPercent(f?.revenueGrowth)} | Earnings Growth: ${formatPercent(f?.earningsGrowth)}\n` +
            `Profit Margin: ${formatPercent(f?.profitMargin)} | ROE: ${formatPercent(f?.returnOnEquity)}\n` +
            `Debt/Equity: ${formatMetric(f?.debtToEquity)} | Current Ratio: ${formatMetric(f?.currentRatio)}\n` +
            `Free Cash Flow: ${formatLargeNumber(f?.freeCashFlow)}\n` +
            `Dividend Yield: ${formatPercent(f?.dividendYield)}`
        );
    }

    // Technicals
    if (focus.primary.includes('technicals') || focus.secondary.includes('technicals')) {
        const t = data.technicals;
        const supportLevels = t?.supportLevels ?? [];
        const resistanceLevels = t?.resistanceLevels ?? [];
        const signals = t?.signals ?? [];

        const supportStr = supportLevels.length > 0
            ? supportLevels.map(s => `$${(s ?? 0).toFixed(2)}`).join(', ')
            : 'N/A';
        const resistanceStr = resistanceLevels.length > 0
            ? resistanceLevels.map(r => `$${(r ?? 0).toFixed(2)}`).join(', ')
            : 'N/A';
        const signalsStr = signals.length > 0
            ? signals.map(s => `${s?.indicator ?? 'Unknown'}: ${s?.signal ?? 'neutral'}`).join(', ')
            : 'None';

        const rsi = t?.rsi14 ?? 50;
        const macdHistogram = t?.macd?.histogram ?? 0;
        const sma20 = t?.sma20 ?? 0;
        const sma50 = t?.sma50 ?? 0;
        const sma200 = t?.sma200 ?? 0;
        const bbLower = t?.bollingerBands?.lower ?? 0;
        const bbUpper = t?.bollingerBands?.upper ?? 0;
        const volatility = t?.volatility ?? 0;

        sections.push(
            'TECHNICALS:\n' +
            `Trend: ${(t?.trend ?? 'sideways').toUpperCase()} (Strength: ${t?.trendStrength ?? 50}/100)\n` +
            `RSI(14): ${rsi.toFixed(1)} | MACD: ${macdHistogram > 0 ? 'Bullish' : 'Bearish'}\n` +
            `SMA 20/50/200: ${sma20.toFixed(2)} / ${sma50.toFixed(2)} / ${sma200.toFixed(2)}\n` +
            `Bollinger: ${bbLower.toFixed(2)} - ${bbUpper.toFixed(2)}\n` +
            `Support: ${supportStr}\n` +
            `Resistance: ${resistanceStr}\n` +
            `Volatility: ${volatility.toFixed(1)}%\n` +
            `Signals: ${signalsStr}`
        );
    }

    // Sentiment
    if (focus.primary.includes('sentiment') || focus.secondary.includes('sentiment')) {
        const s = data.sentiment;
        const recentNews = s?.recentNews ?? [];
        const headlines = recentNews.slice(0, 5).map(n => `- ${n?.title ?? 'Untitled'} (${n?.sentiment ?? 'neutral'})`).join('\n');
        const overallScore = s?.overallScore ?? 0;
        sections.push(
            'SENTIMENT:\n' +
            `Overall: ${(s?.overallSentiment ?? 'neutral').toUpperCase()} (Score: ${overallScore.toFixed(2)})\n` +
            `News: ${s?.positiveCount ?? 0} positive, ${s?.negativeCount ?? 0} negative, ${s?.neutralCount ?? 0} neutral\n` +
            `Recent Headlines:\n${headlines || 'No recent news'}`
        );
    }

    // Analyst Ratings
    if (focus.primary.includes('analystRatings') || focus.secondary.includes('analystRatings')) {
        const r = data.analystRatings;
        sections.push(
            'ANALYST RATINGS:\n' +
            `Consensus: ${(r?.consensus ?? 'hold').toUpperCase()} (${r?.numberOfAnalysts ?? 0} analysts)\n` +
            `Price Target: ${r?.targetLow ?? 'N/A'} - ${r?.targetHigh ?? 'N/A'} (Mean: ${r?.targetMean ?? 'N/A'})\n` +
            `Distribution: ${r?.strongBuy ?? 0} Strong Buy, ${r?.buy ?? 0} Buy, ${r?.hold ?? 0} Hold, ${r?.sell ?? 0} Sell, ${r?.strongSell ?? 0} Strong Sell`
        );
    }

    return sections.join('\n\n');
}


// ═══════════════════════════════════════════════════════════════════════════════
// THESIS PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse AI response into structured thesis
 */
function parseThesisResponse(
    response: string,
    agentId: string,
    ticker: string,
    currentPrice: number
): InvestmentThesis | null {
    try {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = response;
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        }

        const parsed: ParsedThesis = JSON.parse(jsonStr.trim());

        // Validate and normalize recommendation
        const recMap: Record<string, InvestmentThesis['recommendation']> = {
            'STRONG_BUY': 'strong_buy',
            'STRONG BUY': 'strong_buy',
            'BUY': 'buy',
            'HOLD': 'hold',
            'SELL': 'sell',
            'STRONG_SELL': 'strong_sell',
            'STRONG SELL': 'strong_sell'
        };

        const recommendation = recMap[parsed.recommendation?.toUpperCase()] || 'hold';
        const confidence = Math.max(0, Math.min(100, parsed.confidence || 50));

        // Validate price targets with safe defaults
        const safePrice = currentPrice > 0 ? currentPrice : 100;

        // Helper to validate and sanitize price values
        const sanitizePrice = (price: unknown, fallback: number): number => {
            if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
                return price;
            }
            return fallback;
        };

        const priceTarget: PriceTarget = {
            bull: sanitizePrice(parsed.priceTarget?.bull, safePrice * 1.3),
            base: sanitizePrice(parsed.priceTarget?.base, safePrice * 1.1),
            bear: sanitizePrice(parsed.priceTarget?.bear, safePrice * 0.8),
            timeframe: '1Y'
        };

        return {
            agentId,
            ticker,
            recommendation,
            confidence,
            priceTarget,
            bullCase: Array.isArray(parsed.bullCase) ? parsed.bullCase.filter(Boolean) : [],
            bearCase: Array.isArray(parsed.bearCase) ? parsed.bearCase.filter(Boolean) : [],
            keyMetrics: parsed.keyMetrics || {},
            catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.filter(Boolean) : [],
            risks: Array.isArray(parsed.bearCase) ? parsed.bearCase.filter(Boolean) : [],
            summary: parsed.summary || '',
            detailedAnalysis: response
        };
    } catch (error) {
        logger.error(`Failed to parse thesis response for ${agentId}:`, error);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THESIS GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate thesis for a single analyst
 */
async function generateSingleThesis(
    ai: GoogleGenAI,
    analyst: AnalystAgent,
    stockData: StockAnalysisData,
    model: string = 'gemini-2.0-flash'
): Promise<ThesisGenerationResult> {
    try {
        const systemPrompt = THESIS_SYSTEM_PROMPTS[analyst.methodology];
        const dataContext = formatDataForAnalyst(stockData, analyst.methodology);
        const userPrompt = buildThesisPrompt(
            stockData.ticker,
            stockData.profile?.name ?? stockData.ticker,
            dataContext
        );

        const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.7,
                maxOutputTokens: 2000
            }
        });

        const text = response.text || '';
        const thesis = parseThesisResponse(
            text,
            analyst.id,
            stockData.ticker,
            stockData.quote?.price ?? 0
        );

        if (!thesis) {
            return {
                analyst,
                thesis: null,
                error: 'Failed to parse thesis response'
            };
        }

        return { analyst, thesis, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Thesis generation failed for ${analyst.name}:`, error);
        return { analyst, thesis: null, error: message };
    }
}

/**
 * Generate theses for all 8 analysts
 */
export async function generateAllTheses(
    apiKey: string,
    stockData: StockAnalysisData,
    options: {
        model?: string;
        concurrency?: number;
        onProgress?: (completed: number, total: number, analyst: string) => void;
    } = {}
): Promise<{
    theses: InvestmentThesis[];
    errors: { analyst: string; error: string }[];
}> {
    const { model = 'gemini-2.0-flash', concurrency = 2, onProgress } = options;
    const ai = new GoogleGenAI({ apiKey });
    const analysts = getAllAnalysts();
    const results: ThesisGenerationResult[] = [];
    const errors: { analyst: string; error: string }[] = [];

    // Process in batches to avoid rate limits
    for (let i = 0; i < analysts.length; i += concurrency) {
        const batch = analysts.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(analyst => generateSingleThesis(ai, analyst, stockData, model))
        );

        for (const result of batchResults) {
            results.push(result);
            if (result.error) {
                errors.push({ analyst: result.analyst.name, error: result.error });
            }
            if (onProgress) {
                onProgress(results.length, analysts.length, result.analyst.name);
            }
        }

        // Small delay between batches to avoid rate limits
        if (i + concurrency < analysts.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    const theses = results
        .filter(r => r.thesis !== null)
        .map(r => r.thesis as InvestmentThesis);

    return { theses, errors };
}

/**
 * Generate thesis for a specific analyst
 */
export async function generateThesisForAnalyst(
    apiKey: string,
    methodology: AnalystMethodology,
    stockData: StockAnalysisData,
    model: string = 'gemini-2.0-flash'
): Promise<InvestmentThesis | null> {
    const ai = new GoogleGenAI({ apiKey });
    const analyst = ANALYST_PROFILES[methodology];
    const result = await generateSingleThesis(ai, analyst, stockData, model);
    return result.thesis;
}


// ═══════════════════════════════════════════════════════════════════════════════
// THESIS ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Categorize analysts by their recommendation
 */
export function categorizeByRecommendation(theses: InvestmentThesis[]): {
    bulls: InvestmentThesis[];
    bears: InvestmentThesis[];
    neutral: InvestmentThesis[];
} {
    const bulls: InvestmentThesis[] = [];
    const bears: InvestmentThesis[] = [];
    const neutral: InvestmentThesis[] = [];

    for (const thesis of theses) {
        if (thesis.recommendation === 'strong_buy' || thesis.recommendation === 'buy') {
            bulls.push(thesis);
        } else if (thesis.recommendation === 'strong_sell' || thesis.recommendation === 'sell') {
            bears.push(thesis);
        } else {
            neutral.push(thesis);
        }
    }

    return { bulls, bears, neutral };
}

/**
 * Calculate consensus metrics from all theses
 */
export function calculateConsensus(theses: InvestmentThesis[]): {
    avgConfidence: number;
    avgPriceTarget: number;
    consensusRecommendation: InvestmentThesis['recommendation'];
    bullCount: number;
    bearCount: number;
    holdCount: number;
} {
    if (theses.length === 0) {
        return {
            avgConfidence: 0,
            avgPriceTarget: 0,
            consensusRecommendation: 'hold',
            bullCount: 0,
            bearCount: 0,
            holdCount: 0
        };
    }

    const { bulls, bears, neutral } = categorizeByRecommendation(theses);

    // Safe division (theses.length is guaranteed > 0 here)
    const avgConfidence = theses.reduce((sum, t) => sum + (t.confidence ?? 0), 0) / theses.length;
    const avgPriceTarget = theses.reduce((sum, t) => sum + (t.priceTarget?.base ?? 0), 0) / theses.length;

    let consensusRecommendation: InvestmentThesis['recommendation'] = 'hold';
    if (bulls.length > bears.length + neutral.length) {
        consensusRecommendation = bulls.some(t => t.recommendation === 'strong_buy') ? 'strong_buy' : 'buy';
    } else if (bears.length > bulls.length + neutral.length) {
        consensusRecommendation = bears.some(t => t.recommendation === 'strong_sell') ? 'strong_sell' : 'sell';
    }

    return {
        avgConfidence,
        avgPriceTarget,
        consensusRecommendation,
        bullCount: bulls.length,
        bearCount: bears.length,
        holdCount: neutral.length
    };
}

// Re-export for convenience
export { getAllAnalysts, getAnalystById, getAnalystByMethodology } from '../../constants/analystPrompts';
