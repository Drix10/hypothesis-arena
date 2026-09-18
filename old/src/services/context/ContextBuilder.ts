/**
 * Context Builder for v5.0.0
 * 
 * Builds rich context object for AI analysts.
 * Aggregates account state, positions, market data with indicators, trade history,
 * and all trading rules/limits the AI needs to make informed decisions.
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { PrismaClient } from '@prisma/client';
import {
    TradingContext,
    AccountState,
    EnrichedPosition,
    ActiveTrade,
    DiaryEntry,
    RecentFill,
    MarketDataWithIndicators,
    PerformanceMetrics,
    Instructions,
    SentimentContext,
    PromptVars,
    convertIndicatorsToMarketData,
} from '../../types/context';
import { getTechnicalIndicatorService } from '../indicators/TechnicalIndicatorService';
import {
    getSentimentContextSafe,
    checkContrarianSignal,
    getRedditSentimentContext,
} from '../sentiment';
import {
    getQuantContext,
    formatQuantForPrompt,
} from '../quant';
import {
    generateTradingInsights,
    formatInsightsForPrompt,
} from '../journal';
// NOTE: ANTI_CHURN_RULES and LEVERAGE_POLICY are included in the system prompt (ANALYST_SYSTEM_PROMPT),
// not in the context, to avoid duplication. Only dynamic risk limits are included here.
import { RISK_COUNCIL_VETO_TRIGGERS } from '../../constants/analyst/riskCouncil';
import { GLOBAL_RISK_LIMITS, getRequiredStopLossPercent } from '../../constants/analyst/riskLimits';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';

const TRADING_SYMBOLS = APPROVED_SYMBOLS;

function buildPromptVars(accountBalanceUsd: number): PromptVars {
    const safeNum = (val: unknown, fallback: number): number =>
        typeof val === 'number' && Number.isFinite(val) ? val : fallback;

    const safeInt = (val: unknown, fallback: number): number => {
        const n = safeNum(val, fallback);
        if (!Number.isFinite(n)) return fallback;
        return Math.floor(n);
    };

    const stopLossPct = (multiplier: number, leverage: number): number => {
        const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
        const liquidationDistancePct = 100 / lev;
        const requiredMaxSlPct = getRequiredStopLossPercent(lev);
        const maxSafeSlPct = Math.min(requiredMaxSlPct, liquidationDistancePct * 0.8);
        const pct = multiplier / lev;
        const clamped = Math.max(0.1, Math.min(maxSafeSlPct, pct));
        return Number(clamped.toFixed(1));
    };

    const startingBalance = safeNum(config.trading?.startingBalance, 0);
    const minBalanceToTrade = safeNum(config.autonomous?.minBalanceToTrade, 0);

    const maxConcurrentPositions = safeNum(RISK_COUNCIL_VETO_TRIGGERS?.MAX_CONCURRENT_POSITIONS, 3);
    const maxSameDirectionPositions = safeNum(RISK_COUNCIL_VETO_TRIGGERS?.MAX_SAME_DIRECTION_POSITIONS, 2);
    const maxDailyTrades = safeInt(config.trading?.maxDailyTrades, 20);
    const maxTradesPerSymbolPerHour = safeInt(config.antiChurn?.maxTradesPerSymbolPerHour, 3);
    const cycleIntervalMinutes = Math.max(0, Math.floor(safeNum(config.autonomous?.cycleIntervalMs, 5 * 60 * 1000) / 60000));

    const maxPositionPercent = safeNum(RISK_COUNCIL_VETO_TRIGGERS?.MAX_POSITION_PERCENT, safeNum(GLOBAL_RISK_LIMITS?.MAX_POSITION_SIZE_PERCENT, 25));
    const targetPositionMinPercent = safeNum(config.autonomous?.targetPositionMinPercent, 0);
    const targetPositionMaxPercent = safeNum(config.autonomous?.targetPositionMaxPercent, 0);
    const minPositionPercent = safeNum(config.autonomous?.minPositionPercent, 0);

    const maxPositionUsd = Math.floor(accountBalanceUsd * (maxPositionPercent / 100));
    const targetPositionMinUsd = Math.floor(accountBalanceUsd * (targetPositionMinPercent / 100));
    const targetPositionMaxUsd = Math.floor(accountBalanceUsd * (targetPositionMaxPercent / 100));
    const targetPositionMidUsd = Math.floor((targetPositionMinUsd + targetPositionMaxUsd) / 2);
    const minPositionUsd = Math.floor(accountBalanceUsd * (minPositionPercent / 100));

    const targetDeploymentPercent = safeNum(config.autonomous?.targetDeploymentPercent, 0);
    const maxDeploymentPercent = safeNum(config.autonomous?.maxDeploymentPercent, 0);
    const netLongExposureLimitPercent = safeNum(RISK_COUNCIL_VETO_TRIGGERS?.NET_EXPOSURE_LIMITS?.LONG, 0);
    const netShortExposureLimitPercent = safeNum(RISK_COUNCIL_VETO_TRIGGERS?.NET_EXPOSURE_LIMITS?.SHORT, 0);

    const maxLeverage = Math.max(1, safeNum(GLOBAL_RISK_LIMITS?.ABSOLUTE_MAX_LEVERAGE, 1));
    const safeLeverage = Math.max(1, safeNum(GLOBAL_RISK_LIMITS?.MAX_SAFE_LEVERAGE, 1));
    const conservativeLeverageThreshold = Math.max(1, safeNum(GLOBAL_RISK_LIMITS?.CONSERVATIVE_LEVERAGE_THRESHOLD, 1));
    const maxLeverage90 = Math.max(1, Math.floor(maxLeverage * 0.9));
    const maxLeverage75 = Math.max(1, Math.floor(maxLeverage * 0.75));

    const minConfidenceToTrade = safeNum(config.autonomous?.minConfidenceToTrade, 0);
    const moderateConfidenceThreshold = safeNum(config.autonomous?.moderateConfidenceThreshold, 0);
    const highConfidenceThreshold = safeNum(config.autonomous?.highConfidenceThreshold, 0);
    const veryHighConfidenceThreshold = safeNum(config.autonomous?.veryHighConfidenceThreshold, 0);

    const mc = config.autonomous?.monteCarlo;
    const monteCarloMinSharpe = safeNum(mc?.minSharpeRatio, 0);
    const monteCarloTargetSharpe = safeNum(mc?.targetSharpeRatio, 0);
    const monteCarloExcellentSharpe = safeNum(mc?.excellentSharpeRatio, 0);
    const monteCarloMinWinRatePercent = safeNum(mc?.minWinRate, 0) * 100;
    const monteCarloMaxDrawdownPercent = safeNum(mc?.maxDrawdownPercent, 0);

    const qv = config.autonomous?.qValue;
    const qValueMinimum = safeNum(qv?.minimum, 0);
    const qValueConsensus = safeNum(qv?.consensus, 0);
    const qValueHighConfidence = safeNum(qv?.highConfidence, 0);

    const urgency = config.autonomous?.urgencyThresholds;
    const targetProfitPercent = safeNum(urgency?.targetProfitPct, 0);
    const partialTpPercentRaw = safeNum(urgency?.partialTpPct, 0);
    const partialTpPercent = partialTpPercentRaw > 0 ? partialTpPercentRaw : 3;
    const stopLossPercent = safeNum(urgency?.stopLossPct, 0);
    const maxHoldHours = safeNum(urgency?.maxHoldHours, 0);
    const weeklyDrawdownLimitPercent = safeNum(config.autonomous?.weeklyDrawdownLimitPercent, 0);

    const slMaxPctAtMaxLeverage = stopLossPct(50, maxLeverage);
    const slSafePctAtSafeLeverage = stopLossPct(55, safeLeverage);
    const slConservativePctAtConservative = stopLossPct(60, conservativeLeverageThreshold);
    const maxNotionalUsd = Math.floor(maxPositionUsd * maxLeverage);

    return {
        starting_balance_usd: startingBalance,
        account_balance_usd: accountBalanceUsd,
        min_balance_to_trade_usd: minBalanceToTrade,

        max_concurrent_positions: maxConcurrentPositions,
        max_same_direction_positions: maxSameDirectionPositions,
        max_daily_trades: maxDailyTrades,
        max_trades_per_symbol_per_hour: maxTradesPerSymbolPerHour,
        cycle_interval_minutes: cycleIntervalMinutes,

        max_position_percent: maxPositionPercent,
        max_position_usd: maxPositionUsd,
        max_notional_usd: maxNotionalUsd,
        target_position_min_percent: targetPositionMinPercent,
        target_position_max_percent: targetPositionMaxPercent,
        target_position_min_usd: targetPositionMinUsd,
        target_position_max_usd: targetPositionMaxUsd,
        target_position_mid_usd: targetPositionMidUsd,
        min_position_percent: minPositionPercent,
        min_position_usd: minPositionUsd,

        target_deployment_percent: targetDeploymentPercent,
        max_deployment_percent: maxDeploymentPercent,
        net_long_exposure_limit_percent: netLongExposureLimitPercent,
        net_short_exposure_limit_percent: netShortExposureLimitPercent,

        max_leverage: maxLeverage,
        safe_leverage: safeLeverage,
        conservative_leverage_threshold: conservativeLeverageThreshold,
        max_leverage_90: maxLeverage90,
        max_leverage_75: maxLeverage75,

        min_confidence_to_trade: minConfidenceToTrade,
        moderate_confidence_threshold: moderateConfidenceThreshold,
        high_confidence_threshold: highConfidenceThreshold,
        very_high_confidence_threshold: veryHighConfidenceThreshold,

        monte_carlo_min_sharpe: monteCarloMinSharpe,
        monte_carlo_target_sharpe: monteCarloTargetSharpe,
        monte_carlo_excellent_sharpe: monteCarloExcellentSharpe,
        monte_carlo_min_win_rate_percent: monteCarloMinWinRatePercent,
        monte_carlo_max_drawdown_percent: monteCarloMaxDrawdownPercent,

        q_value_minimum: qValueMinimum,
        q_value_consensus: qValueConsensus,
        q_value_high_confidence: qValueHighConfidence,

        target_profit_percent: targetProfitPercent,
        partial_tp_percent: partialTpPercent,
        stop_loss_percent: stopLossPercent,
        max_hold_hours: maxHoldHours,
        weekly_drawdown_limit_percent: weeklyDrawdownLimitPercent,

        sl_max_pct_at_max_leverage: slMaxPctAtMaxLeverage,
        sl_safe_pct_at_safe_leverage: slSafePctAtSafeLeverage,
        sl_conservative_pct_at_conservative_leverage: slConservativePctAtConservative,
    };
}

/**
 * Build risk rules string for AI context - minimal, profit-focused
 * Validates required constants and falls back to safe defaults if missing
 */
