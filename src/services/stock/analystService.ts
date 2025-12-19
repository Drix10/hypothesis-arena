/**
 * Analyst Service - ENHANCED
 * 
 * Generates investment theses from the 8 analyst agents using AI.
 * Each analyst receives relevant data and generates their unique perspective.
 * 
 * ENHANCEMENTS:
 * - Richer data formatting with contextual interpretation
 * - Better prompt engineering for higher quality outputs
 * - Improved parsing with validation
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
// ENHANCED DATA FORMATTING FOR LLM CONSUMPTION
// ═══════════════════════════════════════════════════════════════════════════════

function formatMetric(value: number | null | undefined, decimals: number = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return value.toFixed(decimals);
}

function formatPercent(value: number | null | undefined, isAlreadyPercent: boolean = false): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    const pct = isAlreadyPercent ? value : value * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
}

function formatLargeNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(0);
}

function formatPrice(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return '$' + value.toFixed(2);
}

/** Get valuation context */
function getValuationContext(peRatio: number | null): string {
    if (peRatio === null) return '';
    if (peRatio < 0) return '(negative earnings)';
    if (peRatio < 10) return '(deep value)';
    if (peRatio < 15) return '(below market avg)';
    if (peRatio < 20) return '(market avg)';
    if (peRatio < 30) return '(growth premium)';
    if (peRatio < 50) return '(high growth)';
    return '(extreme valuation)';
}

/** Get RSI interpretation */
function getRSIContext(rsi: number): string {
    if (rsi < 20) return 'EXTREMELY OVERSOLD';
    if (rsi < 30) return 'OVERSOLD';
    if (rsi < 40) return 'Approaching oversold';
    if (rsi < 60) return 'Neutral';
    if (rsi < 70) return 'Approaching overbought';
    if (rsi < 80) return 'OVERBOUGHT';
    return 'EXTREMELY OVERBOUGHT';
}

/** Get trend context */
function getTrendContext(price: number, sma20: number, sma50: number, sma200: number): string {
    const contexts: string[] = [];

    // Short-term trend (20-day)
    if (sma20 > 0) {
        const pctFrom20 = ((price - sma20) / sma20) * 100;
        if (Math.abs(pctFrom20) > 3) {
            contexts.push(price > sma20
                ? `${pctFrom20.toFixed(1)}% above 20-MA (short-term bullish)`
                : `${Math.abs(pctFrom20).toFixed(1)}% below 20-MA (short-term bearish)`);
        }
    }

    // Long-term trend (200-day)
    if (sma200 > 0) {
        const pctFrom200 = ((price - sma200) / sma200) * 100;
        contexts.push(price > sma200
            ? `${pctFrom200.toFixed(1)}% above 200-MA (bullish)`
            : `${Math.abs(pctFrom200).toFixed(1)}% below 200-MA (bearish)`);
    }

    // Golden/Death Cross
    if (sma50 > 0 && sma200 > 0) {
        contexts.push(sma50 > sma200 ? 'Golden Cross active' : 'Death Cross active');
    }

    return contexts.join(' | ');
}

/**
 * Format stock data for a specific analyst's focus areas
 * ENHANCED: More structured, contextual, and actionable data
 */
function formatDataForAnalyst(
    data: StockAnalysisData,
    methodology: AnalystMethodology
): string {
    const focus = ANALYST_DATA_FOCUS[methodology];
    const sections: string[] = [];
    const price = data.quote?.price ?? 0;

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1: PRICE & MARKET DATA (Always included)
    // ═══════════════════════════════════════════════════════════════════════════
    const changePercent = data.quote?.changePercent ?? 0;
    const volumeRatio = (data.quote?.avgVolume ?? 0) > 0
        ? ((data.quote?.volume ?? 0) / data.quote.avgVolume).toFixed(2)
        : 'N/A';

    sections.push(
        `═══ CURRENT MARKET DATA ═══
Price: ${formatPrice(price)} (${formatPercent(changePercent, true)} today)
Market Cap: ${formatLargeNumber(data.quote?.marketCap)}
Volume: ${formatLargeNumber(data.quote?.volume)} (${volumeRatio}x avg)
Day Range: ${formatPrice(data.quote?.dayLow)} - ${formatPrice(data.quote?.dayHigh)}`
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 2: COMPANY PROFILE
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('profile') || focus.secondary.includes('profile')) {
        const desc = data.profile?.description || '';
        const truncatedDesc = desc.length > 400 ? desc.slice(0, 400) + '...' : desc;
        const sector = data.profile?.sector || '(Not available)';
        const industry = data.profile?.industry || '(Not available)';
        const exchange = data.profile?.exchange || '(Not available)';

        sections.push(
            `═══ COMPANY PROFILE ═══
Name: ${data.profile?.name ?? data.profile?.ticker ?? 'Unknown'}
Sector: ${sector} | Industry: ${industry}
Employees: ${data.profile?.employees?.toLocaleString() ?? 'N/A'}
Exchange: ${exchange}

Description: ${truncatedDesc || 'No description available'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 3: FUNDAMENTALS (Enhanced with context)
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('fundamentals') || focus.secondary.includes('fundamentals')) {
        const f = data.fundamentals;
        const peContext = getValuationContext(f?.peRatio ?? null);

        const fcfYield = (f?.freeCashFlow && data.quote?.marketCap && data.quote.marketCap > 0)
            ? ((f.freeCashFlow / data.quote.marketCap) * 100).toFixed(2) + '%'
            : 'N/A';

        sections.push(
            `═══ FUNDAMENTAL ANALYSIS ═══

VALUATION:
• P/E (TTM): ${formatMetric(f?.peRatio)} ${peContext}
• PEG Ratio: ${formatMetric(f?.pegRatio)} ${f?.pegRatio && f.pegRatio < 1 ? '(undervalued)' : f?.pegRatio && f.pegRatio > 2 ? '(expensive)' : ''}
• P/B: ${formatMetric(f?.priceToBook)}
• EV/EBITDA: ${formatMetric(f?.evToEbitda)}

PROFITABILITY:
• Gross Margin: ${formatPercent(f?.grossMargin)}
• Operating Margin: ${formatPercent(f?.operatingMargin)}
• Net Margin: ${formatPercent(f?.profitMargin)}
• ROE: ${formatPercent(f?.returnOnEquity)} ${f?.returnOnEquity && f.returnOnEquity > 0.15 ? '(excellent)' : ''}
• ROA: ${formatPercent(f?.returnOnAssets)}

GROWTH:
• Revenue Growth: ${formatPercent(f?.revenueGrowth)}
• Earnings Growth: ${formatPercent(f?.earningsGrowth)}

FINANCIAL HEALTH:
• Debt/Equity: ${formatMetric(f?.debtToEquity)} ${f?.debtToEquity && f.debtToEquity > 1 ? '(high leverage)' : ''}
• Current Ratio: ${formatMetric(f?.currentRatio)} ${f?.currentRatio && f.currentRatio < 1 ? '(liquidity risk)' : ''}
• FCF: ${formatLargeNumber(f?.freeCashFlow)}
• FCF Yield: ${fcfYield}

PER SHARE:
• EPS: ${formatPrice(f?.eps)}
• Book Value: ${formatPrice(f?.bookValue)}
• Dividend Yield: ${formatPercent(f?.dividendYield)}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 4: TECHNICAL ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('technicals') || focus.secondary.includes('technicals')) {
        const t = data.technicals;
        const rsi = t?.rsi14 ?? 50;
        const sma20 = t?.sma20 ?? 0;
        const sma50 = t?.sma50 ?? 0;
        const sma200 = t?.sma200 ?? 0;

        const rsiContext = getRSIContext(rsi);
        const trendContext = getTrendContext(price, sma20, sma50, sma200);

        const macdSignal = (t?.macd?.histogram ?? 0) > 0 ? 'BULLISH' : 'BEARISH';

        const bbPosition = t?.bollingerBands
            ? price < t.bollingerBands.lower ? 'BELOW lower band (oversold)'
                : price > t.bollingerBands.upper ? 'ABOVE upper band (overbought)'
                    : 'Within bands'
            : 'N/A';

        const supportLevels = t?.supportLevels ?? [];
        const resistanceLevels = t?.resistanceLevels ?? [];
        const signals = t?.signals ?? [];

        sections.push(
            `═══ TECHNICAL ANALYSIS ═══

TREND:
• Direction: ${(t?.trend ?? 'sideways').toUpperCase().replace('_', ' ')}
• Strength: ${t?.trendStrength ?? 50}/100
• ${trendContext}

MOVING AVERAGES:
• 20-day: ${formatPrice(sma20)} (${price > sma20 ? 'ABOVE' : 'BELOW'})
• 50-day: ${formatPrice(sma50)} (${price > sma50 ? 'ABOVE' : 'BELOW'})
• 200-day: ${formatPrice(sma200)} (${price > sma200 ? 'ABOVE' : 'BELOW'})

MOMENTUM:
• RSI(14): ${rsi.toFixed(1)} - ${rsiContext}
• MACD: ${macdSignal} (histogram: ${formatMetric(t?.macd?.histogram)})
• Stochastic: ${formatMetric(t?.stochastic?.k)}/${formatMetric(t?.stochastic?.d)}

VOLATILITY:
• Historical: ${formatMetric(t?.volatility)}% ${(t?.volatility ?? 0) > 40 ? '(HIGH)' : (t?.volatility ?? 0) < 20 ? '(LOW)' : ''}
• ATR(14): ${formatPrice(t?.atr14)}
• Bollinger: ${bbPosition}

KEY LEVELS:
• Support: ${supportLevels.length > 0 ? supportLevels.map(s => formatPrice(s)).join(', ') : 'None'}
• Resistance: ${resistanceLevels.length > 0 ? resistanceLevels.map(r => formatPrice(r)).join(', ') : 'None'}

SIGNALS:
${signals.length > 0 ? signals.map(s => `• ${s.indicator}: ${s.signal.toUpperCase()} (${s.strength}/100)`).join('\n') : '• No strong signals'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 5: SENTIMENT ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('sentiment') || focus.secondary.includes('sentiment')) {
        const s = data.sentiment;
        const recentNews = s?.recentNews ?? [];
        const overallScore = s?.overallScore ?? 0;

        const sentimentInterpretation = overallScore > 0.3
            ? 'Strong positive - potential contrarian sell'
            : overallScore < -0.3
                ? 'Strong negative - potential contrarian buy'
                : 'Neutral';

        const newsBreakdown = recentNews.slice(0, 6).map((n, i) => {
            const icon = n.sentiment === 'positive' ? '📈' : n.sentiment === 'negative' ? '📉' : '➡️';
            return `${i + 1}. ${icon} ${n.title?.slice(0, 70)}... (${n.source})`;
        }).join('\n');

        sections.push(
            `═══ SENTIMENT ANALYSIS ═══

OVERALL:
• Score: ${overallScore.toFixed(2)} (-1 to +1)
• Classification: ${(s?.overallSentiment ?? 'neutral').toUpperCase().replace('_', ' ')}
• Interpretation: ${sentimentInterpretation}

NEWS BREAKDOWN:
• Total: ${s?.newsCount ?? 0} articles
• Positive: ${s?.positiveCount ?? 0} | Negative: ${s?.negativeCount ?? 0} | Neutral: ${s?.neutralCount ?? 0}

RECENT HEADLINES:
${newsBreakdown || 'No recent news'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 6: WALL STREET RATINGS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('analystRatings') || focus.secondary.includes('analystRatings')) {
        const r = data.analystRatings;
        const totalRatings = (r?.strongBuy ?? 0) + (r?.buy ?? 0) + (r?.hold ?? 0) + (r?.sell ?? 0) + (r?.strongSell ?? 0);

        const upside = (r?.targetMean && price > 0)
            ? (((r.targetMean - price) / price) * 100).toFixed(1) + '%'
            : 'N/A';

        sections.push(
            `═══ WALL STREET RATINGS ═══

CONSENSUS: ${(r?.consensus ?? 'hold').toUpperCase().replace('_', ' ')}
Coverage: ${r?.numberOfAnalysts ?? 0} analysts (${totalRatings} total ratings)

PRICE TARGETS:
• Low: ${formatPrice(r?.targetLow)}
• Mean: ${formatPrice(r?.targetMean)} (${upside} from current)
• High: ${formatPrice(r?.targetHigh)}

DISTRIBUTION:
• Strong Buy: ${r?.strongBuy ?? 0} | Buy: ${r?.buy ?? 0}
• Hold: ${r?.hold ?? 0}
• Sell: ${r?.sell ?? 0} | Strong Sell: ${r?.strongSell ?? 0}`
        );
    }

    // Data quality notes
    const warnings = data.dataQuality?.warnings ?? [];
    if (warnings.length > 0) {
        sections.push(`═══ DATA NOTES ═══\n${warnings.slice(0, 3).map(w => `⚠ ${w}`).join('\n')}`);
    }

    return sections.join('\n\n');
}


// ═══════════════════════════════════════════════════════════════════════════════
// THESIS PARSING - ENHANCED
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse AI response into structured thesis with validation
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

        // Try to find JSON object if not in code block
        if (!jsonStr.trim().startsWith('{')) {
            const jsonStart = response.indexOf('{');
            const jsonEnd = response.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                jsonStr = response.slice(jsonStart, jsonEnd + 1);
            }
        }

        const parsed: ParsedThesis = JSON.parse(jsonStr.trim());

        // Validate and normalize recommendation
        const recMap: Record<string, InvestmentThesis['recommendation']> = {
            'STRONG_BUY': 'strong_buy',
            'STRONG BUY': 'strong_buy',
            'STRONGBUY': 'strong_buy',
            'BUY': 'buy',
            'HOLD': 'hold',
            'SELL': 'sell',
            'STRONG_SELL': 'strong_sell',
            'STRONG SELL': 'strong_sell',
            'STRONGSELL': 'strong_sell'
        };

        const recommendation = recMap[parsed.recommendation?.toUpperCase()] || 'hold';

        // Validate confidence (clamp to reasonable range)
        const confidence = Math.max(0, Math.min(100, parsed.confidence || 50));

        // Validate price targets with safe defaults
        const safePrice = currentPrice > 0 ? currentPrice : 100;

        const sanitizePrice = (price: unknown, fallback: number): number => {
            if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
                return price;
            }
            return fallback;
        };

        // Ensure price targets are logically consistent
        let bullTarget = sanitizePrice(parsed.priceTarget?.bull, safePrice * 1.3);
        let baseTarget = sanitizePrice(parsed.priceTarget?.base, safePrice * 1.1);
        let bearTarget = sanitizePrice(parsed.priceTarget?.bear, safePrice * 0.8);

        // Fix ordering if needed
        if (bearTarget > baseTarget) [bearTarget, baseTarget] = [baseTarget, bearTarget];
        if (baseTarget > bullTarget) [baseTarget, bullTarget] = [bullTarget, baseTarget];
        if (bearTarget > baseTarget) [bearTarget, baseTarget] = [baseTarget, bearTarget];

        const priceTarget: PriceTarget = {
            bull: bullTarget,
            base: baseTarget,
            bear: bearTarget,
            timeframe: '1Y'
        };

        // Validate arrays
        const bullCase = Array.isArray(parsed.bullCase)
            ? parsed.bullCase.filter(Boolean).slice(0, 5)
            : [];
        const bearCase = Array.isArray(parsed.bearCase)
            ? parsed.bearCase.filter(Boolean).slice(0, 5)
            : [];
        const catalysts = Array.isArray(parsed.catalysts)
            ? parsed.catalysts.filter(Boolean).slice(0, 3)
            : [];

        return {
            agentId,
            ticker,
            recommendation,
            confidence,
            priceTarget,
            bullCase,
            bearCase,
            keyMetrics: parsed.keyMetrics || {},
            catalysts,
            risks: bearCase, // Use bear case as risks
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
                maxOutputTokens: 2500
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