function buildRiskRulesString(): string {
    // Validate RISK_COUNCIL_VETO_TRIGGERS
    const maxLeverage = RISK_COUNCIL_VETO_TRIGGERS?.MAX_LEVERAGE ?? 20;
    const maxPositionPct = RISK_COUNCIL_VETO_TRIGGERS?.MAX_POSITION_PERCENT ?? 25;
    const maxConcurrent = RISK_COUNCIL_VETO_TRIGGERS?.MAX_CONCURRENT_POSITIONS ?? 3;

    // Validate STOP_LOSS_BY_LEVERAGE with safe defaults (CONVICTION TRADING)
    const stopLoss = GLOBAL_RISK_LIMITS?.STOP_LOSS_BY_LEVERAGE ?? {};
    const extreme = stopLoss.EXTREME ?? { maxLeverage: 20, maxStopPercent: 3 };
    const high = stopLoss.HIGH ?? { maxLeverage: 15, maxStopPercent: 4 };
    const medium = stopLoss.MEDIUM ?? { maxLeverage: 10, maxStopPercent: 5 };
    const low = stopLoss.LOW ?? { maxLeverage: 5, maxStopPercent: 8 };

    const lines = [
        'LIMITS:',
        `- Max leverage: ${maxLeverage}x`,
        `- Max position: ${maxPositionPct}% of account`,
        `- Max concurrent positions: ${maxConcurrent}`,
        `- Stop loss by leverage: ${extreme.maxLeverage}x=${extreme.maxStopPercent}%, ${high.maxLeverage}x=${high.maxStopPercent}%, ${medium.maxLeverage}x=${medium.maxStopPercent}%, ${low.maxLeverage}x=${low.maxStopPercent}%`,
    ];

    return lines.join('\n');
}

export class ContextBuilder {
    private prisma: PrismaClient;
    private invocationCount: number = 0;
    private readonly MAX_INVOCATION_COUNT = Number.MAX_SAFE_INTEGER - 1;

    constructor(prisma: PrismaClient) {
        if (!prisma) {
            throw new Error('ContextBuilder: PrismaClient is required');
        }
        this.prisma = prisma;
        logger.info('ContextBuilder initialized');
    }

    /**
     * Build full context object for analysts
     * 
     * @param accountBalance - Current available balance in USDT
     * @param positions - Current open positions from exchange
     * @param marketDataFetcher - Callback to fetch ticker data for symbols
     * @param options - Optional flags for conditional fetching
     */
    async buildContext(
        accountBalance: number,
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
            liquidationPrice?: number;
        }>,
        marketDataFetcher: (symbol: string) => Promise<{
            currentPrice: number;
            high24h: number;
            low24h: number;
            volume24h: number;
            change24h: number;
            fundingRate: number;
            openInterest: number | null;
        }>,
        options: {
            forceFreshSentiment?: boolean;
            skipJournal?: boolean;
            skipQuant?: boolean;
        } = {}
    ): Promise<TradingContext> {
        const startTime = Date.now();
        const safeAccountBalance = Number.isFinite(accountBalance) && accountBalance >= 0
            ? accountBalance
            : 0;

        if (this.invocationCount >= this.MAX_INVOCATION_COUNT) {
            this.invocationCount = 0;
        }
        this.invocationCount++;

        const currentTime = new Date().toISOString();

        // PHASE 1: Parallel Fetching of all independent data sources
        // This is the most critical optimization for latency reduction (<25s target)
        const indicatorService = getTechnicalIndicatorService();

        // Determine which data sources to fetch based on frequency and options
        // v5.5.0: Optimize by skipping expensive but slow-changing data sources
        const shouldFetchJournal = !options.skipJournal && (this.invocationCount % 5 === 1 || positions.length > 0);
        const shouldFetchQuant = !options.skipQuant && (this.invocationCount % 3 === 1);
        const shouldFetchSentiment = options.forceFreshSentiment || (this.invocationCount % 2 === 1);

        const [
            indicatorsMap,
            recentTrades,
            recentFills,
            metrics,
            sentimentContext,
            quantSummary,
            journalInsights
        ] = await Promise.all([
            indicatorService.getIndicatorsForSymbols([...TRADING_SYMBOLS]),
            this.getRecentTrades(10),
            this.getRecentFills(20),
            this.calculatePerformanceMetrics(),
            shouldFetchSentiment
                ? this.buildSentimentContext().catch(e => { logger.warn('Sentiment failed:', e); return null; })
                : Promise.resolve(null),
            shouldFetchQuant
                ? this.buildQuantContext().catch(e => { logger.warn('Quant failed:', e); return null; })
                : Promise.resolve(null),
            shouldFetchJournal
                ? this.buildJournalInsights().catch(e => { logger.warn('Journal failed:', e); return null; })
                : Promise.resolve(null),
        ]);

        // PHASE 1.5: Merge Ticker Data with Indicators
        // marketDataFetcher is now just a local Map lookup in CollaborativeFlow
        const marketDataResults = await Promise.all(TRADING_SYMBOLS.map(async (symbol) => {
            try {
                const ticker = await marketDataFetcher(symbol);
                const indicators = indicatorsMap.get(symbol.toLowerCase());

                if (!indicators) return null;

                return convertIndicatorsToMarketData(
                    symbol,
                    ticker,
                    indicators,
                    ticker.fundingRate,
                    ticker.openInterest
                );
            } catch (error) {
                logger.error(`Failed to fetch market data for ${symbol}:`, error);
                return null;
            }
        }));

        const marketData = marketDataResults.filter((m): m is MarketDataWithIndicators => m !== null);

        // PHASE 2: Compute derived state (depends on Phase 1)
        const enrichedPositions = this.enrichPositions(positions, marketData);
        const enrichedPriceMap = new Map<string, number>();
        for (const pos of enrichedPositions) {
            enrichedPriceMap.set(pos.symbol, pos.current_price);
        }

        const activeTrades = await this.getActiveTradesWithExitPlans(positions, enrichedPriceMap);

        const totalUnrealizedPnl = enrichedPositions.reduce((sum, p) => {
            const pnl = Number.isFinite(p.unrealized_pnl) ? p.unrealized_pnl : 0;
            return sum + pnl;
        }, 0);

        const accountState: AccountState = {
            balance: safeAccountBalance,
            total_value: safeAccountBalance + totalUnrealizedPnl,
            total_return_pct: metrics.total_return_pct,
            profit_factor: metrics.profit_factor,
            positions: enrichedPositions,
            active_trades: activeTrades,
            open_orders: [],
            recent_diary: recentTrades,
            recent_fills: recentFills,
        };

        const instructions: Instructions = {
            assets: TRADING_SYMBOLS,
            risk_limits: buildRiskRulesString(),
        };

        const rawContext: TradingContext = {
            invocation: {
                count: this.invocationCount,
                current_time: currentTime,
            },
            account: accountState,
            instructions,
            market_data: marketData,
            sentiment: sentimentContext || undefined,
            quant: quantSummary || undefined,
            journal_insights: journalInsights || undefined,
            prompt_vars: buildPromptVars(safeAccountBalance),
        };

        // ROUND ALL NUMBERS IN CONTEXT TO REDUCE JSON SIZE AND AI LATENCY
        const roundedContext = this.roundNumbers(rawContext);

        const buildTime = Date.now() - startTime;
        logger.info(`🏗️ Context built in ${buildTime}ms (invocation #${this.invocationCount})`);

        return roundedContext;
    }

    /**
     * Recursively round all numbers in an object to reduce JSON size and AI latency
     */
    private roundNumbers(obj: any): any {
        if (obj === null || obj === undefined) return obj;

        if (typeof obj === 'number') {
            // Round to 6 decimal places for general precision
            // If the number is very small (< 0.000001), keep it as is
            if (Math.abs(obj) < 0.000001 && obj !== 0) return obj;
            return Number(obj.toFixed(6));
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.roundNumbers(item));
        }

        if (typeof obj === 'object') {
            const result: any = {};
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    // Skip rounding for certain fields if needed (e.g. timestamps, counts)
                    if (key === 'count' || key === 'timestamp' || key === 'opened_at') {
                        result[key] = obj[key];
                    } else {
                        result[key] = this.roundNumbers(obj[key]);
                    }
                }
            }
            return result;
        }

        return obj;
    }

    /**
     * Build quant analysis context
     * Returns formatted string summary for AI consumption
     */
    private async buildQuantContext(): Promise<string | null> {
        try {
            const quantContext = await getQuantContext([...TRADING_SYMBOLS]);
            return formatQuantForPrompt(quantContext);
        } catch (error) {
            logger.warn('Failed to build quant context:', error);
            return null;
        }
    }

    /**
     * Build journal insights from trade history
     * Returns formatted string summary for AI consumption
     */
    private async buildJournalInsights(): Promise<string | null> {
        try {
            const insights = generateTradingInsights();
            // Only include if we have meaningful data (at least 5 trades)
            if (insights.totalTrades < 5) {
                return null;
            }
            return formatInsightsForPrompt(insights);
        } catch (error) {
            logger.warn('Failed to build journal insights:', error);
            return null;
        }
    }

    /**
     * Build sentiment context from cached sentiment data
     * Returns null if sentiment data is unavailable
     * 
     * v5.4.0: Now includes Reddit social sentiment for better market pulse
     */
    private async buildSentimentContext(): Promise<SentimentContext | null> {
        try {
            // Fetch news sentiment and Reddit sentiment in parallel to reduce latency
            const [sentimentData, redditData] = await Promise.all([
                getSentimentContextSafe(),
                this.fetchRedditSentimentSafe(),
            ]);

            if (!sentimentData) return null;

            const contrarian = checkContrarianSignal(sentimentData);

            // Extract top headlines (with full null/array safety)
            const headlines: string[] = [];
            const btcNews = Array.isArray(sentimentData?.btc?.recentNews)
                ? sentimentData.btc.recentNews
                : [];
            const ethNews = Array.isArray(sentimentData?.eth?.recentNews)
                ? sentimentData.eth.recentNews
                : [];

            for (const news of btcNews.slice(0, 3)) {
                if (news?.title) {
                    headlines.push(`[BTC] ${news.title.slice(0, 100)}`);
                }
            }
            for (const news of ethNews.slice(0, 2)) {
                if (news?.title) {
                    headlines.push(`[ETH] ${news.title.slice(0, 100)}`);
                }
            }

            // FIXED: Helper to safely get numeric values
            const safeNum = (val: number | null | undefined, defaultVal: number = 0): number =>
                Number.isFinite(val) ? val! : defaultVal;

            // Build Reddit sentiment object if available
            const redditSentiment = redditData && redditData.overall ? {
                overall_score: safeNum(redditData.overall.sentimentScore),
                overall_sentiment: redditData.overall.sentiment || 'neutral',
                post_count: safeNum(redditData.overall.postCount),
                btc_sentiment: redditData.btc?.sentimentScore ?? null,
                eth_sentiment: redditData.eth?.sentimentScore ?? null,
                divergence_signal: safeNum(redditData.socialVsPriceDivergence),
                divergence_reason: redditData.contrarian?.reason || 'No divergence detected',
                top_headlines: Array.isArray(redditData.topHeadlines) ? redditData.topHeadlines : [],
                is_stale: redditData.isStale ?? true,
            } : undefined;

            return {
                fear_greed_index: sentimentData.market.fearGreedIndex?.value ?? null,
                fear_greed_classification: sentimentData.market.fearGreedIndex?.classification ?? null,
                market_sentiment: safeNum(sentimentData.market.overallSentiment),
                sentiment_trend: sentimentData.market.sentimentTrend,
                btc_sentiment: {
                    score: safeNum(sentimentData.btc.overallScore),
                    sentiment: sentimentData.btc.overallSentiment,
                    news_count: safeNum(sentimentData.btc.newsCount),
                    positive_count: safeNum(sentimentData.btc.positiveCount),
                    negative_count: safeNum(sentimentData.btc.negativeCount),
                },
                eth_sentiment: {
                    score: safeNum(sentimentData.eth.overallScore),
                    sentiment: sentimentData.eth.overallSentiment,
                    news_count: safeNum(sentimentData.eth.newsCount),
                    positive_count: safeNum(sentimentData.eth.positiveCount),
                    negative_count: safeNum(sentimentData.eth.negativeCount),
                },
                contrarian_signal: contrarian,
                recent_headlines: headlines,
                last_updated: sentimentData.lastUpdated,
                reddit: redditSentiment,
            };
        } catch (error) {
            logger.warn('Failed to build sentiment context:', error);
            return null;
        }
    }

    /**
     * Fetch Reddit sentiment with timeout protection
     * Returns null if fetch fails or times out (doesn't block main flow)
     */
    private async fetchRedditSentimentSafe(): Promise<Awaited<ReturnType<typeof getRedditSentimentContext>> | null> {
        try {
            const REDDIT_FETCH_TIMEOUT = 12000; // 12 seconds max

            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = new Promise<null>((resolve) => {
                timeoutId = setTimeout(() => {
                    logger.debug('Reddit sentiment fetch timed out, continuing without it');
                    resolve(null);
                }, REDDIT_FETCH_TIMEOUT);
                if (timeoutId && (timeoutId as any).unref) {
                    (timeoutId as any).unref();
                }
            });

            const fearGreedValue = null; // Will use cached value in Reddit service

            const redditStart = Date.now();
            try {
                return await Promise.race([
                    getRedditSentimentContext(0, fearGreedValue),
                    timeoutPromise,
                ]);
            } finally {
                const redditElapsed = Date.now() - redditStart;
                if (redditElapsed > 5000) {
                    logger.warn(`Reddit sentiment fetch took ${redditElapsed}ms`);
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            }
        } catch (error) {
            logger.debug('Reddit sentiment fetch failed (non-critical):', error);
            return null;
        }
    }

    private enrichPositions(
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
            liquidationPrice?: number;
        }>,
        marketData: MarketDataWithIndicators[]
    ): EnrichedPosition[] {
        const enriched: EnrichedPosition[] = [];

        for (const pos of positions) {
            // Validate symbol - filter out invalid positions instead of using 'UNKNOWN'
            const rawSymbol = pos?.symbol;
            const trimmedSymbol = typeof rawSymbol === 'string' ? rawSymbol.trim() : '';

            if (trimmedSymbol.length === 0) {
                logger.error('Position with empty/invalid symbol filtered out:', {
                    rawSymbol,
                    side: pos?.side,
                    size: pos?.size,
                });
                continue; // Skip this position
            }

            const symbol = trimmedSymbol;
            const side = pos?.side === 'SHORT' ? 'SHORT' : 'LONG';
            const size = Number.isFinite(pos?.size) ? pos.size : 0;
            const entryPrice = Number.isFinite(pos?.entryPrice) ? pos.entryPrice : 0;
            const leverage = Number.isFinite(pos?.leverage) && pos.leverage > 0 ? pos.leverage : 1;
            const unrealizedPnl = Number.isFinite(pos?.unrealizedPnl) ? pos.unrealizedPnl : 0;

            const market = marketData.find((m) => m.asset === symbol);
            const currentPrice = market?.current_price || (Number.isFinite(pos?.currentPrice) ? pos.currentPrice : entryPrice);

            const pnlPct = (entryPrice !== 0)
                ? ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1)
                : 0;

            const marginUsed = (size * entryPrice) / leverage;

            enriched.push({
                symbol,
                side,
                size,
                entry_price: entryPrice,
                current_price: currentPrice,
                liquidation_price: pos?.liquidationPrice || null,
                unrealized_pnl: unrealizedPnl,
                unrealized_pnl_pct: Number.isFinite(pnlPct) ? pnlPct : 0,
                leverage,
                margin_used: Number.isFinite(marginUsed) ? marginUsed : 0,
            });
        }

        return enriched;
    }

    private async getActiveTradesWithExitPlans(
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
        }>,
        enrichedPriceMap?: Map<string, number>
    ): Promise<ActiveTrade[]> {
        if (positions.length === 0) return [];

        const symbols = positions.map(p => p.symbol);
        const trades = await this.prisma.trade.findMany({
            where: { symbol: { in: symbols }, status: 'OPEN' },
            orderBy: { createdAt: 'desc' },
        });

        const tradeMap = new Map<string, typeof trades[0]>();
        for (const trade of trades) {
            if (!tradeMap.has(trade.symbol)) {
                tradeMap.set(trade.symbol, trade);
            }
        }

        const activeTrades: ActiveTrade[] = [];

        for (const pos of positions) {
            const trade = tradeMap.get(pos.symbol);
            const currentPrice = enrichedPriceMap?.get(pos.symbol) ?? pos.currentPrice;
            const pnlPct = this.calculatePnlPercent(currentPrice, pos.entryPrice, pos.side);
            const openedAt = trade?.createdAt || new Date();
            const holdTimeHours = Math.max(0, (Date.now() - openedAt.getTime()) / (1000 * 60 * 60));

            activeTrades.push({
                asset: pos.symbol,
                is_long: pos.side === 'LONG',
                amount: pos.size,
                entry_price: pos.entryPrice,
                current_price: currentPrice,
                unrealized_pnl: pos.unrealizedPnl,
                unrealized_pnl_pct: pnlPct,
                exit_plan: trade?.exitPlan || 'No exit plan recorded',
                entry_thesis: trade?.entryThesis || 'No thesis recorded',
                opened_at: openedAt.toISOString(),
                hold_time_hours: holdTimeHours,
                entry_confidence: trade?.entryConfidence || 50,
                tp_price: trade?.takeProfit || null,
                sl_price: trade?.stopLoss || null,
            });
        }

        return activeTrades;
    }

    private calculatePnlPercent(currentPrice: number, entryPrice: number, side: 'LONG' | 'SHORT'): number {
        if (!Number.isFinite(entryPrice) || entryPrice === 0) return 0;
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1);
        return Number.isFinite(pnlPct) ? pnlPct : 0;
    }

    private async getRecentTrades(limit: number): Promise<DiaryEntry[]> {
        try {
            const trades = await this.prisma.trade.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
            });

            return trades.map((trade) => {
                const size = Number.isFinite(trade.size) ? trade.size : 0;
                const entryPrice = Number.isFinite(trade.entryPrice) && trade.entryPrice !== null ? trade.entryPrice : 0;
                const allocationUsd = trade.allocationUsd ?? (size * entryPrice);

                return {
                    timestamp: trade.createdAt.toISOString(),
                    asset: trade.symbol,
                    action: trade.action ?? trade.side,
                    allocation_usd: Number.isFinite(allocationUsd) ? allocationUsd : 0,
                    entry_price: entryPrice,
                    tp_price: trade.takeProfit,
                    sl_price: trade.stopLoss,
                    exit_plan: trade.exitPlan || '',
                    rationale: trade.rationale || '',
                    champion: trade.championId || 'unknown',
                    result: this.mapTradeStatus(trade.status, trade.realizedPnl),
                    realized_pnl: trade.realizedPnl,
                };
            });
        } catch (error) {
            logger.error('Failed to get recent trades:', error);
            return [];
        }
    }

    private mapTradeStatus(status: string, realizedPnl: number | null): 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN' | null {
        switch (status) {
            case 'OPEN':
            case 'PENDING':
                return 'OPEN';
            case 'FILLED':
                if (realizedPnl === null || realizedPnl === undefined) return null;
                if (realizedPnl > 0) return 'WIN';
                if (realizedPnl < 0) return 'LOSS';
                return 'BREAKEVEN';
            case 'CANCELED':
            case 'FAILED':
                return null;
            default:
                return null;
        }
    }

    private async getRecentFills(limit: number): Promise<RecentFill[]> {
        try {
            const trades = await this.prisma.trade.findMany({
                where: { status: 'FILLED' },
                orderBy: { createdAt: 'desc' },
                take: limit,
            });

            return trades.map((trade) => ({
                timestamp: trade.createdAt.toISOString(),
                symbol: trade.symbol,
                side: trade.side,
                size: trade.size,
                price: Number.isFinite(trade.entryPrice) && trade.entryPrice !== null ? trade.entryPrice : 0,
                fee: trade.fee,
                realized_pnl: trade.realizedPnl,
            }));
        } catch (error) {
            logger.error('Failed to get recent fills:', error);
            return [];
        }
    }

    private async calculatePerformanceMetrics(): Promise<PerformanceMetrics> {
        try {
            const trades = await this.prisma.trade.findMany({
                where: { status: 'FILLED', realizedPnl: { not: null } },
                orderBy: { createdAt: 'asc' },
            });

            if (trades.length === 0) return this.getDefaultMetrics();

            const wins = trades.filter((t) => (t.realizedPnl || 0) > 0);
            const losses = trades.filter((t) => (t.realizedPnl || 0) < 0);

            const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
            const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / wins.length : 0;
            const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / losses.length) : 0;

            const startingBalance = config.trading?.startingBalance;
            const totalReturnPct = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? (totalPnl / startingBalance) * 100
                : 0;

            const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);

            const validStartingBalance = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? startingBalance : 1000;
            let peak = validStartingBalance;
            let maxDrawdown = 0;
            let runningBalance = validStartingBalance;

            for (const trade of trades) {
                runningBalance += trade.realizedPnl || 0;
                if (runningBalance > peak) peak = runningBalance;
                const drawdown = peak > 0 ? (peak - runningBalance) / peak : 0;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }

            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const tradesLast24h = trades.filter((t) => t.createdAt > oneDayAgo).length;
            const tradesLast7d = trades.filter((t) => t.createdAt > sevenDaysAgo).length;

            const currentDrawdown = peak > 0 ? ((peak - runningBalance) / peak) * 100 : 0;

            return {
                total_return_pct: totalReturnPct,
                profit_factor: profitFactor,
                win_rate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
                avg_win: avgWin,
                avg_loss: avgLoss,
                max_drawdown: maxDrawdown * 100,
                current_drawdown: currentDrawdown,
                trades_last_24h: tradesLast24h,
                trades_last_7d: tradesLast7d,
                total_trades: trades.length,
            };
        } catch (error) {
            logger.error('Failed to calculate performance metrics:', error);
            return this.getDefaultMetrics();
        }
    }

    private getDefaultMetrics(): PerformanceMetrics {
        return {
            total_return_pct: 0,
            profit_factor: 0,
            win_rate: 0,
            avg_win: 0,
            avg_loss: 0,
            max_drawdown: 0,
            current_drawdown: 0,
            trades_last_24h: 0,
            trades_last_7d: 0,
            total_trades: 0,
        };
    }

    formatContextForPrompt(context: TradingContext): string {
        return JSON.stringify(context, null, 2);
    }

    getInvocationCount(): number {
        return this.invocationCount;
    }

    resetInvocationCount(): void {
        this.invocationCount = 0;
    }
}

// Singleton
let contextBuilderInstance: ContextBuilder | null = null;
let contextBuilderPrismaRef: WeakRef<PrismaClient> | null = null;

export function getContextBuilder(prisma: PrismaClient): ContextBuilder {
    if (!contextBuilderInstance) {
        contextBuilderInstance = new ContextBuilder(prisma);
        contextBuilderPrismaRef = new WeakRef(prisma);
    } else {
        const originalPrisma = contextBuilderPrismaRef?.deref();
        if (originalPrisma && prisma !== originalPrisma) {
            logger.warn('getContextBuilder called with different PrismaClient than original.');
        }
    }
    return contextBuilderInstance;
}

export function resetContextBuilder(): void {
    contextBuilderInstance = null;
    contextBuilderPrismaRef = null;
}
