/**
 * Autonomous Trading Engine - COLLABORATIVE MODE
 * 
 * 4 AI analysts collaborate on ONE shared portfolio.
 * Debates are the core decision mechanism.
 * 
 * 6-Stage Pipeline:
 * 1. Market Scan - Fetch data for all 8 coins
 * 2. Coin Selection - 3 analysts (Ray, Jim, Quant) pick best opportunity
 * 3. Championship - All 4 analysts compete, winner's thesis gets executed
 * 4. Risk Council - Karen approves/vetoes/adjusts
 * 5. Execution - Place trade on WEEX with TP/SL
 * 6. Position Management - Monitor and adjust positions
 */

import { EventEmitter } from 'events';
import crypto from 'crypto'; // For generating UUIDs
import { type ExtendedMarketData, type AnalysisResult } from '../ai/GeminiService';
import { collaborativeFlowService, type CoinSelectionResult, type RiskCouncilDecision } from '../ai/CollaborativeFlow';
import { getWeexClient } from '../weex/WeexClient';
import { tradingScheduler } from './TradingScheduler';
import { circuitBreakerService } from '../risk/CircuitBreakerService';
import { AnalystPortfolioService } from '../portfolio/AnalystPortfolioService';
import { aiLogService } from '../compliance/AILogService';
import { prisma, queryOne } from '../../config/database';
import { Prisma } from '@prisma/client';
import { config, getActiveTradingStyle } from '../../config';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES, RISK_COUNCIL_VETO_TRIGGERS } from '../../constants/analyst';
import { roundToStepSize, roundToTickSize, updateContractSpecs, getContractSpecs } from '../../shared/utils/weex';

// Contract specs refresh interval (30 minutes) - refresh before cache expires (1 hour TTL)
const CONTRACT_SPECS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// FIXED: Track refresh state per engine instance to avoid stale state on restart
// This is managed by the engine instance, not module-level
class ContractSpecsRefreshTracker {
    private lastRefresh = 0;
    private isRefreshing = false; // Prevent concurrent refresh attempts

    shouldRefresh(): boolean {
        if (this.isRefreshing) return false;
        return Date.now() - this.lastRefresh > CONTRACT_SPECS_REFRESH_INTERVAL_MS;
    }

    markRefreshing(): boolean {
        if (this.isRefreshing) return false; // Already refreshing
        this.isRefreshing = true;
        return true;
    }

    markRefreshed(): void {
        this.lastRefresh = Date.now();
        this.isRefreshing = false;
    }

    markFailed(): void {
        this.isRefreshing = false;
        // Don't update lastRefresh - allow retry on next cycle
    }

    reset(): void {
        this.lastRefresh = 0;
        this.isRefreshing = false;
    }

    getLastRefresh(): number {
        return this.lastRefresh;
    }
}

const APPROVED_SYMBOLS = [
    'cmt_btcusdt',
    'cmt_ethusdt',
    'cmt_solusdt',
    'cmt_dogeusdt',
    'cmt_xrpusdt',
    'cmt_adausdt',
    'cmt_bnbusdt',
    'cmt_ltcusdt',
] as const;

const ANALYST_IDS = ['jim', 'ray', 'karen', 'quant'] as const;

// =========================================================================
// DEBATE RESULT VALIDATION HELPERS
// =========================================================================

interface CoinSelectionDebateResult {
    winner: string;
    coinSymbol: string;
    action: 'LONG' | 'SHORT' | 'MANAGE';
    direction?: 'LONG' | 'SHORT'; // backward compat
    debate: { turns: unknown[]; scores: Record<string, unknown>; reasoning: string };
}

type RecommendationType = 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';

interface ChampionshipDebateResult {
    champion: {
        analystName: string;
        confidence: number;
        thesis: string;
        recommendation: RecommendationType;
        priceTarget: { base: number; bear: number }
    };
    debate: { turns: unknown[] };
}

/**
 * Validates coin selection debate result has required properties
 */
function isValidCoinSelectionResult(obj: unknown): obj is CoinSelectionDebateResult {
    if (!obj || typeof obj !== 'object') return false;
    const result = obj as Record<string, unknown>;
    return (
        typeof result.winner === 'string' && result.winner.length > 0 &&
        typeof result.coinSymbol === 'string' && result.coinSymbol.length > 0 &&
        (result.action === 'LONG' || result.action === 'SHORT' || result.action === 'MANAGE' ||
            result.direction === 'LONG' || result.direction === 'SHORT') &&
        result.debate !== null && typeof result.debate === 'object'
    );
}

/**
 * Validates championship debate result has required properties
 * Ensures champion.priceTarget has numeric base and bear properties
 * Ensures champion.recommendation is a valid recommendation type
 */
function isValidChampionshipResult(obj: unknown): obj is ChampionshipDebateResult {
    if (!obj || typeof obj !== 'object') return false;
    const result = obj as Record<string, unknown>;
    if (!result.champion || typeof result.champion !== 'object') return false;
    if (!result.debate || typeof result.debate !== 'object') return false;
    const champion = result.champion as Record<string, unknown>;

    // Validate basic champion properties
    if (typeof champion.analystName !== 'string') return false;
    if (typeof champion.confidence !== 'number') return false;
    if (typeof champion.thesis !== 'string') return false;

    // Validate recommendation is one of the allowed values
    const validRecommendations: RecommendationType[] = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'];
    if (typeof champion.recommendation !== 'string' || !validRecommendations.includes(champion.recommendation as RecommendationType)) {
        return false;
    }

    // Validate priceTarget has required numeric properties
    if (champion.priceTarget == null || typeof champion.priceTarget !== 'object') return false;
    const priceTarget = champion.priceTarget as Record<string, unknown>;
    if (typeof priceTarget.base !== 'number' || !Number.isFinite(priceTarget.base)) return false;
    if (typeof priceTarget.bear !== 'number' || !Number.isFinite(priceTarget.bear)) return false;

    return true;
}

/**
 * Assumed average leverage for existing positions when actual leverage is unavailable.
 * Used as a fallback to estimate margin usage. In production, persist per-position leverage
 * in the database for more accurate margin calculations.
 */
const ASSUMED_AVERAGE_LEVERAGE = 3;

interface AnalystState {
    analystId: string;
    portfolioId: string;
    balance: number;
    positions: Array<{
        symbol: string;
        side: 'LONG' | 'SHORT';
        size: number;
        entryPrice: number;
        leverage?: number; // Actual leverage from WEEX (optional for backward compatibility)
        unrealizedPnl?: number; // Unrealized PnL for risk assessment
    }>;
    lastTradeTime: number;
    totalTrades: number;
    winRate: number;
    consecutiveWins?: number; // Optional for tracking win streaks
    consecutiveLosses?: number; // Optional for tracking loss streaks
}

interface TradingCycle {
    cycleNumber: number;
    startTime: number;
    endTime?: number;
    symbolsAnalyzed: string[];
    tradesExecuted: number;
    debatesRun: number;
    errors: string[];
}

// =========================================================================
// PRE-STAGE-2 OPTIMIZATION: URGENCY LEVELS FOR POSITION MANAGEMENT
// =========================================================================

/**
 * Urgency levels for position management decisions
 * Used to determine whether to skip Stage 2 debate entirely
 */
type PositionUrgency = 'VERY_URGENT' | 'MODERATE' | 'LOW';

interface PositionWithUrgency {
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    holdTimeHours: number;
    urgency: PositionUrgency;
    urgencyReason: string;
}

/**
 * Calculate urgency level for a position based on P&L and hold time
 * Uses trading style config for dynamic thresholds
 * 
 * @param position - Position to evaluate
 * @returns Urgency level and reason
 */
function calculatePositionUrgency(position: {
    unrealizedPnlPercent: number;
    holdTimeHours: number;
}): { urgency: PositionUrgency; reason: string } {
    const tradingStyle = getActiveTradingStyle();
    const tp4 = tradingStyle.takeProfitThresholds.partial75; // Highest TP threshold
    const tp2 = tradingStyle.takeProfitThresholds.partial25; // Partial TP zone
    const sl = tradingStyle.stopLossPercent;
    const maxHold = tradingStyle.maxHoldHours;

    // FLAW FIX: Validate inputs - treat invalid values as LOW urgency
    const pnl = Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : 0;
    const holdHours = Number.isFinite(position.holdTimeHours) ? position.holdTimeHours : 0;

    // FLAW FIX: Validate config values - use safe defaults if invalid
    const safeTp4 = Number.isFinite(tp4) && tp4 > 0 ? tp4 : 5;
    const safeTp2 = Number.isFinite(tp2) && tp2 > 0 ? tp2 : 2;
    const safeSl = Number.isFinite(sl) && sl > 0 ? sl : 5;
    const safeMaxHold = Number.isFinite(maxHold) && maxHold > 0 ? maxHold : 12;

    // VERY_URGENT: Needs immediate action
    if (pnl >= safeTp4) {
        return { urgency: 'VERY_URGENT', reason: `P&L +${pnl.toFixed(1)}% >= TP4 (${safeTp4}%)` };
    }
    if (pnl <= -safeSl) {
        return { urgency: 'VERY_URGENT', reason: `P&L ${pnl.toFixed(1)}% <= -SL (${safeSl}%)` };
    }
    if (holdHours >= safeMaxHold) {
        return { urgency: 'VERY_URGENT', reason: `Hold time ${holdHours.toFixed(1)}h >= max (${safeMaxHold}h)` };
    }

    // MODERATE: Should consider action
    if (pnl >= safeTp2) {
        return { urgency: 'MODERATE', reason: `P&L +${pnl.toFixed(1)}% in TP zone (${safeTp2}%-${safeTp4}%)` };
    }
    if (pnl <= -safeSl / 2) {
        return { urgency: 'MODERATE', reason: `P&L ${pnl.toFixed(1)}% approaching SL` };
    }
    if (holdHours >= safeMaxHold * 0.75) {
        return { urgency: 'MODERATE', reason: `Hold time ${holdHours.toFixed(1)}h approaching max` };
    }

    // LOW: No immediate action needed
    return { urgency: 'LOW', reason: 'Position within normal parameters' };
}

/**
 * Pre-Stage-2 check result
 */
interface PreStage2CheckResult {
    canRunStage2: boolean;
    reason: string;
    action: 'RUN_STAGE_2' | 'DIRECT_MANAGE' | 'LIGHTWEIGHT_DEBATE' | 'SKIP_CYCLE';
    urgentPosition?: PositionWithUrgency;
    allPositions?: PositionWithUrgency[];
    tokensSaved: number; // Estimated tokens saved by skipping/shortcutting
}

export class AutonomousTradingEngine extends EventEmitter {
    private isRunning = false;
    private isStarting = false; // Prevent concurrent starts
    private cleanupInProgress = false; // FIXED: Guard against concurrent cleanup
    private startLock: Promise<void> | null = null; // Mutex for start operation
    private cycleCount = 0;
    private totalDebatesRun = 0; // FIXED: Track cumulative debates across all cycles
    private totalTokensSaved = 0; // Track tokens saved by pre-Stage-2 optimization
    private consecutiveFailures = 0; // Track consecutive failures for backoff
    private readonly MAX_CONSECUTIVE_FAILURES = 10; // Circuit breaker threshold
    private analystStates = new Map<string, AnalystState>();
    private weexClient = getWeexClient();
    private currentCycle: TradingCycle | null = null;
    private mainLoopPromise: Promise<void> | null = null;
    private sleepTimeout: NodeJS.Timeout | null = null;

    // FIXED: Track contract specs refresh per engine instance
    private contractSpecsTracker = new ContractSpecsRefreshTracker();

    // FIXED: Track snapshot cleanup to prevent excessive database operations
    private lastSnapshotCleanup = 0;
    private snapshotFailureCount = 0;
    private readonly MAX_SNAPSHOT_FAILURES = 10;
    private readonly SNAPSHOT_CLEANUP_INTERVAL_MS = 3600000; // 1 hour

    // Weekly P&L caching to reduce database load
    private weeklyPnLCache: { value: { day: number; week: number }; timestamp: number } | null = null;
    private readonly WEEKLY_PNL_CACHE_MS = 60000; // 1 minute cache

    // Configuration from environment
    private readonly CYCLE_INTERVAL_MS = config.autonomous.cycleIntervalMs;
    private readonly MIN_TRADE_INTERVAL_MS = config.autonomous.minTradeIntervalMs;
    private readonly MAX_POSITION_SIZE_PERCENT = config.autonomous.maxPositionSizePercent;
    private readonly DEBATE_FREQUENCY = config.autonomous.debateFrequency;
    private readonly MAX_RETRIES = config.autonomous.maxRetries;
    private readonly MIN_BALANCE_TO_TRADE = config.autonomous.minBalanceToTrade;
    private readonly MIN_CONFIDENCE_TO_TRADE = config.autonomous.minConfidenceToTrade;
    private readonly DRY_RUN = config.autonomous.dryRun;

    constructor() {
        super();
        // Support multiple concurrent SSE connections (each adds 6 listeners)
        this.setMaxListeners(100);

        // Log configuration on startup
        logger.info('Autonomous Trading Engine Configuration:', {
            cycleIntervalMs: this.CYCLE_INTERVAL_MS,
            minTradeIntervalMs: this.MIN_TRADE_INTERVAL_MS,
            maxPositionSizePercent: this.MAX_POSITION_SIZE_PERCENT,
            debateFrequency: this.DEBATE_FREQUENCY,
            minConfidenceToTrade: this.MIN_CONFIDENCE_TO_TRADE,
            dryRun: this.DRY_RUN,
        });
    }

    /**
     * Execute fallback position management when limits are reached
     * Consolidates duplicated logic for max positions and directional limit fallbacks
     * 
     * @param positions - Array of positions to choose from for management
     * @param marketDataMap - Current market data for all symbols
     * @param fallbackReason - Reason for the fallback (for logging)
     * @returns true if management was executed, false if no positions available
     */
    private async executeFallbackManagement(
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            unrealizedPnl: number;
            unrealizedPnlPercent: number;
            holdTimeHours: number;
        }>,
        marketDataMap: Map<string, ExtendedMarketData>,
        fallbackReason: string
    ): Promise<{ executed: boolean; symbol?: string }> {
        // Sort by P&L: prioritize positions with P&L > +5% (take profits) or < -5% (cut losses)
        const sortedPositions = [...positions].sort((a, b) => {
            const aPnl = Number.isFinite(a.unrealizedPnlPercent) ? a.unrealizedPnlPercent : 0;
            const bPnl = Number.isFinite(b.unrealizedPnlPercent) ? b.unrealizedPnlPercent : 0;
            const aUrgent = Math.abs(aPnl) > 5;
            const bUrgent = Math.abs(bPnl) > 5;
            if (aUrgent && !bUrgent) return -1;
            if (!aUrgent && bUrgent) return 1;
            return Math.abs(bPnl) - Math.abs(aPnl);
        });

        const positionToManage = sortedPositions[0];
        if (!positionToManage) {
            logger.warn(`No positions available to auto-manage for ${fallbackReason}`);
            return { executed: false };
        }

        // FIXED: Update currentPrice from marketDataMap (position data may have stale/fallback price)
        // Also recalculate unrealizedPnl based on fresh price
        const marketData = marketDataMap.get(positionToManage.symbol);
        if (marketData && Number.isFinite(marketData.currentPrice) && marketData.currentPrice > 0) {
            const oldPrice = positionToManage.currentPrice;
            positionToManage.currentPrice = marketData.currentPrice;

            // Recalculate unrealizedPnl if price changed significantly
            if (Math.abs(oldPrice - marketData.currentPrice) > 0.0000001) {
                const priceDiff = positionToManage.side === 'LONG'
                    ? marketData.currentPrice - positionToManage.entryPrice
                    : positionToManage.entryPrice - marketData.currentPrice;
                positionToManage.unrealizedPnl = priceDiff * positionToManage.size;

                // Recalculate percent
                const openValue = positionToManage.size * positionToManage.entryPrice;
                positionToManage.unrealizedPnlPercent = openValue > 0
                    ? (positionToManage.unrealizedPnl / openValue) * 100
                    : 0;
            }
        }

        const pnlDisplay = Number.isFinite(positionToManage.unrealizedPnlPercent) ? positionToManage.unrealizedPnlPercent : 0;
        const pnlDollarDisplay = Number.isFinite(positionToManage.unrealizedPnl) ? positionToManage.unrealizedPnl : 0;
        logger.info(`📋 Auto-managing: ${positionToManage.symbol} ${positionToManage.side} (P&L: ${pnlDisplay.toFixed(2)}% / $${pnlDollarDisplay.toFixed(2)})`);
        logger.info(`   Entry: ${positionToManage.entryPrice}, Current: ${positionToManage.currentPrice}`);
        try {
            const managementDecision = await collaborativeFlowService.runPositionManagement(
                positionToManage,
                marketDataMap
            );

            if (managementDecision && managementDecision.manageType) {
                const { manageType, conviction, reason, closePercent, newStopLoss, newTakeProfit } = managementDecision;
                logger.info(`📋 Management Decision: ${manageType} (conviction: ${conviction}/10)`);
                logger.info(`Reason: ${reason}`);

                if (!config.autonomous.dryRun) {
                    try {
                        // Pre-fetch plan orders once for TIGHTEN_STOP and ADJUST_TP to avoid duplicate API calls
                        let existingPlanOrders: any[] = [];
                        if (manageType === 'TIGHTEN_STOP' || manageType === 'ADJUST_TP') {
                            try {
                                existingPlanOrders = await this.weexClient.getCurrentPlanOrders(positionToManage.symbol);
                            } catch (planOrderErr) {
                                logger.warn(`Failed to fetch plan orders for ${positionToManage.symbol}:`, planOrderErr);
                                // Continue - we'll place new orders instead of modifying
                            }
                        }

                        // Fetch fresh position size for order placement (position may have changed)
                        let currentPositionSize = positionToManage.size;
                        if (manageType === 'TIGHTEN_STOP' || manageType === 'ADJUST_TP') {
                            try {
                                const freshPosition = await this.weexClient.getPosition(positionToManage.symbol);
                                if (freshPosition) {
                                    const parsedSize = parseFloat(String(freshPosition.size));
                                    if (Number.isFinite(parsedSize) && parsedSize > 0) {
                                        currentPositionSize = parsedSize;
                                    }
                                }
                            } catch (posErr) {
                                logger.warn(`Failed to fetch fresh position size, using cached: ${positionToManage.size}`);
                            }
                        }

                        switch (manageType) {
                            case 'CLOSE_FULL':
                                await this.weexClient.closeAllPositions(positionToManage.symbol);
                                logger.info(`✅ Closed full position: ${positionToManage.symbol}`);
                                break;
                            case 'CLOSE_PARTIAL':
                            case 'TAKE_PARTIAL':
                                if (closePercent && closePercent > 0 && closePercent < 100) {
                                    const sizeToClose = roundToStepSize(
                                        (positionToManage.size * closePercent) / 100,
                                        positionToManage.symbol
                                    );
                                    await this.weexClient.closePartialPosition(
                                        positionToManage.symbol,
                                        positionToManage.side,
                                        sizeToClose,
                                        '1'
                                    );
                                    logger.info(`✅ Closed ${closePercent}% of ${positionToManage.symbol}`);
                                }
                                break;
                            case 'TIGHTEN_STOP':
                                if (newStopLoss && Number.isFinite(newStopLoss) && newStopLoss > 0) {
                                    // Validate stop loss direction
                                    // For LONG: SL must be below current price
                                    // For SHORT: SL must be above current price
                                    const isValidDirection = positionToManage.side === 'LONG'
                                        ? newStopLoss < positionToManage.currentPrice
                                        : newStopLoss > positionToManage.currentPrice;

                                    if (!isValidDirection) {
                                        logger.warn(`⚠️ Invalid stop loss direction for ${positionToManage.side}: SL=${newStopLoss} vs current=${positionToManage.currentPrice}`);
                                        break;
                                    }

                                    // Find existing stop loss order from pre-fetched orders
                                    const stopLossOrder = existingPlanOrders.find((o: any) =>
                                        (o.planType === 'loss_plan' || o.plan_type === 'loss_plan') &&
                                        (o.positionSide === positionToManage.side.toLowerCase() ||
                                            o.position_side === positionToManage.side.toLowerCase())
                                    );

                                    if (stopLossOrder && (stopLossOrder.orderId || stopLossOrder.order_id)) {
                                        // Modify existing stop loss
                                        const orderId = String(stopLossOrder.orderId || stopLossOrder.order_id);
                                        await this.weexClient.modifyTpSlOrder({
                                            orderId,
                                            triggerPrice: newStopLoss,
                                            executePrice: 0,
                                        });
                                        logger.info(`✅ Modified stop loss to ${newStopLoss}`);
                                    } else {
                                        // Place new stop loss with fresh position size
                                        await this.weexClient.placeTpSlOrder({
                                            symbol: positionToManage.symbol,
                                            planType: 'loss_plan',
                                            triggerPrice: newStopLoss,
                                            size: currentPositionSize,
                                            positionSide: positionToManage.side.toLowerCase() as 'long' | 'short',
                                        });
                                        logger.info(`✅ Placed new stop loss at ${newStopLoss}`);
                                    }
                                } else {
                                    logger.warn(`⚠️ TIGHTEN_STOP requires valid newStopLoss, got: ${newStopLoss}`);
                                }
                                break;
                            case 'ADJUST_TP':
                                if (newTakeProfit && Number.isFinite(newTakeProfit) && newTakeProfit > 0) {
                                    // Validate take profit direction
                                    const isValidTPDirection = positionToManage.side === 'LONG'
                                        ? newTakeProfit > positionToManage.currentPrice
                                        : newTakeProfit < positionToManage.currentPrice;

                                    if (!isValidTPDirection) {
                                        logger.warn(`⚠️ Invalid take profit direction for ${positionToManage.side}: ${newTakeProfit} vs current ${positionToManage.currentPrice}`);
                                        break;
                                    }

                                    // Find existing take profit order from pre-fetched orders
                                    const takeProfitOrder = existingPlanOrders.find((o: any) =>
                                        (o.planType === 'profit_plan' || o.plan_type === 'profit_plan') &&
                                        (o.positionSide === positionToManage.side.toLowerCase() ||
                                            o.position_side === positionToManage.side.toLowerCase())
                                    );

                                    if (takeProfitOrder && (takeProfitOrder.orderId || takeProfitOrder.order_id)) {
                                        // Modify existing take profit
                                        const orderId = String(takeProfitOrder.orderId || takeProfitOrder.order_id);
                                        await this.weexClient.modifyTpSlOrder({
                                            orderId,
                                            triggerPrice: newTakeProfit,
                                            executePrice: 0,
                                        });
                                        logger.info(`✅ Modified take profit to ${newTakeProfit}`);
                                    } else {
                                        // Place new take profit with fresh position size
                                        await this.weexClient.placeTpSlOrder({
                                            symbol: positionToManage.symbol,
                                            planType: 'profit_plan',
                                            triggerPrice: newTakeProfit,
                                            size: currentPositionSize,
                                            positionSide: positionToManage.side.toLowerCase() as 'long' | 'short',
                                        });
                                        logger.info(`✅ Placed new take profit at ${newTakeProfit}`);
                                    }
                                } else {
                                    logger.warn(`⚠️ ADJUST_TP requires valid newTakeProfit, got: ${newTakeProfit}`);
                                }
                                break;
                            case 'ADD_MARGIN':
                                // ADD_MARGIN is rarely used and requires careful handling
                                logger.info(`ℹ️ ADD_MARGIN action noted but not auto-executed in fallback mode`);
                                break;
                            default:
                                logger.warn(`⚠️ Unknown management action: ${manageType}`);
                        }

                        // Record the management trade to database (for CLOSE actions)
                        if (manageType === 'CLOSE_FULL' || manageType === 'CLOSE_PARTIAL' || manageType === 'TAKE_PARTIAL') {
                            try {
                                // Find original champion who opened this position
                                let originalChampionId: string | null = null;
                                try {
                                    const originalTrade = await prisma.trade.findFirst({
                                        where: {
                                            symbol: positionToManage.symbol,
                                            status: 'FILLED',
                                            realizedPnl: null, // Entry trade
                                            side: positionToManage.side === 'LONG' ? 'BUY' : 'SELL'
                                        },
                                        orderBy: { executedAt: 'desc' },
                                        select: { championId: true }
                                    });
                                    originalChampionId = originalTrade?.championId || null;
                                } catch {
                                    originalChampionId = null;
                                }

                                // Calculate size and P&L for the trade record
                                // CRITICAL: Sanitize all numeric values to prevent NaN/undefined issues
                                let loggedSize = Number.isFinite(positionToManage.size) ? positionToManage.size : 0;
                                let loggedPnl = Number.isFinite(positionToManage.unrealizedPnl) ? positionToManage.unrealizedPnl : 0;

                                if ((manageType === 'CLOSE_PARTIAL' || manageType === 'TAKE_PARTIAL') && closePercent && closePercent > 0) {
                                    loggedSize = Number.isFinite(loggedSize) ? (loggedSize * closePercent) / 100 : 0;
                                    loggedPnl = Number.isFinite(loggedPnl) ? (loggedPnl * closePercent) / 100 : 0;
                                }

                                // Final validation - ensure values are finite
                                if (!Number.isFinite(loggedSize)) loggedSize = 0;
                                if (!Number.isFinite(loggedPnl)) loggedPnl = 0;

                                // Get collaborative portfolio ID - MUST be a valid UUID from DB
                                const firstAnalyst = this.analystStates.values().next().value;
                                let portfolioId = firstAnalyst?.portfolioId;

                                // If no portfolioId from analyst state, fetch from DB
                                if (!portfolioId) {
                                    const collabPortfolio = await prisma.portfolio.findFirst({
                                        where: { agentId: 'collaborative' },
                                        select: { id: true }
                                    });
                                    if (!collabPortfolio) {
                                        logger.error('Cannot record fallback trade: collaborative portfolio not found in DB');
                                        return { executed: true, symbol: positionToManage.symbol };
                                    }
                                    portfolioId = collabPortfolio.id;
                                }

                                const tradeId = crypto.randomUUID();
                                await prisma.trade.create({
                                    data: {
                                        id: tradeId,
                                        portfolioId: portfolioId,
                                        symbol: positionToManage.symbol,
                                        side: positionToManage.side === 'LONG' ? 'SELL' : 'BUY',
                                        type: 'MARKET',
                                        size: loggedSize,
                                        price: positionToManage.currentPrice,
                                        status: 'FILLED',
                                        reason: `FALLBACK: ${manageType} - ${fallbackReason}`,
                                        championId: originalChampionId,
                                        realizedPnl: loggedPnl,
                                        executedAt: new Date(),
                                        createdAt: new Date()
                                    }
                                });
                                logger.info(`📊 Recorded fallback trade: ${positionToManage.symbol} P&L: ${loggedPnl.toFixed(2)} (${originalChampionId})`);
                            } catch (dbError) {
                                logger.error('Failed to record fallback management trade:', dbError);
                            }
                        }

                        if (this.currentCycle) {
                            this.currentCycle.tradesExecuted++;
                        }
                    } catch (execError) {
                        logger.error(`Failed to execute management action:`, execError);
                    }
                } else {
                    logger.info(`[DRY RUN] Would execute ${manageType} on ${positionToManage.symbol}`);
                }
            }
        } catch (manageError) {
            logger.error(`Failed to get management decision:`, manageError);
        }

        return { executed: true, symbol: positionToManage.symbol };
    }

    /**
     * PRE-STAGE-2 OPTIMIZATION: Check if we can skip the expensive Stage 2 debate
     * 
     * This method runs BEFORE Stage 2 to save ~8000 tokens when:
     * - Balance is too low to trade
     * - Weekly drawdown limit exceeded
     * - Max positions reached with no urgent management needed
     * 
     * @returns Decision on whether to run Stage 2, skip, or go direct to manage
     */
    private async runPreStage2Checks(): Promise<PreStage2CheckResult> {
        const TOKENS_FULL_DEBATE = 8000;
        const TOKENS_LIGHTWEIGHT = 3000;
        const TOKENS_DIRECT = 500;

        // =====================================================================
        // CHECK 1: BALANCE
        // =====================================================================
        let currentBalance: number;
        try {
            const assets = await this.weexClient.getAccountAssets();
            currentBalance = parseFloat(assets.available || '0');
        } catch (error) {
            logger.warn('Failed to fetch balance for pre-check, continuing to Stage 2');
            return { canRunStage2: true, reason: 'Balance check failed', action: 'RUN_STAGE_2', tokensSaved: 0 };
        }

        if (!Number.isFinite(currentBalance) || currentBalance < config.autonomous.minBalanceToTrade) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`💰 PRE-CHECK: Insufficient balance ($${currentBalance?.toFixed(2) || 'N/A'} < $${config.autonomous.minBalanceToTrade})`);
            logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_DEBATE} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Insufficient balance: $${currentBalance?.toFixed(2) || 'N/A'}`,
                action: 'SKIP_CYCLE',
                tokensSaved: TOKENS_FULL_DEBATE
            };
        }

        // =====================================================================
        // CHECK 2: WEEKLY DRAWDOWN
        // =====================================================================
        const weeklyPnL = await this.getRecentPnLCached();
        if (weeklyPnL && Number.isFinite(weeklyPnL.week) && weeklyPnL.week < -RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`📉 PRE-CHECK: Weekly drawdown exceeded (${weeklyPnL.week.toFixed(1)}% < -${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}%)`);
            logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_DEBATE} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Weekly drawdown: ${weeklyPnL.week.toFixed(1)}%`,
                action: 'SKIP_CYCLE',
                tokensSaved: TOKENS_FULL_DEBATE
            };
        }

        // =====================================================================
        // CHECK 3: POSITION LIMITS
        // =====================================================================
        let positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            unrealizedPnl: number;
            unrealizedPnlPercent: number;
            holdTimeHours: number;
        }>;

        try {
            const weexPositions = await this.weexClient.getPositions();
            const activePositions = weexPositions.filter(pos => parseFloat(String(pos.size)) > 0);

            // Fetch hold times from database (same logic as main loop)
            const holdTimes = new Map<string, number>();
            if (activePositions.length > 0) {
                try {
                    const holdTimeResult = await prisma.$queryRaw<Array<{ symbol: string; side: string; max_executed_at: string }>>`
                        SELECT symbol, side, MAX(executed_at) as max_executed_at
                        FROM trades
                        WHERE symbol IN (${Prisma.join(activePositions.map(p => p.symbol))})
                            AND status = 'FILLED'
                            AND executed_at IS NOT NULL
                            AND side IN ('BUY', 'SELL')
                            AND (reason IS NULL OR reason NOT LIKE 'MANAGE:%')
                        GROUP BY symbol, side
                    `;

                    for (const row of holdTimeResult) {
                        if (row.max_executed_at) {
                            const parsed = new Date(row.max_executed_at);
                            if (isNaN(parsed.getTime())) continue;
                            const entryTime = parsed.getTime();
                            if (entryTime > Date.now()) continue;

                            const matchingPos = activePositions.find(p => p.symbol === row.symbol);
                            if (matchingPos) {
                                const posIsLong = matchingPos.side?.toUpperCase().includes('LONG');
                                const tradeIsBuy = row.side === 'BUY';
                                if ((posIsLong && tradeIsBuy) || (!posIsLong && !tradeIsBuy)) {
                                    const holdMs = Math.max(0, Date.now() - entryTime);
                                    const holdHours = holdMs / (1000 * 60 * 60);
                                    if (Number.isFinite(holdHours) && holdHours >= 0) {
                                        holdTimes.set(row.symbol, holdHours);
                                    }
                                }
                            }
                        }
                    }
                } catch (dbErr) {
                    logger.debug('Failed to fetch hold times for pre-check, using defaults');
                }
            }

            positions = activePositions.map(pos => {
                const size = parseFloat(String(pos.size)) || 0;
                const openValue = parseFloat(String(pos.openValue)) || 0;
                const entryPrice = pos.entryPrice || (size > 0 ? openValue / size : 0);
                const unrealizedPnl = parseFloat(String(pos.unrealizePnl)) || 0;
                const unrealizedPnlPercent = openValue > 0 ? (unrealizedPnl / openValue) * 100 : 0;

                // Derive currentPrice from unrealizedPnl
                const isLong = pos.side?.toUpperCase().includes('LONG');
                let currentPrice = entryPrice;
                if (size > 0 && entryPrice > 0 && Number.isFinite(unrealizedPnl)) {
                    const pnlPerUnit = unrealizedPnl / size;
                    currentPrice = isLong ? entryPrice + pnlPerUnit : entryPrice - pnlPerUnit;
                    if (currentPrice <= 0 || !Number.isFinite(currentPrice)) {
                        currentPrice = entryPrice;
                    }
                }

                // Use actual hold time from DB, fallback to 0 (conservative - won't trigger time-based urgency)
                const holdTimeHours = holdTimes.get(pos.symbol) ?? 0;

                return {
                    symbol: pos.symbol,
                    side: (isLong ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
                    size,
                    entryPrice,
                    currentPrice,
                    unrealizedPnl,
                    unrealizedPnlPercent,
                    holdTimeHours
                };
            });
        } catch (error) {
            logger.warn('Failed to fetch positions for pre-check, continuing to Stage 2');
            return { canRunStage2: true, reason: 'Position check failed', action: 'RUN_STAGE_2', tokensSaved: 0 };
        }

        const MAX_POSITIONS = RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS;
        const MAX_SAME_DIR = RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS;

        // Count positions by direction
        const longCount = positions.filter(p => p.side === 'LONG').length;
        const shortCount = positions.filter(p => p.side === 'SHORT').length;

        // Check if we're at max positions
        const atMaxPositions = positions.length >= MAX_POSITIONS;
        const atMaxLong = longCount >= MAX_SAME_DIR;
        const atMaxShort = shortCount >= MAX_SAME_DIR;
        const bothDirectionsBlocked = atMaxLong && atMaxShort;

        // If not at max positions total
        if (!atMaxPositions) {
            // If both directions blocked, we can't trade - fall through to urgency check
            if (bothDirectionsBlocked) {
                logger.info(`📊 PRE-CHECK: Both directions blocked (LONG: ${longCount}/${MAX_SAME_DIR}, SHORT: ${shortCount}/${MAX_SAME_DIR})`);
                // Fall through to urgency check below
            } else {
                // At least one direction available - run full Stage 2
                const availableDir = atMaxLong ? 'SHORT only' : (atMaxShort ? 'LONG only' : 'both directions');
                logger.debug(`📊 PRE-CHECK: Can trade ${availableDir}`);
                return { canRunStage2: true, reason: `Within limits, ${availableDir} available`, action: 'RUN_STAGE_2', tokensSaved: 0 };
            }
        }

        // =====================================================================
        // CHECK 4: URGENCY OF EXISTING POSITIONS
        // At this point, we can't open new trades. Check if any position needs management.
        // =====================================================================
        const positionsWithUrgency: PositionWithUrgency[] = positions.map(pos => {
            const { urgency, reason } = calculatePositionUrgency(pos);
            return { ...pos, urgency, urgencyReason: reason };
        });

        // Sort by urgency: VERY_URGENT first, then MODERATE, then LOW
        const urgencyOrder: Record<PositionUrgency, number> = { 'VERY_URGENT': 0, 'MODERATE': 1, 'LOW': 2 };
        positionsWithUrgency.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

        const veryUrgent = positionsWithUrgency.filter(p => p.urgency === 'VERY_URGENT');
        const moderate = positionsWithUrgency.filter(p => p.urgency === 'MODERATE');

        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`📊 PRE-CHECK: Position limits reached (${positions.length}/${MAX_POSITIONS})`);
        logger.info(`   LONG: ${longCount}/${MAX_SAME_DIR}, SHORT: ${shortCount}/${MAX_SAME_DIR}`);
        logger.info(`   Urgency: ${veryUrgent.length} VERY_URGENT, ${moderate.length} MODERATE, ${positionsWithUrgency.length - veryUrgent.length - moderate.length} LOW`);

        if (veryUrgent.length > 0) {
            // VERY URGENT: Go direct to Karen (skip debate entirely)
            const urgent = veryUrgent[0];
            logger.info(`🚨 VERY URGENT: ${urgent.symbol} - ${urgent.urgencyReason}`);
            logger.info(`🎯 ACTION: DIRECT MANAGE (saving ~${TOKENS_FULL_DEBATE - TOKENS_DIRECT} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Very urgent: ${urgent.urgencyReason}`,
                action: 'DIRECT_MANAGE',
                urgentPosition: urgent,
                allPositions: positionsWithUrgency,
                tokensSaved: TOKENS_FULL_DEBATE - TOKENS_DIRECT
            };
        }

        if (moderate.length > 0) {
            // MODERATE: Run lightweight debate (2-3 analysts instead of 8)
            const mod = moderate[0];
            logger.info(`⚠️ MODERATE: ${mod.symbol} - ${mod.urgencyReason}`);
            logger.info(`🎯 ACTION: LIGHTWEIGHT MANAGE DEBATE (saving ~${TOKENS_FULL_DEBATE - TOKENS_LIGHTWEIGHT} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Moderate urgency: ${mod.urgencyReason}`,
                action: 'LIGHTWEIGHT_DEBATE',
                urgentPosition: mod,
                allPositions: positionsWithUrgency,
                tokensSaved: TOKENS_FULL_DEBATE - TOKENS_LIGHTWEIGHT
            };
        }

        // All positions are LOW urgency - skip cycle entirely
        logger.info(`✅ All positions LOW urgency - nothing to do`);
        logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_DEBATE} tokens)`);
        logger.info(`${'='.repeat(60)}\n`);
        return {
            canRunStage2: false,
            reason: 'At limits, no urgent positions',
            action: 'SKIP_CYCLE',
            allPositions: positionsWithUrgency,
            tokensSaved: TOKENS_FULL_DEBATE
        };
    }

    /**
     * Start the autonomous trading engine
     * Uses a promise-based mutex to ensure only one start operation at a time
     */
    async start(): Promise<void> {
        // Wait for any in-progress start operation to complete (mutex pattern)
        if (this.startLock) {
            logger.info('Another start operation in progress, waiting...');
            try {
                await this.startLock;
            } catch {
                // Ignore errors from previous start attempt
            }
        }

        // After waiting, check if engine is already running
        if (this.isRunning) {
            logger.warn('Autonomous trading engine already running');
            return;
        }

        // Acquire the lock by creating a new promise
        let releaseLock: () => void;
        this.startLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });

        try {
            // Double-check isStarting after acquiring lock (atomic check-and-set)
            if (this.isStarting) {
                logger.warn('Start operation already in progress after lock acquisition');
                return;
            }

            this.isStarting = true;

            // If a previous loop is still cleaning up, wait for cleanup to finish
            if (this.mainLoopPromise) {
                logger.warn('Previous engine loop detected. Performing cleanup before restart...');
                await this.cleanup();
            }

            try {
                logger.info('🏟️ Starting Autonomous Trading Engine (Collaborative Mode)...');

                // Fetch and cache contract specifications from WEEX with retry logic
                logger.info('📋 Fetching contract specifications from WEEX...');
                const weexClient = getWeexClient();

                let contracts: any[] = [];
                let lastError: Error = new Error('No error captured while fetching contracts');
                const MAX_CONTRACT_FETCH_RETRIES = 3;

                for (let attempt = 1; attempt <= MAX_CONTRACT_FETCH_RETRIES; attempt++) {
                    try {
                        contracts = await weexClient.getContracts();
                        if (contracts && contracts.length > 0) {
                            break; // Success
                        } else {
                            throw new Error('WEEX returned empty contracts array');
                        }
                    } catch (error) {
                        lastError = error as Error;
                        logger.error(`Failed to fetch contracts (attempt ${attempt}/${MAX_CONTRACT_FETCH_RETRIES}):`, error);

                        if (attempt < MAX_CONTRACT_FETCH_RETRIES) {
                            const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                            logger.info(`Retrying in ${backoffMs}ms...`);
                            await new Promise(resolve => setTimeout(resolve, backoffMs));
                        }
                    }
                }

                if (!contracts || contracts.length === 0) {
                    const errorDetails = lastError.stack || lastError.message;
                    throw new Error(`Failed to fetch contract specifications after ${MAX_CONTRACT_FETCH_RETRIES} attempts. Last error: ${errorDetails}`);
                }

                // Update contract specs cache (will throw if parsing fails)
                try {
                    updateContractSpecs(contracts);
                } catch (error) {
                    logger.error('Failed to parse contract specifications:', error);
                    throw new Error(`Cannot start engine without valid contract specifications: ${(error as Error).message}`);
                }

                // Initialize analyst portfolios
                await this.initializeAnalysts();

                if (this.analystStates.size === 0) {
                    throw new Error('Failed to initialize any analysts');
                }

                this.isRunning = true;
                this.emit('started');

                // Start the main loop
                this.mainLoopPromise = this.runMainLoop().catch(err => {
                    logger.error('Fatal error in trading engine:', err);
                    this.stop();
                });

            } catch (error) {
                logger.error('Failed to start engine:', error);
                this.isRunning = false;
                throw error;
            }
        } finally {
            this.isStarting = false;
            // Release the lock
            releaseLock!();
            this.startLock = null;
        }
    }

    /**
     * Stop the autonomous trading engine
     */
    stop(): void {
        if (!this.isRunning) return;

        logger.info('🛑 Stopping Autonomous Trading Engine...');
        this.isRunning = false;

        // Clear any pending sleep timeout to prevent memory leak
        if (this.sleepTimeout) {
            clearTimeout(this.sleepTimeout);
            this.sleepTimeout = null;
        }

        this.emit('stopped');
    }

    /**
     * Complete the current cycle with proper cleanup
     * FIXED: Update analyst portfolios after each cycle to keep P&L attribution current
     */
    private async completeCycle(cycleStart: number, reason: string): Promise<void> {
        if (!this.currentCycle) return;

        this.currentCycle.endTime = Date.now();
        const cycleDuration = this.currentCycle.endTime - cycleStart;

        // FIXED: Accumulate total debates across all cycles for frontend display
        this.totalDebatesRun += this.currentCycle.debatesRun;

        logger.info(`✅ Cycle #${this.cycleCount} complete (${reason}): ${this.currentCycle.tradesExecuted} trades, ${this.currentCycle.debatesRun} debates (${(cycleDuration / 1000).toFixed(1)}s)`);

        // Update analyst virtual portfolios with latest P&L attribution
        // Only update if trades were executed this cycle
        if (this.currentCycle.tradesExecuted > 0) {
            try {
                await AnalystPortfolioService.updateAnalystPortfolios();
            } catch (error) {
                logger.error('Failed to update analyst portfolios:', error);
                // Don't throw - cycle is complete, this is just attribution
            }
        }

        this.emit('cycleComplete', this.currentCycle);
    }

    /**
     * Calculate sleep time with exponential backoff for consecutive failures
     */
    private getSleepTimeWithBackoff(cycleStart: number): number {
        const elapsed = Date.now() - cycleStart;
        const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
        let sleepTime = Math.max(0, dynamicInterval - elapsed);

        // Apply exponential backoff for consecutive failures (max 4x normal interval)
        if (this.consecutiveFailures > 0) {
            const backoffMultiplier = Math.min(4, Math.pow(1.5, this.consecutiveFailures));
            sleepTime = Math.min(sleepTime * backoffMultiplier, this.CYCLE_INTERVAL_MS * 4);
            logger.warn(`Applying backoff (${this.consecutiveFailures} consecutive failures): sleeping ${(sleepTime / 1000).toFixed(0)}s`);
        }

        return sleepTime;
    }

    /**
     * Get current status
     */
    getStatus() {
        // COLLABORATIVE MODE: All analysts share ONE portfolio
        // Use first analyst's state as the shared portfolio reference
        const firstAnalyst = this.analystStates.values().next().value;
        const sharedBalance = firstAnalyst?.balance || 0;
        const sharedPositions = firstAnalyst?.positions || [];
        const sharedTotalTrades = firstAnalyst?.totalTrades || 0;

        // Build analyst display data - all share same balance in collaborative mode
        const analysts = Array.from(this.analystStates.values()).map(state => ({
            ...state,
            balance: sharedBalance,
            totalValue: sharedBalance,
        }));

        return {
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            dryRun: config.autonomous.dryRun,
            analysts,
            currentCycle: this.currentCycle,
            // FIXED: Include totalDebatesRun for frontend display
            totalDebatesRun: this.totalDebatesRun,
            totalTokensSaved: this.totalTokensSaved, // Pre-Stage-2 optimization savings
            sharedPortfolio: {
                balance: sharedBalance,
                totalTrades: sharedTotalTrades,
                positionCount: sharedPositions.length,
            },
            stats: {
                totalTrades: sharedTotalTrades,
                tradesThisCycle: this.currentCycle?.tradesExecuted || 0,
                totalDebates: this.totalDebatesRun, // Also in stats for backward compat
                tokensSaved: this.totalTokensSaved, // Also in stats
                avgCycleTime: this.CYCLE_INTERVAL_MS,
            },
            // FIXED: Calculate nextCycleIn based on cycle state
            // If cycle is complete (has endTime), calculate from endTime
            // If cycle is in progress, calculate from startTime
            nextCycleIn: this.currentCycle
                ? (this.currentCycle.endTime
                    ? Math.max(0, this.CYCLE_INTERVAL_MS - (Date.now() - this.currentCycle.endTime))
                    : Math.max(0, this.CYCLE_INTERVAL_MS - (Date.now() - this.currentCycle.startTime)))
                : this.CYCLE_INTERVAL_MS,
        };
    }

    /**
     * Initialize ONE shared collaborative portfolio for all 4 analysts
     * COLLABORATIVE MODE: All analysts share a single portfolio per FLOW.md
     * Balance is ALWAYS fetched from WEEX wallet, not stored in database
     * 
     * EDGE CASES HANDLED:
     * - WEEX API failures with graceful degradation
     * - Database connection errors
     */
    private async initializeAnalysts(): Promise<void> {
        logger.info('Initializing collaborative portfolio (4 analysts, 1 shared portfolio)...');

        try {
            // Get actual wallet balance from WEEX
            let walletBalance: number;
            try {
                const assets = await this.weexClient.getAccountAssets();
                walletBalance = parseFloat(assets.available || '0');
                if (!Number.isFinite(walletBalance) || walletBalance < 0) {
                    logger.warn(`Invalid wallet balance from WEEX: ${walletBalance}, using 0`);
                    walletBalance = 0;
                }
            } catch (error) {
                logger.error('Failed to fetch wallet balance from WEEX:', error);
                walletBalance = 0;
            }

            // Check if collaborative portfolio record exists (for tracking trades/stats only)
            const existing = await prisma.portfolio.findUnique({
                where: { agentId: 'collaborative' },
                select: { id: true, totalTrades: true, winRate: true }
            });

            let portfolioId: string;
            let totalTrades: number;
            let winRate: number;

            if (existing) {
                portfolioId = existing.id;
                totalTrades = existing.totalTrades;
                winRate = existing.winRate;

                // Update the database balance to match wallet (for display purposes only)
                await prisma.portfolio.update({
                    where: { id: portfolioId },
                    data: {
                        currentBalance: walletBalance,
                        updatedAt: new Date()
                    }
                });

                logger.info(`📊 Collaborative Portfolio: Existing (${walletBalance.toFixed(2)} USDT from wallet, ${totalTrades} trades)`);
            } else {
                // Create new portfolio record
                // Note: agentId='collaborative' has UNIQUE constraint in schema to prevent race conditions
                try {
                    const newPortfolio = await prisma.portfolio.create({
                        data: {
                            agentId: 'collaborative',
                            agentName: 'Collaborative AI Team',
                            initialBalance: walletBalance,
                            currentBalance: walletBalance,
                            status: 'active'
                        }
                    });

                    portfolioId = newPortfolio.id;
                    totalTrades = 0;
                    winRate = 0;
                } catch (error: any) {
                    // Handle race condition: another instance created the portfolio
                    // Check for Prisma unique constraint violation (P2002)
                    if (error?.code === 'P2002') {
                        logger.warn('Portfolio creation race condition detected, fetching existing portfolio');
                        const result = await prisma.portfolio.findUnique({
                            where: { agentId: 'collaborative' },
                            select: { id: true, totalTrades: true, winRate: true }
                        });
                        if (!result) throw new Error('Portfolio not found after race condition');
                        portfolioId = result.id;
                        totalTrades = result.totalTrades;
                        winRate = result.winRate;
                    } else {
                        throw error;
                    }
                }
                logger.info(`📊 Collaborative Portfolio: Created new (${walletBalance.toFixed(2)} USDT from wallet)`);
            }

            // FIXED: Initialize analyst virtual portfolios for P&L attribution
            // Each analyst gets a virtual portfolio to track their debate wins
            await AnalystPortfolioService.initializeAnalystPortfolios();

            // Get current positions from WEEX (shared across all analysts)
            let positions: AnalystState['positions'] = [];
            for (let retry = 0; retry < this.MAX_RETRIES; retry++) {
                try {
                    positions = await this.getAnalystPositions();
                    break;
                } catch (error) {
                    if (retry === this.MAX_RETRIES - 1) {
                        logger.warn(`Collaborative portfolio: Failed to fetch positions after ${this.MAX_RETRIES} retries`, {
                            error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
                        });
                    } else {
                        await this.sleep(1000 * (retry + 1));
                    }
                }
            }

            // Initialize all 4 analysts with the SAME shared portfolio
            // Balance comes from WEEX wallet, not database
            for (const analystId of ANALYST_IDS) {
                const profile = Object.values(ANALYST_PROFILES).find(a => a.id === analystId);

                this.analystStates.set(analystId, {
                    analystId,
                    portfolioId,
                    balance: walletBalance, // Always from WEEX wallet
                    positions,
                    lastTradeTime: 0,
                    totalTrades,
                    winRate,
                });

                logger.info(`  📈 ${analystId}: ${profile?.name || analystId} (collaborative)`);
            }

            logger.info(`📊 Collaborative portfolio initialized: 4 analysts sharing ${walletBalance.toFixed(2)} USDT`);

        } catch (error) {
            logger.error('Failed to initialize collaborative portfolio:', error);
            throw error;
        }
    }

    /**
     * Main trading loop
     */
    private async runMainLoop(): Promise<void> {
        while (this.isRunning) {
            this.cycleCount++;
            const cycleStart = Date.now();

            this.currentCycle = {
                cycleNumber: this.cycleCount,
                startTime: cycleStart,
                symbolsAnalyzed: [],
                tradesExecuted: 0,
                debatesRun: 0,
                errors: [],
            };

            // Log market conditions
            tradingScheduler.logMarketConditions();
            const tradingStatus = tradingScheduler.shouldTradeNow();

            logger.info(`\n🔄 Cycle #${this.cycleCount} starting... (${tradingStatus.reason})`);
            this.emit('cycleStart', { cycleNumber: this.cycleCount });

            try {
                // Run the unified cycle - Stage 2 now handles both new trades AND position management
                await this.runEntryCycle(cycleStart);

                // Sleep before next cycle
                const elapsed = Date.now() - cycleStart;
                const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
                const sleepTime = Math.max(0, dynamicInterval - elapsed);

                if (sleepTime > 0 && this.isRunning) {
                    const nextPeak = tradingScheduler.getTimeUntilPeakTrading();
                    logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle... (Next peak: ${nextPeak.hours}h ${nextPeak.minutes}m)`);
                    await this.sleep(sleepTime);
                }
            } catch (error) {
                logger.error('Error in cycle:', error);
                this.currentCycle?.errors.push(error instanceof Error ? error.message : String(error));
                this.consecutiveFailures++;

                // CRITICAL: Circuit breaker - stop engine after too many consecutive failures
                if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                    logger.error(`🚨 CIRCUIT BREAKER: ${this.consecutiveFailures} consecutive failures, stopping engine`);
                    this.stop();
                    break;
                }

                // Sleep with backoff
                const sleepTime = this.getSleepTimeWithBackoff(Date.now() - cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            }
        }

        logger.info('Main loop exited');
    }

    /**
     * Run entry cycle - find and execute new trades
     */
    private async runEntryCycle(cycleStart: number): Promise<void> {
        // =================================================================
        // PRE-CYCLE: REFRESH CONTRACT SPECS IF STALE
        // =================================================================
        await this.refreshContractSpecsIfNeeded();

        // =================================================================
        // STAGE 1: MARKET SCAN - Fetch data for all 8 coins
        // =================================================================
        const marketDataMap = await this.fetchAllMarketData();

        if (marketDataMap.size === 0) {
            logger.warn('No market data available, skipping cycle');
            if (this.currentCycle) {
                this.currentCycle.errors.push('No market data available');
            }

            // Mark cycle as complete before skipping
            if (this.currentCycle) {
                this.currentCycle.endTime = Date.now();
                const cycleDuration = this.currentCycle.endTime - cycleStart;
                logger.info(`✅ Cycle #${this.cycleCount} complete (no data): 0 trades, 0 debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                this.emit('cycleComplete', this.currentCycle);
            }

            // Sleep before next cycle
            const elapsed = Date.now() - cycleStart;
            const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
            const sleepTime = Math.max(0, dynamicInterval - elapsed);

            if (sleepTime > 0 && this.isRunning) {
                logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle...`);
                await this.sleep(sleepTime);
            }
            return;
        }

        // =================================================================
        // CIRCUIT BREAKER CHECK
        // =================================================================
        const btcData = marketDataMap.get('cmt_btcusdt');
        if (btcData) {
            const circuitBreakerStatus = await circuitBreakerService.checkCircuitBreakers();

            if (circuitBreakerStatus.level === 'RED') {
                logger.error(`🚨 RED ALERT: ${circuitBreakerStatus.reason}`);
                logger.error(`Action: ${circuitBreakerService.getRecommendedAction('RED')}`);
                await this.emergencyCloseAllPositions();
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`RED ALERT: ${circuitBreakerStatus.reason} - All positions closed`);
                }

                // Mark cycle as complete and sleep
                if (this.currentCycle) {
                    this.currentCycle.endTime = Date.now();
                    const cycleDuration = this.currentCycle.endTime - cycleStart;
                    logger.info(`✅ Cycle #${this.cycleCount} complete (RED ALERT): 0 trades, 0 debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                    this.emit('cycleComplete', this.currentCycle);
                }

                const elapsed = Date.now() - cycleStart;
                const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
                const sleepTime = Math.max(0, dynamicInterval - elapsed);

                if (sleepTime > 0 && this.isRunning) {
                    logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle...`);
                    await this.sleep(sleepTime);
                }
                return;
            }

            if (circuitBreakerStatus.level === 'ORANGE') {
                logger.warn(`⚠️ ORANGE ALERT: ${circuitBreakerStatus.reason}`);
                logger.warn(`Action: ${circuitBreakerService.getRecommendedAction('ORANGE')}`);
            }

            if (circuitBreakerStatus.level === 'YELLOW') {
                logger.warn(`⚠️ YELLOW ALERT: ${circuitBreakerStatus.reason}`);
                logger.warn(`Action: ${circuitBreakerService.getRecommendedAction('YELLOW')}`);
            }
        }

        // =================================================================
        // PRE-STAGE-2 OPTIMIZATION: Check if we can skip expensive debate
        // Saves ~8000 tokens when we can't trade anyway
        // =================================================================
        const preCheck = await this.runPreStage2Checks();

        if (!preCheck.canRunStage2) {
            this.totalTokensSaved += preCheck.tokensSaved;
            logger.info(`💡 Token savings this cycle: ~${preCheck.tokensSaved} tokens (total saved: ~${this.totalTokensSaved})`);

            switch (preCheck.action) {
                case 'SKIP_CYCLE':
                    // Nothing to do - skip entirely
                    await this.updateLeaderboard();
                    await this.completeCycle(cycleStart, `skipped: ${preCheck.reason}`);
                    return;

                case 'DIRECT_MANAGE':
                    // Very urgent - go directly to Karen (no debate)
                    if (preCheck.urgentPosition && preCheck.allPositions && preCheck.allPositions.length > 0) {
                        logger.info(`🚨 DIRECT MANAGE: ${preCheck.urgentPosition.symbol} (${preCheck.urgentPosition.urgencyReason})`);
                        const result = await this.executeFallbackManagement(
                            preCheck.allPositions,
                            marketDataMap,
                            `direct manage: ${preCheck.urgentPosition.urgencyReason}`
                        );
                        await this.updateLeaderboard();
                        if (result.executed) {
                            await this.completeCycle(cycleStart, `direct-managed ${result.symbol}`);
                        } else {
                            await this.completeCycle(cycleStart, 'direct manage failed');
                        }
                    } else {
                        logger.warn('DIRECT_MANAGE action but no positions available');
                        await this.completeCycle(cycleStart, 'direct manage: no position');
                    }
                    return;

                case 'LIGHTWEIGHT_DEBATE':
                    // Moderate urgency - run lightweight debate (still uses Karen but with context)
                    if (preCheck.urgentPosition && preCheck.allPositions && preCheck.allPositions.length > 0) {
                        logger.info(`⚠️ LIGHTWEIGHT MANAGE: ${preCheck.urgentPosition.symbol} (${preCheck.urgentPosition.urgencyReason})`);
                        // For now, use the same fallback management (Karen decides)
                        // TODO: Implement actual lightweight debate with 2-3 analysts
                        const result = await this.executeFallbackManagement(
                            preCheck.allPositions,
                            marketDataMap,
                            `lightweight manage: ${preCheck.urgentPosition.urgencyReason}`
                        );
                        await this.updateLeaderboard();
                        if (result.executed) {
                            await this.completeCycle(cycleStart, `lightweight-managed ${result.symbol}`);
                        } else {
                            await this.completeCycle(cycleStart, 'lightweight manage failed');
                        }
                    } else {
                        logger.warn('LIGHTWEIGHT_DEBATE action but no positions available');
                        await this.completeCycle(cycleStart, 'lightweight manage: no position');
                    }
                    return;
            }
        }

        // =================================================================
        // STAGE 2: OPPORTUNITY SELECTION DEBATE (Turn-by-Turn)
        // 3 analysts (Ray, Jim, Quant) debate best action:
        // - NEW TRADE: Open LONG or SHORT
        // - MANAGE: Close/reduce/adjust existing position
        // =================================================================
        logger.info(`🎯 Stage 2: Opportunity Selection Debate (${4 * config.debate.turnsPerAnalyst} turns)...`);

        // Fetch current positions for portfolio-aware decision making
        let portfolioPositions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            unrealizedPnl: number;
            unrealizedPnlPercent: number;
            holdTimeHours: number;
            fundingPaid?: number;
            isolatedPositionId?: number;
            marginMode?: string;
        }> = [];

        try {
            const weexPositions = await this.weexClient.getPositions();

            // Fetch current prices for all position symbols in parallel
            const positionSymbols = weexPositions
                .filter(pos => parseFloat(String(pos.size)) > 0)
                .map(pos => pos.symbol);

            const currentPrices = new Map<string, number>();
            if (positionSymbols.length > 0) {
                const tickerPromises = positionSymbols.map(async (symbol) => {
                    try {
                        const ticker = await this.weexClient.getTicker(symbol);
                        const price = parseFloat(ticker.last);
                        if (Number.isFinite(price) && price > 0) {
                            currentPrices.set(symbol, price);
                        }
                    } catch (err) {
                        logger.warn(`Failed to fetch ticker for ${symbol}:`, err);
                    }
                });
                await Promise.all(tickerPromises);
            }

            // Fetch hold times from database for open positions
            // NOTE: We look for the most recent BUY/entry trade for each symbol
            // to handle cases where positions were closed and reopened
            const holdTimes = new Map<string, number>();
            if (positionSymbols.length > 0) {
                try {
                    // FIXED: Use raw SQL instead of Prisma groupBy to avoid DateTime conversion issues
                    // SQLite stores DateTime as strings, and Prisma's groupBy fails to parse them
                    // Raw SQL returns the string directly which we can parse manually
                    //
                    // SECURITY: positionSymbols are validated WEEX symbols from APPROVED_SYMBOLS constant
                    // They only contain alphanumeric characters and underscores (e.g., "cmt_btcusdt")
                    // Prisma.join() also provides parameterized query protection
                    const holdTimeResult = await prisma.$queryRaw<Array<{
                        symbol: string;
                        side: string;
                        max_executed_at: string | null;
                    }>>`
                        SELECT 
                            symbol,
                            side,
                            MAX(executed_at) as max_executed_at
                        FROM trades
                        WHERE symbol IN (${Prisma.join(positionSymbols)})
                            AND status = 'FILLED'
                            AND executed_at IS NOT NULL
                            AND side IN ('BUY', 'SELL')
                            AND (reason IS NULL OR reason NOT LIKE 'MANAGE:%')
                        GROUP BY symbol, side
                    `;

                    // Match trade side to position direction for accurate hold time
                    for (const row of holdTimeResult) {
                        if (row.max_executed_at) {
                            // Parse the SQLite date string (format: "2026-01-02 08:25:02" or ISO format)
                            const parsed = new Date(row.max_executed_at);
                            if (isNaN(parsed.getTime())) {
                                logger.warn(`Invalid date string for ${row.symbol}: ${row.max_executed_at}, skipping`);
                                continue;
                            }
                            const entryTime = parsed.getTime();

                            // Validate entryTime is not in the future
                            if (entryTime > Date.now()) {
                                logger.warn(`Invalid future entry time for ${row.symbol}, using default`);
                                continue;
                            }

                            // Find matching position to verify direction
                            const matchingPos = weexPositions.find(p => p.symbol === row.symbol);
                            if (matchingPos) {
                                const posIsLong = matchingPos.side?.toUpperCase().includes('LONG');
                                const tradeIsBuy = row.side === 'BUY';

                                // Only use this entry time if trade side matches position direction
                                // LONG position should use BUY entry, SHORT position should use SELL entry
                                if ((posIsLong && tradeIsBuy) || (!posIsLong && !tradeIsBuy)) {
                                    const holdMs = Math.max(0, Date.now() - entryTime); // Guard against negative time
                                    const holdHours = holdMs / (1000 * 60 * 60);
                                    if (Number.isFinite(holdHours) && holdHours >= 0) {
                                        holdTimes.set(row.symbol, holdHours);
                                    }
                                }
                            }
                        }
                    }
                } catch (dbErr) {
                    logger.warn('Failed to fetch hold times from database:', dbErr);
                }
            }

            for (const pos of weexPositions) {
                const size = parseFloat(String(pos.size)) || 0;
                if (size <= 0) continue;

                const openValue = parseFloat(String(pos.openValue)) || 0;
                const entryPrice = pos.entryPrice || (size > 0 ? openValue / size : 0);

                // Validate entryPrice is reasonable
                if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
                    logger.warn(`Invalid entry price for ${pos.symbol}: ${entryPrice}, skipping position`);
                    continue;
                }

                // Use actual current price from ticker, fallback to entry price
                const tickerPrice = currentPrices.get(pos.symbol);
                const currentPrice = (tickerPrice && Number.isFinite(tickerPrice) && tickerPrice > 0)
                    ? tickerPrice
                    : entryPrice;

                const unrealizedPnl = parseFloat(String(pos.unrealizePnl)) || 0;
                const unrealizedPnlPercent = openValue > 0 ? (unrealizedPnl / openValue) * 100 : 0;

                // Use actual hold time from DB, fallback to 24h estimate
                const holdTimeHours = holdTimes.get(pos.symbol) ?? 24;

                portfolioPositions.push({
                    symbol: pos.symbol,
                    side: pos.side?.toUpperCase().includes('LONG') ? 'LONG' : 'SHORT',
                    size,
                    entryPrice,
                    currentPrice,
                    unrealizedPnl,
                    unrealizedPnlPercent,
                    holdTimeHours,
                    isolatedPositionId: pos.isolatedPositionId,
                    marginMode: pos.marginMode
                });
            }

            if (portfolioPositions.length > 0) {
                logger.info(`📊 Portfolio: ${portfolioPositions.length} open position(s)`);
                for (const p of portfolioPositions) {
                    // FIXED: Validate numeric fields before toFixed() to prevent NaN
                    const pnlPercent = Number.isFinite(p.unrealizedPnlPercent) ? p.unrealizedPnlPercent : 0;
                    const pnlValue = Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0;
                    const holdHours = Number.isFinite(p.holdTimeHours) ? p.holdTimeHours : 0;
                    const pnlSign = pnlPercent >= 0 ? '+' : '';
                    logger.info(`  • ${p.symbol} ${p.side}: ${pnlSign}${pnlPercent.toFixed(2)}% ($${pnlValue.toFixed(2)}) [hold: ${holdHours.toFixed(1)}h]`);
                }
            }
        } catch (error) {
            logger.warn('Failed to fetch positions for Stage 2, proceeding without portfolio context:', error);
        }

        // CRITICAL: Refresh market data before coin selection to ensure fresh data
        logger.info('📊 Refreshing market data for opportunity selection...');
        const stage2MarketData = await this.fetchAllMarketData();
        if (stage2MarketData.size === 0) {
            logger.warn('Failed to refresh market data for Stage 2, using cached data');
        } else {
            // Log data age and price changes
            const now = Date.now();
            for (const [symbol, freshData] of stage2MarketData) {
                const oldData = marketDataMap.get(symbol);
                // Guard against division by zero: skip if old price is invalid
                if (oldData && Number.isFinite(oldData.currentPrice) && oldData.currentPrice > 0) {
                    const priceChange = Math.abs((freshData.currentPrice - oldData.currentPrice) / oldData.currentPrice * 100);
                    const dataAge = freshData.fetchTimestamp ? Math.floor((now - freshData.fetchTimestamp) / 1000) : 0;
                    if (priceChange > 0.1) {
                        logger.info(`  ${symbol}: price moved ${priceChange.toFixed(2)}% (${oldData.currentPrice.toFixed(2)} → ${freshData.currentPrice.toFixed(2)}) [data age: ${dataAge}s]`);
                    }
                }
            }
            // Use fresh data for coin selection
            marketDataMap.clear();
            for (const [symbol, data] of stage2MarketData) {
                marketDataMap.set(symbol, data);
            }
        }

        let coinSelectionDebate;
        try {
            // Check if engine was stopped before starting debate
            if (!this.isRunning) {
                logger.info('🛑 Engine stopped before opportunity selection');
                await this.completeCycle(cycleStart, 'stopped by user');
                return;
            }

            coinSelectionDebate = await collaborativeFlowService.runCoinSelectionDebate(marketDataMap, portfolioPositions);
        } catch (error) {
            logger.error('Opportunity selection debate failed:', error);
            if (this.currentCycle) {
                this.currentCycle.errors.push('Opportunity selection debate failed');
            }
            this.consecutiveFailures++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'opportunity selection failed');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // Validate debate result before destructuring
        if (!isValidCoinSelectionResult(coinSelectionDebate)) {
            logger.error('Opportunity selection debate returned malformed result:', coinSelectionDebate);
            if (this.currentCycle) {
                this.currentCycle.errors.push('Opportunity selection debate returned invalid data');
            }
            this.consecutiveFailures++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'invalid opportunity selection result');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        const { winner: coinSelectorWinner, coinSymbol, action, debate: coinDebate } = coinSelectionDebate;

        // INCREMENT DEBATES COUNTER: Stage 2 (Coin Selection) debate completed successfully
        // This must happen BEFORE branching to MANAGE or LONG/SHORT paths
        if (this.currentCycle) {
            this.currentCycle.debatesRun++;
        }

        // Handle MANAGE action - route to position management flow
        if (action === 'MANAGE') {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`🚪 MANAGE ACTION SELECTED: ${coinSymbol}`);
            logger.info(`${'='.repeat(60)}\n`);

            // CRITICAL: Check circuit breaker status for MANAGE actions
            // RED alert = close all positions immediately (override any other decision)
            // ORANGE alert = close losing positions, tighten stops on winners
            if (config.autonomous.enableCircuitBreakers) {
                try {
                    const circuitStatus = await circuitBreakerService.checkCircuitBreakers();
                    if (circuitStatus.level === 'RED') {
                        logger.error(`🚨 CIRCUIT BREAKER RED: Forcing CLOSE_FULL for all positions`);
                        // Force close all positions - override AI decision
                        for (const pos of portfolioPositions) {
                            try {
                                await this.weexClient.closeAllPositions(pos.symbol);
                                logger.info(`✅ Emergency closed ${pos.symbol} due to RED circuit breaker`);
                            } catch (closeError) {
                                logger.error(`Failed to emergency close ${pos.symbol}:`, closeError);
                            }
                        }
                        await this.updateLeaderboard();
                        await this.completeCycle(cycleStart, 'circuit breaker RED - emergency close');
                        const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                        if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                        return;
                    } else if (circuitStatus.level === 'ORANGE') {
                        logger.warn(`⚠️ CIRCUIT BREAKER ORANGE: Will prioritize closing losing positions`);
                        // Continue with MANAGE but log the elevated risk
                    }
                } catch (cbError) {
                    logger.warn('Circuit breaker check failed, continuing with MANAGE:', cbError);
                }
            }

            // Find the position to manage - case-insensitive match with fallback to partial match
            const normalizedCoinSymbol = coinSymbol.toLowerCase();
            let positionToManage = portfolioPositions.find(p =>
                p.symbol.toLowerCase() === normalizedCoinSymbol
            );

            // Try improved partial match if exact match fails
            if (!positionToManage) {
                // Strip known prefixes for comparison
                const stripPrefix = (s: string) => s.replace(/^cmt_/i, '').toLowerCase();
                const normalizedSearch = stripPrefix(normalizedCoinSymbol);

                // Find all potential matches
                const candidates = portfolioPositions.filter(p => {
                    const normalizedPos = stripPrefix(p.symbol);
                    // Check for suffix/prefix matches
                    return normalizedPos.endsWith(normalizedSearch) ||
                        normalizedSearch.endsWith(normalizedPos) ||
                        normalizedPos.includes(normalizedSearch) ||
                        normalizedSearch.includes(normalizedPos);
                });

                if (candidates.length === 1) {
                    // Unambiguous match
                    positionToManage = candidates[0];
                    logger.info(`Found position via partial match: ${positionToManage.symbol}`);
                } else if (candidates.length > 1) {
                    // Ambiguous - prefer longest token match or exact suffix
                    const exactSuffix = candidates.find(p =>
                        stripPrefix(p.symbol).endsWith(normalizedSearch)
                    );
                    if (exactSuffix) {
                        positionToManage = exactSuffix;
                        logger.info(`Found position via suffix match: ${positionToManage.symbol}`);
                    } else {
                        // CRITICAL: Ambiguous match - throw error instead of guessing
                        const candidateSymbols = candidates.map(c => c.symbol).join(', ');
                        logger.error(`Ambiguous position match for ${coinSymbol}: multiple candidates found [${candidateSymbols}]`);
                        if (this.currentCycle) {
                            this.currentCycle.errors.push(`Ambiguous position match for ${coinSymbol}: [${candidateSymbols}]`);
                        }
                        await this.updateLeaderboard();
                        await this.completeCycle(cycleStart, 'ambiguous position match');
                        const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                        if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                        return;
                    }
                } else {
                    // No matches found - will be handled below
                    logger.warn(`No partial match found for ${coinSymbol}`);
                }
            }

            if (!positionToManage) {
                logger.error(`Position ${coinSymbol} not found in portfolio, skipping manage action`);
                logger.info(`Available positions: ${portfolioPositions.map(p => p.symbol).join(', ')}`);
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`Position ${coinSymbol} not found for manage action`);
                }
                await this.updateLeaderboard();
                await this.completeCycle(cycleStart, 'position not found');
                const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                return;
            }

            // For now, close the position (can be extended to support partial close, adjust TP/SL)
            // FIXED: Validate numeric field before toFixed()
            const pnlPercentDisplay = Number.isFinite(positionToManage.unrealizedPnlPercent) ? positionToManage.unrealizedPnlPercent : 0;
            logger.info(`Managing position: ${positionToManage.symbol} ${positionToManage.side} (P&L: ${pnlPercentDisplay.toFixed(2)}%)`);

            // Validate position data before proceeding
            if (!Number.isFinite(positionToManage.size) || positionToManage.size <= 0) {
                logger.error(`Invalid position size for ${positionToManage.symbol}: ${positionToManage.size}`);
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`Invalid position size for ${positionToManage.symbol}`);
                }
                await this.updateLeaderboard();
                await this.completeCycle(cycleStart, 'invalid position size');
                const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                return;
            }

            // =================================================================
            // POSITION MANAGEMENT DECISION (MANAGE Action from Stage 2)
            // Karen (Risk Manager) decides how to manage the position
            // =================================================================
            logger.info(`🛡️ Position Management Decision for ${positionToManage.symbol}...`);

            let managementDecision: any;
            try {
                managementDecision = await collaborativeFlowService.runPositionManagement(
                    positionToManage,
                    marketDataMap
                );
            } catch (error) {
                logger.error(`Position management decision failed:`, error);
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`Management decision failed for ${positionToManage.symbol}`);
                }
                await this.updateLeaderboard();
                await this.completeCycle(cycleStart, 'management decision failed');
                const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                return;
            }

            // Validate management decision
            if (!managementDecision || typeof managementDecision !== 'object') {
                logger.error(`Invalid management decision for ${positionToManage.symbol}`);
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`Invalid management decision`);
                }
                await this.updateLeaderboard();
                await this.completeCycle(cycleStart, 'invalid management decision');
                const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                return;
            }

            const { manageType, conviction, reason, closePercent, newStopLoss, newTakeProfit, marginAmount } = managementDecision;

            logger.info(`📋 Management Decision: ${manageType} (conviction: ${conviction}/10)`);
            logger.info(`Reason: ${reason}`);

            // Execute management action
            if (config.autonomous.dryRun) {
                logger.info(`[DRY RUN] Would execute ${manageType} on ${positionToManage.symbol}`);
                if (this.currentCycle) {
                    this.currentCycle.tradesExecuted++;
                }
            } else {
                let actionSuccess = false;
                let actionDetails = '';

                // Fetch existing plan orders once to avoid multiple API calls
                let existingPlanOrders: any[] = [];
                if (manageType === 'TIGHTEN_STOP' || manageType === 'ADJUST_TP') {
                    try {
                        existingPlanOrders = await this.weexClient.getCurrentPlanOrders(positionToManage.symbol);
                    } catch (error) {
                        logger.warn(`Failed to fetch plan orders for ${positionToManage.symbol}:`, error);
                        // Continue anyway - we'll create new orders if needed
                    }
                }

                try {
                    switch (manageType) {
                        case 'CLOSE_FULL':
                            await this.weexClient.closeAllPositions(positionToManage.symbol);
                            actionDetails = 'Full position closed';
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        case 'CLOSE_PARTIAL':
                            if (!closePercent || closePercent < 1 || closePercent > 99) {
                                throw new Error(`Invalid closePercent: ${closePercent}. Must be between 1 and 99`);
                            }
                            const sizeToClose = roundToStepSize(
                                (positionToManage.size * closePercent) / 100,
                                positionToManage.symbol
                            );

                            // Validate calculated size
                            const sizeToCloseNum = parseFloat(sizeToClose);
                            if (!Number.isFinite(sizeToCloseNum) || sizeToCloseNum <= 0) {
                                throw new Error(`Calculated size too small: ${sizeToClose}`);
                            }
                            if (sizeToCloseNum >= positionToManage.size) {
                                throw new Error(`Calculated size exceeds position: ${sizeToClose} >= ${positionToManage.size}. Use CLOSE_FULL instead.`);
                            }

                            await this.weexClient.closePartialPosition(
                                positionToManage.symbol,
                                positionToManage.side,
                                sizeToClose,
                                '1' // Market order
                            );
                            actionDetails = `Closed ${closePercent}% of position (${sizeToClose} units)`;
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        case 'TAKE_PARTIAL':
                            if (!closePercent || closePercent < 1 || closePercent > 99) {
                                throw new Error(`Invalid closePercent for TAKE_PARTIAL: ${closePercent}. Must be between 1 and 99`);
                            }

                            // CRITICAL: TAKE_PARTIAL should only be used for profitable positions
                            // If position is at a loss, use CLOSE_PARTIAL instead (different intent)
                            // FIXED: Validate numeric field before toFixed()
                            const takePnlPercent = Number.isFinite(positionToManage.unrealizedPnlPercent) ? positionToManage.unrealizedPnlPercent : 0;
                            if (takePnlPercent < 0) {
                                logger.warn(`⚠️ TAKE_PARTIAL on losing position (${takePnlPercent.toFixed(2)}%). Consider CLOSE_PARTIAL for loss-cutting.`);
                            }

                            const profitSize = roundToStepSize(
                                (positionToManage.size * closePercent) / 100,
                                positionToManage.symbol
                            );

                            // Validate calculated size
                            const profitSizeNum = parseFloat(profitSize);
                            if (!Number.isFinite(profitSizeNum) || profitSizeNum <= 0) {
                                throw new Error(`Calculated size too small: ${profitSize}`);
                            }
                            if (profitSizeNum >= positionToManage.size) {
                                throw new Error(`Calculated size exceeds position: ${profitSize} >= ${positionToManage.size}. Use CLOSE_FULL instead.`);
                            }

                            await this.weexClient.closePartialPosition(
                                positionToManage.symbol,
                                positionToManage.side,
                                profitSize,
                                '1' // Market order
                            );
                            actionDetails = `Took ${closePercent}% profit (${profitSize} units)`;
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        case 'TIGHTEN_STOP':
                            if (!newStopLoss || !Number.isFinite(newStopLoss) || newStopLoss <= 0) {
                                throw new Error(`Invalid newStopLoss: ${newStopLoss}`);
                            }

                            // Validate stop loss direction
                            if (positionToManage.side === 'LONG' && newStopLoss >= positionToManage.currentPrice) {
                                throw new Error(`Stop loss for LONG must be below current price: ${newStopLoss} >= ${positionToManage.currentPrice}`);
                            }
                            if (positionToManage.side === 'SHORT' && newStopLoss <= positionToManage.currentPrice) {
                                throw new Error(`Stop loss for SHORT must be above current price: ${newStopLoss} <= ${positionToManage.currentPrice}`);
                            }

                            // CRITICAL: Validate that new stop is actually TIGHTER (closer to current price)
                            // For LONG: tighter = higher stop loss (closer to current price from below)
                            // For SHORT: tighter = lower stop loss (closer to current price from above)
                            // We need to compare against entry price to determine if it's tighter
                            if (positionToManage.side === 'LONG') {
                                // For LONG, new SL should be higher than entry (protecting profits) or at least not worse
                                if (newStopLoss < positionToManage.entryPrice * 0.95) {
                                    logger.warn(`⚠️ New stop loss ${newStopLoss} is more than 5% below entry ${positionToManage.entryPrice} - this is loosening, not tightening`);
                                }
                            } else {
                                // For SHORT, new SL should be lower than entry (protecting profits) or at least not worse
                                if (newStopLoss > positionToManage.entryPrice * 1.05) {
                                    logger.warn(`⚠️ New stop loss ${newStopLoss} is more than 5% above entry ${positionToManage.entryPrice} - this is loosening, not tightening`);
                                }
                            }

                            // Check both camelCase and snake_case field names
                            const stopLossOrder = existingPlanOrders.find((o: any) =>
                                (o.planType === 'loss_plan' || o.plan_type === 'loss_plan') &&
                                (o.positionSide === positionToManage.side.toLowerCase() ||
                                    o.position_side === positionToManage.side.toLowerCase())
                            );

                            if (stopLossOrder && (stopLossOrder.orderId || stopLossOrder.order_id)) {
                                // Modify existing stop loss
                                const orderId = String(stopLossOrder.orderId || stopLossOrder.order_id);
                                await this.weexClient.modifyTpSlOrder({
                                    orderId,
                                    triggerPrice: newStopLoss,
                                    executePrice: 0, // Market execution
                                });
                                actionDetails = `Modified stop loss to ${newStopLoss}`;
                            } else {
                                // Fetch current position size (may have changed from partial closes)
                                const currentPosition = await this.weexClient.getPosition(positionToManage.symbol);
                                let currentSize = positionToManage.size;
                                if (currentPosition) {
                                    const parsedSize = parseFloat(currentPosition.size);
                                    if (Number.isFinite(parsedSize) && parsedSize > 0) {
                                        currentSize = parsedSize;
                                    } else {
                                        logger.warn(`Invalid position size from WEEX: ${currentPosition.size}, using cached size: ${positionToManage.size}`);
                                    }
                                }

                                // Place new stop loss
                                await this.weexClient.placeTpSlOrder({
                                    symbol: positionToManage.symbol,
                                    planType: 'loss_plan',
                                    triggerPrice: newStopLoss,
                                    size: currentSize,
                                    positionSide: positionToManage.side.toLowerCase() as 'long' | 'short',
                                });
                                actionDetails = `Placed new stop loss at ${newStopLoss}`;
                            }
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        case 'ADJUST_TP':
                            if (!newTakeProfit || !Number.isFinite(newTakeProfit) || newTakeProfit <= 0) {
                                throw new Error(`Invalid newTakeProfit: ${newTakeProfit}`);
                            }

                            // Validate take profit direction
                            if (positionToManage.side === 'LONG' && newTakeProfit <= positionToManage.currentPrice) {
                                throw new Error(`Take profit for LONG must be above current price: ${newTakeProfit} <= ${positionToManage.currentPrice}`);
                            }
                            if (positionToManage.side === 'SHORT' && newTakeProfit >= positionToManage.currentPrice) {
                                throw new Error(`Take profit for SHORT must be below current price: ${newTakeProfit} >= ${positionToManage.currentPrice}`);
                            }

                            // Check both camelCase and snake_case field names
                            const takeProfitOrder = existingPlanOrders.find((o: any) =>
                                (o.planType === 'profit_plan' || o.plan_type === 'profit_plan') &&
                                (o.positionSide === positionToManage.side.toLowerCase() ||
                                    o.position_side === positionToManage.side.toLowerCase())
                            );

                            if (takeProfitOrder && (takeProfitOrder.orderId || takeProfitOrder.order_id)) {
                                // Modify existing take profit
                                const orderId = String(takeProfitOrder.orderId || takeProfitOrder.order_id);
                                await this.weexClient.modifyTpSlOrder({
                                    orderId,
                                    triggerPrice: newTakeProfit,
                                    executePrice: 0, // Market execution
                                });
                                actionDetails = `Modified take profit to ${newTakeProfit}`;
                            } else {
                                // Fetch current position size (may have changed from partial closes)
                                const currentPosition = await this.weexClient.getPosition(positionToManage.symbol);
                                let currentSize = positionToManage.size;
                                if (currentPosition) {
                                    const parsedSize = parseFloat(currentPosition.size);
                                    if (Number.isFinite(parsedSize) && parsedSize > 0) {
                                        currentSize = parsedSize;
                                    } else {
                                        logger.warn(`Invalid position size from WEEX: ${currentPosition.size}, using cached size: ${positionToManage.size}`);
                                    }
                                }

                                // Place new take profit
                                await this.weexClient.placeTpSlOrder({
                                    symbol: positionToManage.symbol,
                                    planType: 'profit_plan',
                                    triggerPrice: newTakeProfit,
                                    size: currentSize,
                                    positionSide: positionToManage.side.toLowerCase() as 'long' | 'short',
                                });
                                actionDetails = `Placed new take profit at ${newTakeProfit}`;
                            }
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        case 'ADD_MARGIN':
                            if (!marginAmount || !Number.isFinite(marginAmount) || marginAmount <= 0) {
                                throw new Error(`Invalid marginAmount: ${marginAmount}`);
                            }

                            // CRITICAL: Validate P&L is a finite number before threshold checks
                            if (!Number.isFinite(positionToManage.unrealizedPnlPercent)) {
                                throw new Error(`ADD_MARGIN forbidden: Invalid P&L value (${positionToManage.unrealizedPnlPercent}). Cannot proceed with non-finite P&L.`);
                            }

                            // CRITICAL: Enforce ADD_MARGIN restrictions per MANAGE_TRADING_RULES
                            // Check most severe condition first (-7%) then less severe (-3%)

                            // 1. Never allowed if P&L < -7% (must close instead)
                            if (positionToManage.unrealizedPnlPercent < -7) {
                                throw new Error(`ADD_MARGIN forbidden: P&L ${positionToManage.unrealizedPnlPercent.toFixed(2)}% < -7%. Must close position instead.`);
                            }

                            // 2. Only allowed if P&L >= -3% (not deeply underwater)
                            if (positionToManage.unrealizedPnlPercent < -3) {
                                throw new Error(`ADD_MARGIN forbidden: P&L ${positionToManage.unrealizedPnlPercent.toFixed(2)}% < -3%. Position is too underwater - consider CLOSE_FULL instead.`);
                            }

                            // Verify position is isolated mode
                            if (positionToManage.marginMode !== 'ISOLATED') {
                                throw new Error(`ADD_MARGIN only allowed for isolated positions. Current mode: ${positionToManage.marginMode || 'CROSS (default)'}`);
                            }

                            // Verify we have isolatedPositionId
                            if (!positionToManage.isolatedPositionId || !Number.isFinite(positionToManage.isolatedPositionId)) {
                                throw new Error(`Missing isolatedPositionId for ${positionToManage.symbol}. Cannot adjust margin without position ID.`);
                            }

                            // Validate margin amount is reasonable (max 50% of position value)
                            const positionValue = positionToManage.size * positionToManage.currentPrice;
                            const maxMarginAdd = positionValue * 0.5;
                            if (marginAmount > maxMarginAdd) {
                                throw new Error(`Margin amount ${marginAmount} exceeds 50% of position value (${maxMarginAdd.toFixed(2)}). Consider closing position instead.`);
                            }

                            await this.weexClient.adjustPositionMargin({
                                isolatedPositionId: positionToManage.isolatedPositionId,
                                collateralAmount: String(marginAmount), // Positive value = add margin
                                coinId: 2 // USDT
                            });
                            actionDetails = `Added ${marginAmount} USDT margin to isolated position`;
                            actionSuccess = true;
                            logger.info(`✅ ${actionDetails}`);
                            break;

                        default:
                            throw new Error(`Unknown management action: ${manageType}`);
                    }

                    if (this.currentCycle) {
                        this.currentCycle.tradesExecuted++;
                    }
                } catch (error) {
                    logger.error(`Failed to execute ${manageType} on ${positionToManage.symbol}:`, error);
                    if (this.currentCycle) {
                        this.currentCycle.errors.push(`Failed to execute ${manageType}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                // Log to database if action was successful
                if (actionSuccess) {
                    try {
                        const firstAnalyst = this.analystStates.values().next().value;
                        if (firstAnalyst?.portfolioId) {
                            const tradeId = crypto.randomUUID();

                            // Calculate actual size and price for database logging
                            // For CLOSE_PARTIAL/TAKE_PARTIAL, use the calculated close size
                            // For other actions, use current position size and price
                            let loggedSize = positionToManage.size;
                            let loggedPrice = positionToManage.currentPrice;
                            let loggedPnl = 0;

                            if (manageType === 'CLOSE_PARTIAL' || manageType === 'TAKE_PARTIAL') {
                                // Extract actual closed size from actionDetails with error handling
                                try {
                                    const sizeMatch = actionDetails.match(/\(([0-9.]+) units\)/);
                                    if (sizeMatch && sizeMatch[1]) {
                                        const parsedSize = parseFloat(sizeMatch[1]);
                                        if (Number.isFinite(parsedSize) && parsedSize > 0) {
                                            loggedSize = parsedSize;
                                        } else {
                                            logger.warn(`Invalid parsed size from regex: ${sizeMatch[1]}, using position size`);
                                        }
                                    } else {
                                        logger.warn(`Could not extract size from actionDetails: ${actionDetails}, using position size`);
                                    }
                                } catch (regexError) {
                                    logger.error('Regex parsing failed for size extraction:', regexError);
                                    // Fall back to position size
                                }
                                // Calculate proportional P&L for partial close
                                const closedPercent = loggedSize / positionToManage.size;
                                loggedPnl = positionToManage.unrealizedPnl * closedPercent;
                            } else if (manageType === 'CLOSE_FULL') {
                                // Full close - use entire position P&L
                                loggedPnl = positionToManage.unrealizedPnl;
                            }
                            // For TIGHTEN_STOP, ADJUST_TP, ADD_MARGIN: no P&L realized, size/price are informational

                            // FIXED: Find the original champion who opened this position
                            // Query the most recent OPEN entry trade (BUY for LONG, SELL for SHORT) for this symbol
                            // CRITICAL: Must filter by realizedPnl IS NULL to get the CURRENT open position's entry
                            let originalChampionId: string | null = null;
                            try {
                                const entryTrade = await prisma.trade.findFirst({
                                    where: {
                                        symbol: positionToManage.symbol,
                                        side: positionToManage.side === 'LONG' ? 'BUY' : 'SELL', // Entry side
                                        status: 'FILLED',
                                        championId: { not: null },
                                        realizedPnl: null // FIXED: Only match OPEN entry trades (not yet closed)
                                    },
                                    orderBy: {
                                        executedAt: 'desc'
                                    },
                                    select: {
                                        championId: true
                                    }
                                });

                                originalChampionId = entryTrade?.championId || null;

                                if (!originalChampionId) {
                                    logger.warn(`Could not find original champion for ${positionToManage.symbol} position, skipping attribution`);
                                    // Don't attribute to any analyst if we can't find the original
                                }
                            } catch (error) {
                                logger.error('Failed to lookup original champion:', error);
                                // Don't attribute to any analyst on error
                            }

                            await prisma.trade.create({
                                data: {
                                    id: tradeId,
                                    portfolioId: firstAnalyst.portfolioId,
                                    symbol: positionToManage.symbol,
                                    side: positionToManage.side === 'LONG' ? 'SELL' : 'BUY', // Management side
                                    type: 'MARKET',
                                    size: loggedSize,
                                    price: loggedPrice,
                                    status: 'FILLED',
                                    reason: `MANAGE: ${manageType} - ${actionDetails}`,
                                    championId: originalChampionId, // FIXED: Use original debate winner
                                    realizedPnl: loggedPnl,
                                    executedAt: new Date(),
                                    createdAt: new Date()
                                }
                            });

                            // Increment daily trade counter for position management actions
                            // NOTE: Counter is now queried from database, no need to increment in-memory
                        }
                    } catch (dbError) {
                        // Log DB error but don't fail - the action was already executed
                        logger.error(`Failed to log MANAGE trade to database:`, dbError);
                    }
                }
            }

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, `managed ${positionToManage.symbol}: ${manageType}`);
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // Continue with normal LONG/SHORT flow
        const direction = action as 'LONG' | 'SHORT';

        // =================================================================
        // CRITICAL: Refresh position data before early exit checks
        // Position data from line 750 is now stale (Stage 2 debate took 30-90s)
        // Race condition: positions could have been closed/liquidated during debate
        // 
        // IMPORTANT: For MANAGE actions, we need full position data (P&L, current price)
        // For LONG/SHORT actions, we only need count and symbols (fast path)
        // =================================================================
        logger.info('🔄 Refreshing position data for early exit checks...');
        try {
            const freshWeexPositions = await this.weexClient.getPositions();

            // Fast refresh: Only count and symbols (sufficient for early exit checks)
            // FIXED: Derive currentPrice from unrealizedPnl if available
            portfolioPositions = freshWeexPositions
                .filter(pos => parseFloat(String(pos.size)) > 0)
                .map(pos => {
                    const size = parseFloat(String(pos.size)) || 0;
                    const openValue = parseFloat(String(pos.openValue)) || 0;
                    const entryPrice = pos.entryPrice || (size > 0 ? openValue / size : 0);
                    const unrealizedPnl = parseFloat(String(pos.unrealizePnl)) || 0;
                    const unrealizedPnlPercent = openValue > 0 ? (unrealizedPnl / openValue) * 100 : 0;

                    // FIXED: Derive currentPrice from unrealizedPnl
                    // PnL = (currentPrice - entryPrice) * size for LONG
                    // PnL = (entryPrice - currentPrice) * size for SHORT
                    let currentPrice = entryPrice;
                    const isLong = pos.side?.toUpperCase().includes('LONG');
                    if (size > 0 && entryPrice > 0 && Number.isFinite(unrealizedPnl)) {
                        const pnlPerUnit = unrealizedPnl / size;
                        currentPrice = isLong
                            ? entryPrice + pnlPerUnit
                            : entryPrice - pnlPerUnit;
                        // Sanity check
                        if (currentPrice <= 0 || !Number.isFinite(currentPrice)) {
                            currentPrice = entryPrice;
                        }
                    }

                    return {
                        symbol: pos.symbol,
                        side: isLong ? 'LONG' : 'SHORT',
                        size,
                        entryPrice,
                        currentPrice,
                        unrealizedPnl,
                        unrealizedPnlPercent,
                        holdTimeHours: 0, // Not needed for early exit checks
                        isolatedPositionId: pos.isolatedPositionId,
                        marginMode: pos.marginMode
                    };
                });
            logger.info(`📊 Fresh position count: ${portfolioPositions.length}`);
        } catch (error) {
            // CRITICAL: Position refresh failure during decision-making is serious
            // Stale data could lead to:
            // - False negatives on max position checks (trading when at limit)
            // - Duplicate position checks missing actual positions
            // - Incorrect exposure calculations
            logger.error('🚨 Failed to refresh positions for early exit checks - data may be stale:', error);

            // If we have no cached positions at all, we must abort
            // (we can't make safe decisions without any position data)
            if (!portfolioPositions || portfolioPositions.length === 0) {
                logger.error('🚨 No cached position data available - aborting cycle for safety');
                if (this.currentCycle) {
                    this.currentCycle.errors.push('Position refresh failed with no cached data');
                }
                await this.updateLeaderboard();
                await this.completeCycle(cycleStart, 'position refresh failed (no cache)');
                const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                return;
            }

            // We have cached data - continue with warning
            // Stage 4 (Risk Council) will validate positions again before approval
            logger.warn(`⚠️ Continuing with ${portfolioPositions.length} cached positions - Risk Council will re-validate`);
        }

        // OPTIMIZATION: Max positions reached - FALLBACK TO MANAGE
        // Instead of early exit, auto-manage the best candidate position
        const MAX_CONCURRENT_POSITIONS = RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS;
        if (portfolioPositions.length >= MAX_CONCURRENT_POSITIONS) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ MAX POSITIONS: Already at limit (${portfolioPositions.length}/${MAX_CONCURRENT_POSITIONS})`);
            logger.info(`AI selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`🔄 FALLBACK: Auto-selecting best position to MANAGE instead of early exit`);
            logger.info(`${'='.repeat(60)}\n`);

            const result = await this.executeFallbackManagement(portfolioPositions, marketDataMap, 'max positions');
            await this.updateLeaderboard();

            if (result.executed) {
                await this.completeCycle(cycleStart, `auto-managed ${result.symbol} (max positions fallback)`);
            } else {
                await this.completeCycle(cycleStart, 'max positions reached (early exit)');
            }

            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #2: Insufficient balance
        const currentBalance = await this.getWalletBalance();

        // Validate balance is a valid number
        if (!Number.isFinite(currentBalance) || currentBalance < 0) {
            logger.error(`\n${'='.repeat(60)}`);
            logger.error(`⚠️ EARLY EXIT #2A: Invalid balance data`);
            logger.error(`Balance returned: ${currentBalance}`);
            logger.error(`Reason: Cannot proceed with invalid balance`);
            logger.error(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.error(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'invalid balance data (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        if (currentBalance < config.autonomous.minBalanceToTrade) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ EARLY EXIT #2: Insufficient balance`);
            logger.info(`Current: $${currentBalance.toFixed(2)} < Min: $${config.autonomous.minBalanceToTrade}`);
            logger.info(`Selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`Reason: Karen would veto this trade in Risk Council (Stage 4) anyway`);
            logger.info(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.info(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'insufficient balance (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #3: Weekly drawdown exceeded
        const earlyExitPnL = await this.getRecentPnLCached();

        // Validate P&L data is valid
        if (!earlyExitPnL || typeof earlyExitPnL.week !== 'number' || !Number.isFinite(earlyExitPnL.week)) {
            logger.warn(`⚠️ Invalid P&L data returned (${JSON.stringify(earlyExitPnL)}), skipping drawdown check`);
            // Continue to next check - don't block on bad data
        } else if (earlyExitPnL.week < -RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ EARLY EXIT #3: Weekly drawdown limit exceeded`);
            logger.info(`Current: ${earlyExitPnL.week.toFixed(1)}% < -${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}%`);
            logger.info(`Selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`Reason: Karen would veto this trade in Risk Council (Stage 4) anyway`);
            logger.info(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.info(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'drawdown limit exceeded (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #4: Same direction limit reached - FALLBACK TO MANAGE
        // DEBUG: Log all positions and their sides for troubleshooting
        logger.info(`📊 DEBUG: portfolioPositions count: ${portfolioPositions.length}`);
        for (const p of portfolioPositions) {
            logger.info(`  - ${p.symbol}: side="${p.side}" (type: ${typeof p.side})`);
        }
        logger.info(`📊 DEBUG: direction="${direction}" (type: ${typeof direction})`);

        const sameDirectionCount = portfolioPositions.filter(p =>
            p.side === (direction === 'LONG' ? 'LONG' : 'SHORT')
        ).length;
        logger.info(`📊 DEBUG: sameDirectionCount=${sameDirectionCount}`);

        if (sameDirectionCount >= RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ DIRECTIONAL LIMIT: ${direction} limit reached (${sameDirectionCount}/${RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS})`);
            logger.info(`AI selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`🔄 FALLBACK: Auto-selecting best position to MANAGE instead of early exit`);
            logger.info(`${'='.repeat(60)}\n`);

            // Filter to same direction positions only
            const sameDirectionPositions = portfolioPositions.filter(p => p.side === direction);
            logger.info(`📊 DEBUG: sameDirectionPositions count: ${sameDirectionPositions.length}`);

            const result = await this.executeFallbackManagement(sameDirectionPositions, marketDataMap, 'directional limit');
            await this.updateLeaderboard();

            if (result.executed) {
                await this.completeCycle(cycleStart, `auto-managed ${result.symbol} (directional limit fallback)`);
            } else {
                await this.completeCycle(cycleStart, 'directional limit reached (early exit)');
            }

            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #5: Extreme funding rate against position
        // CRITICAL: Check if market data exists for selected coin
        const tempMarketData = marketDataMap.get(coinSymbol);
        if (!tempMarketData) {
            // No market data = cannot verify funding rate safety
            logger.error(`\n${'='.repeat(60)}`);
            logger.error(`⚠️ EARLY EXIT #5A: No market data for ${coinSymbol}`);
            logger.error(`Cannot verify funding rate safety`);
            logger.error(`Reason: Missing market data is a red flag`);
            logger.error(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.error(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'missing market data (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // Now safe to check funding rate
        const fundingRate = tempMarketData.fundingRate || 0;
        const fundingAgainstUs = (direction === 'LONG' && fundingRate > 0) ||
            (direction === 'SHORT' && fundingRate < 0);
        if (fundingAgainstUs && Math.abs(fundingRate) > RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ EARLY EXIT #5: Extreme funding rate against position`);
            logger.info(`Funding: ${(fundingRate * 100).toFixed(4)}% (${direction} position)`);
            logger.info(`Max allowed against: ${(RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST * 100).toFixed(2)}%`);
            logger.info(`Selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`Reason: Karen would veto this trade in Risk Council (Stage 4) anyway`);
            logger.info(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.info(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'extreme funding rate (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #6: Duplicate position check (same symbol + same direction)
        // FIXED: Allow opposite direction positions (hedging) - only block same direction duplicates
        const existingPosition = portfolioPositions.find(p => p.symbol === coinSymbol && p.side === direction);
        if (existingPosition) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚠️ EARLY EXIT #6: Position already exists for ${coinSymbol} ${direction}`);
            logger.info(`Existing: ${existingPosition.side} ${existingPosition.size} @ ${existingPosition.entryPrice}`);
            logger.info(`Selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.info(`Reason: Cannot open duplicate position on same symbol in same direction`);
            logger.info(`Note: Opposite direction positions (hedging) are allowed`);
            logger.info(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.info(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'duplicate position (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // OPTIMIZATION #7: Unapproved symbol check
        if (!APPROVED_SYMBOLS.includes(coinSymbol as any)) {
            logger.warn(`\n${'='.repeat(60)}`);
            logger.warn(`⚠️ EARLY EXIT #7: Unapproved symbol selected`);
            logger.warn(`Selected: ${coinSymbol} ${direction} by ${coinSelectorWinner}`);
            logger.warn(`Approved symbols: ${APPROVED_SYMBOLS.join(', ')}`);
            logger.warn(`Reason: Cannot trade unapproved symbols`);
            logger.warn(`Token savings: ~8,000 tokens (skipping Stage 3 Championship)`);
            logger.warn(`${'='.repeat(60)}\n`);

            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'unapproved symbol (early exit)');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        logger.info(`✅ All 7 early exit checks passed - proceeding to Stage 3 (Championship)`);

        // NOTE: debatesRun already incremented after Stage 2 validation (before MANAGE/LONG/SHORT branching)

        // Log debate turns - FULL arguments, no truncation
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🎯 COIN SELECTION DEBATE - ${coinDebate.turns.length} TURNS`);
        logger.info(`${'='.repeat(60)}`);
        for (let i = 0; i < coinDebate.turns.length; i++) {
            const turn = coinDebate.turns[i];
            logger.info(`\n[Turn ${i + 1}] ${turn.analystName} (strength: ${turn.strength}/10):`);
            logger.info(turn.argument);
            if (turn.dataPointsReferenced && turn.dataPointsReferenced.length > 0) {
                logger.info(`Data points: ${turn.dataPointsReferenced.join(', ')}`);
            }
        }
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🏆 Winner: ${coinSelectorWinner} → ${coinSymbol} ${direction}`);
        logger.info(`Scores: ${Object.entries(coinDebate.scores).map(([id, s]: [string, any]) => `${id}:${s.total}`).join(', ')}`);
        logger.info(`${'='.repeat(60)}\n`);

        this.emit('coinSelected', {
            topCoin: { symbol: coinSymbol, direction, totalScore: coinDebate.scores[coinSelectorWinner]?.total || 0 },
            debate: coinDebate
        });

        const selectedMarketData = marketDataMap.get(coinSymbol);
        if (!selectedMarketData) {
            logger.error(`Market data not found for selected coin: ${coinSymbol}`);
            if (this.currentCycle) {
                this.currentCycle.errors.push(`Market data missing for ${coinSymbol}`);
            }
            this.consecutiveFailures++;
            await this.completeCycle(cycleStart, 'missing market data');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // =================================================================
        // STAGE 3: CHAMPIONSHIP DEBATE (Turn-by-Turn)
        // ALL 4 analysts compete - winner's thesis gets executed
        // =================================================================
        logger.info(`🏆 Stage 3: Championship Debate for ${coinSymbol} (${4 * config.debate.turnsPerAnalyst} turns - ALL 4 analysts)...`);

        // CRITICAL: Refresh market data before championship debate
        // Coin selection debate may have taken 2-3 minutes
        logger.info(`📊 Refreshing market data for ${coinSymbol} before championship...`);
        let championshipMarketData = selectedMarketData;

        try {
            const [freshTicker, freshFunding] = await Promise.all([
                this.weexClient.getTicker(coinSymbol),
                this.weexClient.getFundingRate(coinSymbol),
            ]);

            const freshPrice = parseFloat(freshTicker.last);
            if (Number.isFinite(freshPrice) && freshPrice > 0) {
                const priceChange = Math.abs(
                    ((freshPrice - selectedMarketData.currentPrice) /
                        selectedMarketData.currentPrice) *
                    100
                );
                const dataAge = selectedMarketData.fetchTimestamp
                    ? Math.floor((Date.now() - selectedMarketData.fetchTimestamp) / 1000)
                    : 0;

                if (priceChange > 0.1) {
                    logger.info(
                        `  Price moved ${priceChange.toFixed(
                            2
                        )}% (${selectedMarketData.currentPrice.toFixed(
                            2
                        )} → ${freshPrice.toFixed(2)}) [data age: ${dataAge}s]`
                    );
                }

                const parsedHigh = parseFloat(freshTicker.high_24h);
                const parsedLow = parseFloat(freshTicker.low_24h);
                const parsedVolume = parseFloat(freshTicker.volume_24h);
                const parsedChangePercent = parseFloat(
                    freshTicker.priceChangePercent || '0'
                );
                const parsedFundingRate = parseFloat(freshFunding.fundingRate || '0');

                championshipMarketData = {
                    ...selectedMarketData,
                    currentPrice: freshPrice,
                    high24h: Number.isFinite(parsedHigh)
                        ? parsedHigh
                        : selectedMarketData.high24h,
                    low24h: Number.isFinite(parsedLow)
                        ? parsedLow
                        : selectedMarketData.low24h,
                    volume24h: Number.isFinite(parsedVolume)
                        ? parsedVolume
                        : selectedMarketData.volume24h,
                    change24h: Number.isFinite(parsedChangePercent)
                        ? parsedChangePercent * 100
                        : selectedMarketData.change24h,
                    fundingRate: Number.isFinite(parsedFundingRate) ? parsedFundingRate : 0,
                    fetchTimestamp: Date.now(),
                };
            }
        } catch (err) {
            logger.warn(
                `Failed to refresh market data for championship:`,
                err instanceof Error ? err.message : String(err)
            );
            const dataAge = selectedMarketData.fetchTimestamp
                ? Math.floor((Date.now() - selectedMarketData.fetchTimestamp) / 1000)
                : 0;
            logger.warn(`⚠️ Using stale data for championship (age: ${dataAge}s)`);
        }

        let championshipResult;
        try {
            // Check if engine was stopped before starting debate
            if (!this.isRunning) {
                logger.info('🛑 Engine stopped before championship');
                await this.completeCycle(cycleStart, 'stopped by user');
                return;
            }

            championshipResult = await collaborativeFlowService.runChampionshipDebate(
                coinSymbol,
                championshipMarketData,
                {
                    coinSelector: coinSelectorWinner,
                    // Pass winning argument from coin selection for context
                    coinSelectorArgument: coinDebate.winningArguments?.[0],
                }
            );
        } catch (error) {
            logger.error('Championship debate failed:', error);
            if (this.currentCycle) {
                this.currentCycle.errors.push('Championship debate failed');
            }
            this.consecutiveFailures++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'championship failed');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // Validate debate result before destructuring
        if (!isValidChampionshipResult(championshipResult)) {
            logger.error('Championship debate returned malformed result:', championshipResult);
            if (this.currentCycle) {
                this.currentCycle.errors.push('Championship debate returned invalid data');
            }
            this.consecutiveFailures++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'invalid championship result');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        const { champion, debate: championshipDebate } = championshipResult;
        if (this.currentCycle) {
            this.currentCycle.debatesRun++;
        }

        // Log debate turns - FULL arguments, no truncation
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🏆 CHAMPIONSHIP DEBATE - ${championshipDebate.turns.length} TURNS`);
        logger.info(`${'='.repeat(60)}`);
        for (let i = 0; i < championshipDebate.turns.length; i++) {
            const turn = championshipDebate.turns[i];
            logger.info(`\n[Turn ${i + 1}] ${turn.analystName} (strength: ${turn.strength}/10):`);
            logger.info(turn.argument);
            if (turn.dataPointsReferenced && turn.dataPointsReferenced.length > 0) {
                logger.info(`Data points: ${turn.dataPointsReferenced.join(', ')}`);
            }
        }
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🏆🏆🏆 CHAMPION: ${champion.analystName} (${champion.confidence}% confidence)`);
        logger.info(`Thesis: ${champion.thesis}`);
        logger.info(`Scores: ${Object.entries(championshipDebate.scores).map(([id, s]: [string, any]) => `${id}:${s.total}`).join(', ')}`);
        logger.info(`${'='.repeat(60)}\n`);

        this.emit('tournamentComplete', { champion, debate: championshipDebate });

        // Check minimum confidence threshold
        if (champion.confidence < this.MIN_CONFIDENCE_TO_TRADE) {
            logger.info(`Champion confidence ${champion.confidence}% below threshold ${this.MIN_CONFIDENCE_TO_TRADE}%, skipping trade`);
            await this.updateLeaderboard();
            this.consecutiveFailures = 0; // Reset on successful debate completion (just low confidence)
            await this.completeCycle(cycleStart, 'low confidence');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        // Reset consecutive failures on successful debate completion
        this.consecutiveFailures = 0;

        // Extract champion's risk parameters from their thesis
        // These will be reviewed and potentially adjusted by Karen in Stage 4 (Risk Council)
        const adjustedChampion = {
            ...champion,
            positionSize: champion.positionSize || 5, // Default moderate position
            riskLevel: champion.riskLevel || 'moderate'
        };
        logger.info(`Champion's proposed parameters: position ${adjustedChampion.positionSize}/10, risk ${adjustedChampion.riskLevel}`);

        // =================================================================
        // STAGE 4: RISK COUNCIL - Karen approves/vetoes/adjusts
        // =================================================================
        logger.info('🛡️ Stage 4: Risk Council Final Review...');

        // Refresh market data before risk council
        // This is critical - we need current price for accurate risk assessment
        let riskCouncilMarketData = championshipMarketData;
        try {
            const [freshTicker, freshFunding] = await Promise.all([
                this.weexClient.getTicker(coinSymbol),
                this.weexClient.getFundingRate(coinSymbol),
            ]);
            const freshPrice = parseFloat(freshTicker.last);
            if (Number.isFinite(freshPrice) && freshPrice > 0) {
                // CRITICAL: Validate championshipMarketData.currentPrice before division
                const oldPrice = championshipMarketData.currentPrice;
                const isBullish = ['strong_buy', 'buy'].includes(adjustedChampion.recommendation);

                if (!Number.isFinite(oldPrice) || oldPrice <= 0) {
                    // CRITICAL FIX: If old price is invalid, original targets might also be invalid
                    // Use default targets based on fresh price instead of potentially invalid original targets
                    logger.warn(`⚠️ Invalid old price ${oldPrice}, using default targets based on fresh price`);

                    // Use trading style config for TP/SL percentages
                    const tradingStyle = getActiveTradingStyle();
                    const defaultSlPct = tradingStyle.stopLossPercent / 100; // Convert from % to decimal
                    const defaultTpPct = tradingStyle.targetProfitPercent / 100;

                    if (isBullish) {
                        adjustedChampion.priceTarget = {
                            ...adjustedChampion.priceTarget,
                            base: freshPrice * (1 + defaultTpPct),
                            bear: freshPrice * (1 - defaultSlPct)
                        };
                    } else {
                        adjustedChampion.priceTarget = {
                            ...adjustedChampion.priceTarget,
                            base: freshPrice * (1 - defaultTpPct),
                            bear: freshPrice * (1 + defaultSlPct)
                        };
                    }

                    logger.warn(`⚠️ Default targets applied: TP ${adjustedChampion.priceTarget.base.toFixed(6)}, SL ${adjustedChampion.priceTarget.bear.toFixed(6)} (2:1 R/R)`);

                    // Update market data with fresh price
                    riskCouncilMarketData = {
                        ...championshipMarketData,
                        currentPrice: freshPrice,
                        high24h: parseFloat(freshTicker.high_24h) || championshipMarketData.high24h,
                        low24h: parseFloat(freshTicker.low_24h) || championshipMarketData.low24h,
                        fundingRate: parseFloat(freshFunding.fundingRate || '0'),
                        fetchTimestamp: Date.now(),
                    };
                } else {
                    const priceChange = Math.abs((freshPrice - oldPrice) / oldPrice * 100);
                    const dataAge = championshipMarketData.fetchTimestamp ? Math.floor((Date.now() - championshipMarketData.fetchTimestamp) / 1000) : 0;
                    if (priceChange > 0.1) { // Log if price moved more than 0.1%
                        logger.info(`📊 Market data refreshed for risk council: ${coinSymbol} price moved ${priceChange.toFixed(2)}% (${championshipMarketData.currentPrice.toFixed(2)} → ${freshPrice.toFixed(2)}) [old data age: ${dataAge}s]`);
                    }
                    riskCouncilMarketData = {
                        ...championshipMarketData,
                        currentPrice: freshPrice,
                        high24h: parseFloat(freshTicker.high_24h) || championshipMarketData.high24h,
                        low24h: parseFloat(freshTicker.low_24h) || championshipMarketData.low24h,
                        fundingRate: parseFloat(freshFunding.fundingRate || '0'),
                        fetchTimestamp: Date.now(), // Update timestamp
                    };

                    // CRITICAL: Recalculate price targets based on fresh price
                    // The original targets were calculated with old data, which can cause
                    // stop loss to be above entry price for LONG trades (invalid)
                    const isBullish = ['strong_buy', 'buy'].includes(adjustedChampion.recommendation);
                    const originalTakeProfit = adjustedChampion.priceTarget.base;
                    const originalStopLoss = adjustedChampion.priceTarget.bear;

                    // Log original AI targets for debugging
                    logger.info(`📊 Champion's original targets: TP=${originalTakeProfit.toFixed(6)}, SL=${originalStopLoss.toFixed(6)} (entry=${championshipMarketData.currentPrice.toFixed(6)})`);

                    // Calculate the percentage distances from the original entry
                    const originalEntry = championshipMarketData.currentPrice;
                    const takeProfitPct = (originalTakeProfit - originalEntry) / originalEntry;
                    const stopLossPct = (originalStopLoss - originalEntry) / originalEntry;

                    logger.info(`📊 Target percentages: TP=${(takeProfitPct * 100).toFixed(2)}%, SL=${(stopLossPct * 100).toFixed(2)}%`);

                    // Apply same percentages to fresh price
                    const newTakeProfit = freshPrice * (1 + takeProfitPct);
                    const newStopLoss = freshPrice * (1 + stopLossPct);

                    // Validate the recalculated targets make sense
                    // Add tolerance for floating-point precision issues (0.01% = 0.0001)
                    const PRICE_TOLERANCE = 0.0001;

                    if (isBullish) {
                        // LONG: TP should be above entry, SL should be below entry
                        const tpValid = newTakeProfit > freshPrice * (1 + PRICE_TOLERANCE);
                        const slValid = newStopLoss < freshPrice * (1 - PRICE_TOLERANCE);

                        if (tpValid && slValid) {
                            adjustedChampion.priceTarget = {
                                ...adjustedChampion.priceTarget,
                                base: newTakeProfit,
                                bear: newStopLoss
                            };
                            logger.info(`📊 Price targets recalculated: TP ${originalTakeProfit.toFixed(6)} → ${newTakeProfit.toFixed(6)}, SL ${originalStopLoss.toFixed(6)} → ${newStopLoss.toFixed(6)}`);
                        } else {
                            // Log detailed validation failure for debugging
                            logger.warn(`⚠️ Price target validation failed for LONG:`, {
                                freshPrice: freshPrice.toFixed(6),
                                newTakeProfit: newTakeProfit.toFixed(6),
                                newStopLoss: newStopLoss.toFixed(6),
                                tpValid,
                                slValid,
                                tpAboveEntry: newTakeProfit > freshPrice,
                                slBelowEntry: newStopLoss < freshPrice
                            });

                            // Fallback: use percentage-based targets with proper risk/reward
                            // Use trading style config for TP/SL percentages
                            const tradingStyle = getActiveTradingStyle();
                            const defaultSlPct = tradingStyle.stopLossPercent / 100;
                            const defaultTpPct = tradingStyle.targetProfitPercent / 100;
                            adjustedChampion.priceTarget = {
                                ...adjustedChampion.priceTarget,
                                base: freshPrice * (1 + defaultTpPct),
                                bear: freshPrice * (1 - defaultSlPct)
                            };
                            logger.warn(`⚠️ Using default targets: TP ${(freshPrice * (1 + defaultTpPct)).toFixed(6)}, SL ${(freshPrice * (1 - defaultSlPct)).toFixed(6)} (${tradingStyle.minRiskRewardRatio}:1 R/R ${tradingStyle.style} style)`);
                        }
                    } else {
                        // SHORT: TP should be below entry, SL should be above entry
                        const tpValid = newTakeProfit < freshPrice * (1 - PRICE_TOLERANCE);
                        const slValid = newStopLoss > freshPrice * (1 + PRICE_TOLERANCE);

                        if (tpValid && slValid) {
                            adjustedChampion.priceTarget = {
                                ...adjustedChampion.priceTarget,
                                base: newTakeProfit,
                                bear: newStopLoss
                            };
                            logger.info(`📊 Price targets recalculated: TP ${originalTakeProfit.toFixed(6)} → ${newTakeProfit.toFixed(6)}, SL ${originalStopLoss.toFixed(6)} → ${newStopLoss.toFixed(6)}`);
                        } else {
                            // Log detailed validation failure for debugging
                            logger.warn(`⚠️ Price target validation failed for SHORT:`, {
                                freshPrice: freshPrice.toFixed(6),
                                newTakeProfit: newTakeProfit.toFixed(6),
                                newStopLoss: newStopLoss.toFixed(6),
                                tpValid,
                                slValid,
                                tpBelowEntry: newTakeProfit < freshPrice,
                                slAboveEntry: newStopLoss > freshPrice
                            });

                            // Fallback: use percentage-based targets with proper risk/reward
                            // Use trading style config for TP/SL percentages
                            const tradingStyleShort = getActiveTradingStyle();
                            const defaultSlPct = tradingStyleShort.stopLossPercent / 100;
                            const defaultTpPct = tradingStyleShort.targetProfitPercent / 100;
                            adjustedChampion.priceTarget = {
                                ...adjustedChampion.priceTarget,
                                base: freshPrice * (1 - defaultTpPct),
                                bear: freshPrice * (1 + defaultSlPct)
                            };
                            logger.warn(`⚠️ Using default targets: TP ${(freshPrice * (1 - defaultTpPct)).toFixed(6)}, SL ${(freshPrice * (1 + defaultSlPct)).toFixed(6)} (${tradingStyleShort.minRiskRewardRatio}:1 R/R ${tradingStyleShort.style} style)`);
                        }
                    }
                } // Close: else (oldPrice is valid)
            } // Close: if (freshPrice > 0)
        } catch (err) {
            logger.warn(`Failed to refresh market data for risk council:`, err instanceof Error ? err.message : String(err));
        }

        // Get account state for risk assessment (fresh from WEEX)
        const accountBalance = await this.getWalletBalance();
        const currentPositions = this.getAllPositions();
        const recentPnL = await this.getRecentPnL();

        // Check if engine was stopped before risk council
        if (!this.isRunning) {
            logger.info('🛑 Engine stopped before risk council');
            await this.completeCycle(cycleStart, 'stopped by user');
            return;
        }

        const riskDecision = await collaborativeFlowService.runRiskCouncil(
            adjustedChampion,
            riskCouncilMarketData,
            accountBalance,
            currentPositions,
            recentPnL
        );

        if (riskDecision.warnings.length > 0) {
            logger.warn(`⚠️ Risk warnings: ${riskDecision.warnings.join(', ')}`);
        }

        this.emit('riskCouncilDecision', riskDecision);

        if (!riskDecision.approved) {
            logger.info(`🚫 Trade VETOED by Risk Council: ${riskDecision.vetoReason}`);
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'vetoed by risk council');
            const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
            if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
            return;
        }

        logger.info('✅ Trade APPROVED by Risk Council');

        // =================================================================
        // STAGE 4: EXECUTION - Place trade on WEEX with TP/SL
        // =================================================================
        logger.info('🚀 Stage 4: Executing Trade...');

        // Build coin selection results for compatibility
        const coinSelectionResults = [{
            analystId: coinSelectorWinner,
            picks: [{ symbol: coinSymbol, direction, conviction: 8, reason: coinDebate.reasoning }]
        }];

        // Use the most recent market data for execution
        await this.executeCollaborativeTrade(
            coinSymbol,
            riskCouncilMarketData, // Use refreshed market data
            adjustedChampion,
            riskDecision,
            coinSelectionResults
        );

        // =================================================================
        // STAGE 6: POSITION MANAGEMENT - Update leaderboard
        // =================================================================
        await this.updateLeaderboard();

        await this.completeCycle(cycleStart, 'entry complete');
    }

    /**
     * Refresh contract specifications if stale (older than 30 minutes)
     * This prevents order failures due to expired cache
     * FIXED: Uses instance tracker to prevent race conditions and stale state
     */
    private async refreshContractSpecsIfNeeded(): Promise<void> {
        // Check if any approved symbol is missing from cache
        const missingSpecs = APPROVED_SYMBOLS.filter(symbol => !getContractSpecs(symbol));

        const needsRefresh = missingSpecs.length > 0 || this.contractSpecsTracker.shouldRefresh();

        if (!needsRefresh) {
            return;
        }

        // Prevent concurrent refresh attempts
        if (!this.contractSpecsTracker.markRefreshing()) {
            logger.debug('Contract specs refresh already in progress, skipping');
            return;
        }

        const reason = missingSpecs.length > 0
            ? `missing specs for: ${missingSpecs.join(', ')}`
            : `cache age: ${Math.floor((Date.now() - this.contractSpecsTracker.getLastRefresh()) / 60000)} minutes`;

        logger.info(`🔄 Refreshing contract specs (${reason})...`);

        try {
            const contracts = await this.weexClient.getContracts();
            if (contracts && contracts.length > 0) {
                updateContractSpecs(contracts);
                this.contractSpecsTracker.markRefreshed();
                logger.info(`✅ Contract specs refreshed: ${contracts.length} contracts cached`);
            } else {
                logger.warn('⚠️ WEEX returned empty contracts array during refresh');
                this.contractSpecsTracker.markFailed();
            }
        } catch (error) {
            logger.error('❌ Failed to refresh contract specs:', error);
            this.contractSpecsTracker.markFailed();
            // Don't throw - continue with potentially stale specs rather than failing the cycle
            // The roundToTickSize/roundToStepSize functions will warn if specs are missing
        }
    }

    /**
     * Fetch market data for all approved symbols
     */
    private async fetchAllMarketData(): Promise<Map<string, ExtendedMarketData>> {
        const marketDataMap = new Map<string, ExtendedMarketData>();

        // Fetch in parallel with error handling
        const fetchPromises = APPROVED_SYMBOLS.map(async (symbol) => {
            try {
                const [ticker, fundingRate] = await Promise.all([
                    this.weexClient.getTicker(symbol),
                    this.weexClient.getFundingRate(symbol),
                ]);

                const currentPrice = parseFloat(ticker.last);
                const high24h = parseFloat(ticker.high_24h);
                const low24h = parseFloat(ticker.low_24h);
                const volume24h = parseFloat(ticker.volume_24h);
                const changePercent = parseFloat(ticker.priceChangePercent || '0');
                const parsedFundingRate = parseFloat(fundingRate.fundingRate || '0');

                // Validate all numbers
                if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
                    throw new Error(`Invalid price for ${symbol}: ${currentPrice}`);
                }

                // Validate and calculate change24h after validation
                const change24h = Number.isFinite(changePercent) ? changePercent * 100 : 0;

                // Validate funding rate is present (optional but important for futures trading)
                // undefined means unavailable, 0 means zero funding
                const validFundingRate = Number.isFinite(parsedFundingRate) ? parsedFundingRate : undefined;
                if (validFundingRate === undefined) {
                    logger.warn(`Funding rate unavailable for ${symbol}, will be treated as missing data`);
                }

                const marketData: ExtendedMarketData = {
                    symbol,
                    currentPrice,
                    high24h: Number.isFinite(high24h) ? high24h : currentPrice,
                    low24h: Number.isFinite(low24h) ? low24h : currentPrice,
                    volume24h: Number.isFinite(volume24h) ? volume24h : 0,
                    change24h: Number.isFinite(change24h) ? change24h : 0,
                    fetchTimestamp: Date.now(), // Add timestamp for data age tracking
                    markPrice: parseFloat(ticker.markPrice || ticker.last),
                    indexPrice: parseFloat(ticker.indexPrice || ticker.last),
                    bestBid: parseFloat(ticker.best_bid || '0'),
                    bestAsk: parseFloat(ticker.best_ask || '0'),
                    fundingRate: validFundingRate, // undefined if unavailable, number (including 0) if available
                };

                marketDataMap.set(symbol, marketData);
                this.currentCycle?.symbolsAnalyzed.push(symbol);
            } catch (error) {
                logger.warn(`Failed to fetch ${symbol}:`, error instanceof Error ? error.message : String(error));
            }
        });

        await Promise.allSettled(fetchPromises);

        return marketDataMap;
    }

    // =========================================================================
    // COLLABORATIVE FLOW HELPER METHODS
    // =========================================================================

    /**
     * Get the shared balance for collaborative trading
     * ALWAYS fetches from WEEX wallet - this is the source of truth
     */
    private async getWalletBalance(): Promise<number> {
        try {
            const assets = await this.weexClient.getAccountAssets();
            const balance = parseFloat(assets.available || '0');
            if (!Number.isFinite(balance) || balance < 0) {
                logger.warn(`Invalid wallet balance from WEEX: ${balance}`);
                return 0;
            }
            return balance;
        } catch (error) {
            logger.error('Failed to fetch wallet balance:', error);
            // Return cached balance as fallback
            const firstAnalyst = this.analystStates.values().next().value;
            return firstAnalyst?.balance ?? 0;
        }
    }

    /**
     * Get all current positions (shared in collaborative mode)
     * Includes entry price and unrealized PnL for risk assessment
     */
    private getAllPositions(): Array<{ symbol: string; side: string; size: number; entryPrice?: number; unrealizedPnl?: number }> {
        const firstAnalyst = this.analystStates.values().next().value;
        if (!firstAnalyst) return [];

        return firstAnalyst.positions.map(pos => ({
            symbol: pos.symbol,
            side: pos.side,
            size: pos.size,
            entryPrice: pos.entryPrice,
            unrealizedPnl: pos.unrealizedPnl // Propagate computed value from getAnalystPositions
        }));
    }

    /**
     * Get recent P&L for risk assessment
     * Uses realized_pnl column from trades table
     * 
     * EDGE CASES HANDLED:
     * - NaN/Infinity values from database
     * - Division by zero protection
     * 
     * PERFORMANCE OPTIMIZED: Reduced from 4 queries to 2 queries
     */
    private async getRecentPnL(): Promise<{ day: number; week: number }> {
        try {
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            // OPTIMIZED: Fetch trades once and calculate both aggregates and volume
            const [dayTrades, weekTrades] = await Promise.all([
                prisma.trade.findMany({
                    where: {
                        executedAt: { gt: oneDayAgo },
                        status: 'FILLED'
                    },
                    select: { size: true, price: true, realizedPnl: true }
                }),
                prisma.trade.findMany({
                    where: {
                        executedAt: { gt: oneWeekAgo },
                        status: 'FILLED'
                    },
                    select: { size: true, price: true, realizedPnl: true }
                })
            ]);

            // Calculate P&L and volume in one pass
            let dayPnL = 0;
            let dayVolume = 0;
            for (const trade of dayTrades) {
                dayPnL += trade.realizedPnl ?? 0;
                dayVolume += Math.abs(trade.size * trade.price);
            }

            let weekPnL = 0;
            let weekVolume = 0;
            for (const trade of weekTrades) {
                weekPnL += trade.realizedPnl ?? 0;
                weekVolume += Math.abs(trade.size * trade.price);
            }

            // Validate all values with proper fallbacks
            const safeDayPnL = Number.isFinite(dayPnL) ? dayPnL : 0;
            const safeWeekPnL = Number.isFinite(weekPnL) ? weekPnL : 0;

            // CRITICAL FIX: Calculate drawdown as % of account balance, not volume
            // This ensures the limit is enforced correctly
            const currentBalance = await this.getWalletBalance();

            // Guard against division by zero
            const safeBalance = Number.isFinite(currentBalance) && currentBalance > 0 ? currentBalance : 1;

            const dayPercent = (safeDayPnL / safeBalance) * 100;
            const weekPercent = (safeWeekPnL / safeBalance) * 100;

            return {
                day: Number.isFinite(dayPercent) ? dayPercent : 0,
                week: Number.isFinite(weekPercent) ? weekPercent : 0
            };
        } catch (error) {
            logger.warn('Failed to fetch recent P&L:', error);
            return { day: 0, week: 0 };
        }
    }

    /**
     * Get recent P&L with caching to reduce database load
     * Cache is valid for 1 minute
     */
    private async getRecentPnLCached(): Promise<{ day: number; week: number }> {
        const now = Date.now();
        if (this.weeklyPnLCache && (now - this.weeklyPnLCache.timestamp) < this.WEEKLY_PNL_CACHE_MS) {
            return this.weeklyPnLCache.value;
        }

        const value = await this.getRecentPnL();
        this.weeklyPnLCache = { value, timestamp: now };
        return value;
    }

    /**
     * Get actual daily trade count from database
     * This ensures the limit cannot be bypassed by restarting the engine
     */
    private async getDailyTradeCount(): Promise<number> {
        try {
            const todayStart = new Date();
            todayStart.setUTCHours(0, 0, 0, 0);

            const count = await prisma.trade.count({
                where: {
                    executedAt: { gte: todayStart },
                    status: 'FILLED'
                }
            });

            return count;
        } catch (error) {
            logger.error('Failed to fetch daily trade count:', error);
            // Return high number to be safe (block trades if DB fails)
            return config.trading.maxDailyTrades;
        }
    }

    /**
     * Execute a collaborative trade (Stage 5)
     * Places the trade on WEEX with TP/SL orders
     */
    private async executeCollaborativeTrade(
        symbol: string,
        marketData: ExtendedMarketData,
        champion: AnalysisResult,
        riskDecision: RiskCouncilDecision,
        coinSelectors: CoinSelectionResult[]
    ): Promise<void> {
        // =================================================================
        // CRITICAL SAFETY CHECKS - Programmatic enforcement of config limits
        // These are HARD STOPS that prevent AI from bypassing limits
        // =================================================================

        // 1. MAX CONCURRENT POSITIONS CHECK
        const currentPositions = this.getAllPositions();
        if (currentPositions.length >= config.autonomous.maxConcurrentPositions) {
            logger.warn(`🚫 Max concurrent positions reached (${currentPositions.length}/${config.autonomous.maxConcurrentPositions}), skipping trade`);
            this.currentCycle?.errors.push(`Max concurrent positions: ${currentPositions.length}/${config.autonomous.maxConcurrentPositions}`);
            this.emit('safetyCheckFailed', {
                check: 'maxConcurrentPositions',
                current: currentPositions.length,
                limit: config.autonomous.maxConcurrentPositions,
                timestamp: Date.now()
            });
            return;
        }

        // 2. WEEKLY DRAWDOWN CHECK (with caching)
        const recentPnL = await this.getRecentPnLCached();
        if (recentPnL.week < -config.autonomous.weeklyDrawdownLimitPercent) {
            logger.warn(`🚫 Weekly drawdown limit exceeded (${recentPnL.week.toFixed(2)}% < -${config.autonomous.weeklyDrawdownLimitPercent}%), skipping trade`);
            this.currentCycle?.errors.push(`Weekly drawdown: ${recentPnL.week.toFixed(2)}% exceeds -${config.autonomous.weeklyDrawdownLimitPercent}%`);
            this.emit('safetyCheckFailed', {
                check: 'weeklyDrawdown',
                current: recentPnL.week,
                limit: -config.autonomous.weeklyDrawdownLimitPercent,
                timestamp: Date.now()
            });
            return;
        }

        // 3. PER-ANALYST TRADE COOLDOWN CHECK
        // CRITICAL FIX: Cooldown bypass if analyst state is missing
        // Validate analystId and initialize state with proper portfolioId
        let analystState = this.analystStates.get(champion.analystId);
        if (!analystState) {
            // SECURITY: Validate champion.analystId is a known analyst
            if (!ANALYST_IDS.includes(champion.analystId as any)) {
                logger.error(`🚫 Invalid analyst ID: ${champion.analystId} - aborting trade`);
                this.currentCycle?.errors.push(`Invalid analyst ID: ${champion.analystId}`);
                this.emit('safetyCheckFailed', {
                    check: 'invalidAnalystId',
                    analyst: champion.analystId,
                    timestamp: Date.now()
                });
                return;
            }

            logger.warn(`⚠️ Analyst state not found for ${champion.analystId}, initializing with proper portfolioId`);

            // Get portfolioId from any existing analyst state (they all share the same portfolio)
            const firstAnalyst = this.analystStates.values().next().value;
            const portfolioId = firstAnalyst?.portfolioId || '';

            // If no portfolioId available from existing states, fetch from database
            if (!portfolioId) {
                try {
                    const portfolio = await queryOne<any>(
                        'SELECT id FROM portfolios WHERE agent_id = $1',
                        ['collaborative']
                    );
                    if (!portfolio) {
                        logger.error(`🚫 No collaborative portfolio found - cannot initialize analyst state`);
                        this.currentCycle?.errors.push(`No collaborative portfolio found for ${champion.analystId}`);
                        return;
                    }
                    // Initialize with fetched portfolioId
                    analystState = {
                        analystId: champion.analystId,
                        portfolioId: portfolio.id,
                        balance: 0,
                        positions: [],
                        lastTradeTime: 0,
                        totalTrades: 0,
                        winRate: 0,
                        consecutiveWins: 0,
                        consecutiveLosses: 0
                    };
                } catch (error) {
                    logger.error(`🚫 Failed to fetch portfolio for analyst state initialization:`, error);
                    this.currentCycle?.errors.push(`Failed to initialize ${champion.analystId} state`);
                    return;
                }
            } else {
                // Initialize with portfolioId from existing analyst
                analystState = {
                    analystId: champion.analystId,
                    portfolioId: portfolioId,
                    balance: 0,
                    positions: [],
                    lastTradeTime: 0,
                    totalTrades: 0,
                    winRate: 0,
                    consecutiveWins: 0,
                    consecutiveLosses: 0
                };
            }

            // Atomically store the initialized state
            this.analystStates.set(champion.analystId, analystState);
            logger.info(`✅ Initialized analyst state for ${champion.analystId} with portfolioId: ${analystState.portfolioId}`);
        }

        // Now check cooldown with guaranteed valid state
        const timeSinceLastTrade = Date.now() - analystState.lastTradeTime;
        if (timeSinceLastTrade < config.autonomous.minTradeIntervalMs) {
            const remainingMs = config.autonomous.minTradeIntervalMs - timeSinceLastTrade;
            const remainingMin = Math.ceil(remainingMs / 60000);
            logger.warn(`🚫 Trade cooldown active for ${champion.analystId} (${remainingMin} min remaining), skipping trade`);
            this.currentCycle?.errors.push(`Trade cooldown: ${champion.analystId} must wait ${remainingMin} min`);
            this.emit('safetyCheckFailed', {
                check: 'tradeCooldown',
                analyst: champion.analystId,
                remainingMs,
                timestamp: Date.now()
            });
            return;
        }

        // 4. MAX DAILY TRADES CHECK (query database for persistence across restarts)
        const dailyCount = await this.getDailyTradeCount();
        if (dailyCount >= config.trading.maxDailyTrades) {
            logger.warn(`🚫 Max daily trades reached (${dailyCount}/${config.trading.maxDailyTrades}), skipping trade`);
            this.currentCycle?.errors.push(`Max daily trades: ${dailyCount}/${config.trading.maxDailyTrades}`);
            this.emit('safetyCheckFailed', {
                check: 'maxDailyTrades',
                current: dailyCount,
                limit: config.trading.maxDailyTrades,
                timestamp: Date.now()
            });
            return;
        }

        logger.info(`✅ Safety checks passed: ${currentPositions.length}/${config.autonomous.maxConcurrentPositions} positions, weekly P&L: ${recentPnL.week.toFixed(2)}%, daily trades: ${dailyCount}/${config.trading.maxDailyTrades}`);

        // =================================================================
        // MARKET DATA VALIDATION
        // =================================================================

        // CRITICAL: Validate market data freshness before executing trade
        const dataAge = marketData.fetchTimestamp ? Date.now() - marketData.fetchTimestamp : Infinity;
        const MAX_DATA_AGE_MS = 60000; // 60 seconds - AI must use fresh data

        if (dataAge > MAX_DATA_AGE_MS) {
            const ageSeconds = Math.floor(dataAge / 1000);
            logger.error(`🚨 Market data too stale (${ageSeconds}s old), aborting trade for safety`);
            this.currentCycle?.errors.push(`Stale market data: ${ageSeconds}s old (max: 60s)`);
            return;
        }

        if (dataAge > 30000) {
            logger.warn(`⚠️ Market data is ${Math.floor(dataAge / 1000)}s old (acceptable but not ideal)`);
        }

        const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
        const direction = isBullish ? 'LONG' : 'SHORT';

        const positionSize = riskDecision.adjustments?.positionSize ?? champion.positionSize;
        const leverage = Math.min(5, riskDecision.adjustments?.leverage ?? 3);
        const stopLoss = riskDecision.adjustments?.stopLoss ?? champion.priceTarget.bear;

        // Get fresh balance from WEEX wallet
        const accountBalance = await this.getWalletBalance();

        // Check minimum balance to trade
        if (accountBalance < this.MIN_BALANCE_TO_TRADE) {
            logger.warn(`Account balance ${accountBalance.toFixed(2)} below minimum ${this.MIN_BALANCE_TO_TRADE} to trade`);
            this.currentCycle?.errors.push(`Insufficient balance: ${accountBalance.toFixed(2)} < ${this.MIN_BALANCE_TO_TRADE}`);
            return;
        }

        const positionPercent = Math.min(this.MAX_POSITION_SIZE_PERCENT, (positionSize / 10) * this.MAX_POSITION_SIZE_PERCENT);
        const positionValue = accountBalance * (positionPercent / 100);
        const marginRequired = leverage > 0 ? positionValue / leverage : positionValue;

        // Guard against division by zero
        if (!Number.isFinite(marketData.currentPrice) || marketData.currentPrice <= 0) {
            logger.error(`Invalid market price: ${marketData.currentPrice}`);
            this.currentCycle?.errors.push('Invalid market price');
            return;
        }

        let size = positionValue / marketData.currentPrice;

        if (!Number.isFinite(size) || size <= 0) {
            logger.error(`Invalid position size calculated: ${size}`);
            this.currentCycle?.errors.push('Invalid position size');
            return;
        }

        // Validate marginRequired
        if (!Number.isFinite(marginRequired) || marginRequired <= 0) {
            logger.error(`Invalid margin required: ${marginRequired}`);
            this.currentCycle?.errors.push('Invalid margin calculation');
            return;
        }

        // Validate price targets before using them
        const takeProfitPrice = champion.priceTarget?.base;
        if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) {
            logger.error(`Invalid take profit price: ${takeProfitPrice}`);
            this.currentCycle?.errors.push('Invalid take profit price');
            return;
        }

        if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
            logger.error(`Invalid stop loss price: ${stopLoss}`);
            this.currentCycle?.errors.push('Invalid stop loss price');
            return;
        }

        const clientOrderId = `collab_${champion.analystId}_${Date.now()}`;
        const orderType = direction === 'LONG' ? '1' : '2';

        // CRITICAL: Ensure contract specs are available before placing order
        // This prevents order rejection due to wrong tick/step sizes
        const { getContractSpecs } = await import('../../shared/utils/weex');
        let contractSpecs = getContractSpecs(symbol);

        // If specs are missing, try to refresh them before proceeding
        if (!contractSpecs) {
            logger.warn(`⚠️ Contract specs missing for ${symbol}, attempting refresh before order...`);
            try {
                const contracts = await this.weexClient.getContracts();
                if (contracts && contracts.length > 0) {
                    updateContractSpecs(contracts);
                    contractSpecs = getContractSpecs(symbol);
                    if (contractSpecs) {
                        logger.info(`✅ Contract specs refreshed successfully for ${symbol}`);
                    }
                }
            } catch (error) {
                logger.error(`❌ Failed to refresh contract specs before order:`, error);
            }
        }

        if (contractSpecs) {
            // Validate size is within contract limits
            if (size < contractSpecs.minOrderSize) {
                logger.error(`Position size ${size} below minimum ${contractSpecs.minOrderSize} for ${symbol}`);
                this.currentCycle?.errors.push(`Position size below minimum for ${symbol}`);
                return;
            }
            if (size > contractSpecs.maxOrderSize) {
                logger.warn(`Position size ${size} exceeds maximum ${contractSpecs.maxOrderSize} for ${symbol}, capping to max`);
                size = contractSpecs.maxOrderSize;
            }
        } else {
            // CRITICAL: If specs are still missing after refresh attempt, abort the trade
            // This prevents order rejection due to wrong tick/step sizes
            logger.error(`❌ CRITICAL: Contract specs unavailable for ${symbol} even after refresh - aborting trade to prevent rejection`);
            this.currentCycle?.errors.push(`Contract specs unavailable for ${symbol}`);
            return;
        }

        // CRITICAL DEBUG: Log exact values before creating order
        logger.info(`📋 Order parameters before submission:`);
        logger.info(`  Direction: ${direction} (type=${orderType})`);
        logger.info(`  Entry Price: ${marketData.currentPrice}`);
        logger.info(`  Take Profit (champion.priceTarget.base): ${takeProfitPrice}`);
        logger.info(`  Stop Loss (riskDecision or champion.priceTarget.bear): ${stopLoss}`);
        logger.info(`  Validation: TP ${direction === 'LONG' ? '>' : '<'} Entry? ${direction === 'LONG' ? takeProfitPrice > marketData.currentPrice : takeProfitPrice < marketData.currentPrice}`);
        logger.info(`  Validation: SL ${direction === 'LONG' ? '<' : '>'} Entry? ${direction === 'LONG' ? stopLoss < marketData.currentPrice : stopLoss > marketData.currentPrice}`);

        const order = {
            symbol,
            type: orderType as '1' | '2' | '3' | '4',
            size: roundToStepSize(size, symbol),
            client_oid: clientOrderId,
            order_type: '2' as '0' | '1' | '2' | '3', // FOK
            match_price: '1' as '0' | '1', // Market price
            price: roundToTickSize(marketData.currentPrice, symbol), // Required but ignored for market orders
            presetTakeProfitPrice: roundToTickSize(takeProfitPrice, symbol),
            presetStopLossPrice: roundToTickSize(stopLoss, symbol),
        };

        // CRITICAL: Validate rounded size is valid before placing order
        const roundedSize = parseFloat(order.size);
        if (!Number.isFinite(roundedSize) || roundedSize <= 0) {
            logger.error(`Rounded size is invalid or zero: ${order.size} (original: ${size})`);
            this.currentCycle?.errors.push(`Invalid rounded size: ${order.size}`);
            return;
        }

        logger.info(`📋 Order object after rounding:`);
        logger.info(`  size: ${order.size} (validated: ${roundedSize})`);
        logger.info(`  presetTakeProfitPrice: ${order.presetTakeProfitPrice}`);
        logger.info(`  presetStopLossPrice: ${order.presetStopLossPrice}`);

        const firstAnalyst = this.analystStates.values().next().value;
        if (!firstAnalyst) {
            logger.error('No analyst state available for trade execution');
            return;
        }

        if (this.DRY_RUN) {
            logger.info(`[DRY RUN] Would execute ${direction} on ${symbol}`);
            logger.info(`  Champion: ${champion.analystName} (${champion.confidence}%)`);
            logger.info(`  Size: ${size.toFixed(6)} (${positionPercent.toFixed(1)}% of account)`);
            logger.info(`  Leverage: ${leverage}x`);
            logger.info(`  Entry: ${marketData.currentPrice.toFixed(2)}`);
            logger.info(`  Take Profit: ${champion.priceTarget.base.toFixed(2)}`);
            logger.info(`  Stop Loss: ${stopLoss.toFixed(2)}`);

            if (this.currentCycle) {
                this.currentCycle.tradesExecuted++;
            }

            this.emit('tradeExecuted', { symbol, direction, champion: champion.analystName, dryRun: true });
            return;
        }

        try {
            const response = await this.weexClient.placeOrder(order);
            logger.info(`✅ Order placed: ${direction} ${symbol} (Order ID: ${response.order_id})`);

            // FIXED: Create AI log for WEEX compliance using AILogService
            // This ensures logs are saved to database AND uploaded to WEEX
            try {
                await aiLogService.createLog(
                    'execution', // Maps to COLLABORATIVE_TRADE in Prisma
                    config.ai.model || 'unknown',
                    {
                        symbol,
                        direction,
                        champion: champion.analystName,
                        confidence: champion.confidence,
                        coinSelectors: coinSelectors.map(cs => cs.analystId),
                        marketData: {
                            price: marketData.currentPrice,
                            volume24h: marketData.volume24h,
                            change24h: marketData.change24h
                        }
                    },
                    {
                        orderId: response.order_id,
                        size: size.toFixed(8),
                        leverage,
                        priceTargets: champion.priceTarget,
                        executedAt: new Date().toISOString()
                    },
                    `[${champion.analystName}] ${champion.thesis}`,
                    String(response.order_id) // orderId for WEEX upload
                );
                logger.info(`📝 AI log created and uploaded for order ${response.order_id}`);
            } catch (logError) {
                logger.error('Failed to create AI log:', logError);
                // Don't throw - log failure shouldn't block trade recording
            }

            await this.saveTrade(firstAnalyst.portfolioId, {
                symbol,
                side: direction,
                size,
                price: marketData.currentPrice,
                orderId: parseInt(String(response.order_id), 10),
                clientOrderId,
                reason: `[${champion.analystName}] ${champion.thesis}`,
                confidence: champion.confidence,
                championId: champion.analystId, // FIXED: Pass championId to track debate winner
            });

            // Update trade stats (balance will be refreshed from WEEX on next cycle)
            const now = Date.now();
            for (const state of this.analystStates.values()) {
                state.lastTradeTime = now;
                state.totalTrades++;
            }

            // Increment daily trade counter
            // NOTE: Counter is now queried from database, no need to increment in-memory

            if (this.currentCycle) {
                this.currentCycle.tradesExecuted++;
            }

            this.emit('tradeExecuted', {
                symbol, direction, champion: champion.analystName,
                orderId: response.order_id, size, leverage, dryRun: false
            });

            logger.info(`🎯 Trade complete: ${direction} ${symbol} by ${champion.analystName}`);

        } catch (error) {
            logger.error('Trade execution failed:', error);
            this.currentCycle?.errors.push(`Trade execution failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Sync closed orders from WEEX that we missed (SL/TP triggered automatically)
     * This ensures realized P&L is recorded even when WEEX closes positions via SL/TP
     * 
     * EDGE CASES HANDLED:
     * - Breakeven trades (totalProfits = 0) are still recorded
     * - NaN/Infinity validation on all numeric fields
     * - Multiple entry trades for same symbol - matches by size
     * - Batch query for existing closures to avoid N+1
     */
    private async syncClosedOrdersFromWeex(): Promise<void> {
        try {
            // Get all symbols we have entry trades for (that haven't been closed yet)
            const entryTrades = await prisma.trade.findMany({
                where: {
                    status: 'FILLED',
                    realizedPnl: null, // Entry trades only
                    reason: { not: { startsWith: 'MANAGE:' } },
                    // Only look at recent trades (last 7 days) to limit scope
                    executedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
                },
                select: { id: true, symbol: true, weexOrderId: true, championId: true, side: true, size: true, price: true, executedAt: true }
            });

            if (entryTrades.length === 0) return;

            // Get unique symbols
            const symbols = [...new Set(entryTrades.map(t => t.symbol))];

            // Get collaborative portfolio ID - MUST be a valid UUID from DB
            let portfolioId: string;
            const collabPortfolio = await prisma.portfolio.findFirst({
                where: { agentId: 'collaborative' },
                select: { id: true }
            });

            if (!collabPortfolio) {
                // Portfolio doesn't exist - this shouldn't happen in normal operation
                // Create it to ensure we have a valid FK reference
                logger.warn('Collaborative portfolio not found, creating one for sync...');
                const newPortfolio = await prisma.portfolio.create({
                    data: {
                        agentId: 'collaborative',
                        agentName: 'Collaborative AI Team',
                        initialBalance: 0,
                        currentBalance: 0,
                        totalValue: 0,
                        totalReturn: 0,
                        totalReturnDollar: 0,
                        winRate: 0,
                        maxDrawdown: 0,
                        currentDrawdown: 0,
                        totalTrades: 0,
                        winningTrades: 0,
                        losingTrades: 0,
                        tournamentWins: 0,
                        totalPoints: 0,
                        status: 'active'
                    }
                });
                portfolioId = newPortfolio.id;
            } else {
                portfolioId = collabPortfolio.id;
            }

            // Batch fetch all existing closure order IDs to avoid N+1 queries
            const existingClosures = await prisma.trade.findMany({
                where: {
                    realizedPnl: { not: null },
                    weexOrderId: { not: null }
                },
                select: { weexOrderId: true }
            });
            const existingOrderIds = new Set(existingClosures.map(c => c.weexOrderId).filter(Boolean));

            let syncedCount = 0;

            for (const symbol of symbols) {
                try {
                    // Get order history from WEEX
                    const orders = await this.weexClient.getHistoryOrders(symbol, 50);

                    // Get entry trades for this symbol
                    const symbolEntryTrades = entryTrades.filter(t => t.symbol === symbol);

                    for (const order of orders) {
                        // Only process filled orders
                        if (order.status !== 'filled') continue;

                        // Skip if already recorded
                        if (existingOrderIds.has(order.orderId)) continue;

                        // Parse and validate totalProfits - include 0 (breakeven) but exclude null/undefined
                        const totalProfits = parseFloat(order.totalProfits || '');
                        if (!Number.isFinite(totalProfits)) continue; // Skip if not a valid number (NaN from empty string)

                        // Skip entry orders (they have no P&L impact, totalProfits would be from previous trades)
                        // Entry orders typically have the same side as the position direction
                        // Close orders have opposite side
                        const orderSide = order.side?.toUpperCase();
                        if (!orderSide) continue;

                        // Find the matching entry trade to get championId
                        // Match by: symbol, opposite side, and closest size
                        const matchingEntries = symbolEntryTrades.filter(t =>
                            // Match opposite side (entry BUY -> close SELL, entry SELL -> close BUY)
                            (t.side === 'BUY' && orderSide === 'SELL') ||
                            (t.side === 'SELL' && orderSide === 'BUY')
                        );

                        if (matchingEntries.length === 0) continue;

                        // If multiple matches, pick the one with closest size
                        const orderSize = parseFloat(order.filledQty || order.size || '0');
                        let bestMatch = matchingEntries[0];
                        let bestSizeDiff = Math.abs(bestMatch.size - orderSize);

                        for (const entry of matchingEntries) {
                            const sizeDiff = Math.abs(entry.size - orderSize);
                            if (sizeDiff < bestSizeDiff) {
                                bestSizeDiff = sizeDiff;
                                bestMatch = entry;
                            }
                        }

                        // Parse and validate other fields
                        const closeSize = Number.isFinite(orderSize) && orderSize > 0 ? orderSize : bestMatch.size;
                        const closePrice = parseFloat(order.priceAvg || order.price || '0');
                        if (!Number.isFinite(closePrice) || closePrice <= 0) continue;

                        // Parse createTime - could be milliseconds timestamp or date string
                        let executedAt: Date;
                        const createTimeNum = parseInt(order.createTime);
                        if (Number.isFinite(createTimeNum) && createTimeNum > 0) {
                            // If it's a reasonable timestamp (after year 2020)
                            executedAt = createTimeNum > 1577836800000 ? new Date(createTimeNum) : new Date(createTimeNum * 1000);
                        } else {
                            executedAt = new Date();
                        }

                        // Record the closure trade
                        const tradeId = crypto.randomUUID();
                        const closeSide = orderSide === 'BUY' ? 'BUY' : 'SELL';

                        await prisma.trade.create({
                            data: {
                                id: tradeId,
                                portfolioId: portfolioId,
                                symbol: symbol,
                                side: closeSide as 'BUY' | 'SELL',
                                type: 'MARKET',
                                size: closeSize,
                                price: closePrice,
                                status: 'FILLED',
                                reason: `AUTO: SL/TP triggered on WEEX`,
                                championId: bestMatch.championId,
                                weexOrderId: order.orderId,
                                realizedPnl: totalProfits,
                                executedAt: executedAt,
                                createdAt: new Date()
                            }
                        });

                        // Add to set to prevent duplicate processing in same run
                        existingOrderIds.add(order.orderId);
                        syncedCount++;

                        const pnlSign = totalProfits >= 0 ? '+' : '';
                        logger.info(`📊 Synced closed order: ${symbol} ${closeSide} P&L: ${pnlSign}${totalProfits.toFixed(2)} (${bestMatch.championId})`);
                    }
                } catch (symbolError) {
                    logger.debug(`Failed to sync orders for ${symbol}:`, symbolError);
                }
            }

            if (syncedCount > 0) {
                logger.info(`✅ Synced ${syncedCount} closed orders from WEEX`);
            }
        } catch (error) {
            logger.warn('Failed to sync closed orders from WEEX:', error);
        }
    }

    /**
     * Update leaderboard and portfolio values
     * Balance is ALWAYS fetched from WEEX wallet (source of truth)
     */
    private async updateLeaderboard(): Promise<void> {
        // First sync any closed orders we might have missed
        await this.syncClosedOrdersFromWeex();

        try {
            // Get actual wallet balance from WEEX (source of truth)
            const walletBalance = await this.getWalletBalance();

            // Get all positions from WEEX
            const positions = await this.getAnalystPositions();

            // Batch fetch all unique tickers needed for P&L calculation
            const uniqueSymbols = [...new Set(positions.map(p => p.symbol))];
            const tickerCache = new Map<string, number>();

            await Promise.all(
                uniqueSymbols.map(async (symbol) => {
                    try {
                        const ticker = await this.weexClient.getTicker(symbol);
                        const currentPrice = parseFloat(ticker.last);
                        if (Number.isFinite(currentPrice) && currentPrice > 0) {
                            tickerCache.set(symbol, currentPrice);
                        }
                    } catch {
                        // Ignore ticker fetch errors
                    }
                })
            );

            // Calculate unrealized P&L
            const unrealizedPnL = positions.reduce((sum, p) => {
                const currentPrice = tickerCache.get(p.symbol);
                if (!currentPrice) return sum;

                const pnl = p.side === 'LONG'
                    ? (currentPrice - p.entryPrice) * p.size
                    : (p.entryPrice - currentPrice) * p.size;
                return sum + (Number.isFinite(pnl) ? pnl : 0);
            }, 0);

            // Total value = wallet balance + unrealized P&L from positions
            const totalValue = walletBalance + unrealizedPnL;

            // Get first analyst to access portfolioId
            const firstAnalyst = this.analystStates.values().next().value;
            if (!firstAnalyst) return;

            // Update all analysts with the same values (collaborative mode)
            for (const state of this.analystStates.values()) {
                state.positions = positions;
                state.balance = walletBalance; // Always from WEEX wallet
            }

            // Update database for display purposes
            if (Number.isFinite(totalValue)) {
                await prisma.portfolio.update({
                    where: { id: firstAnalyst.portfolioId },
                    data: {
                        currentBalance: walletBalance,
                        totalValue: totalValue,
                        updatedAt: new Date()
                    }
                });

                // FIXED: Create performance snapshot for circuit breaker drawdown calculations
                // Snapshots are used by CircuitBreakerService to calculate 24h portfolio drawdown
                try {
                    // CRITICAL FIX: Validate totalValue before saving
                    // Allow negative values (portfolio can be in loss) but reject NaN/Infinity
                    if (!Number.isFinite(totalValue)) {
                        logger.error(`Invalid totalValue for snapshot: ${totalValue}, skipping`);
                    } else {
                        // FIXED: Round timestamp to nearest minute to reduce duplicates
                        const roundedTimestamp = new Date(
                            Math.floor(Date.now() / 60000) * 60000
                        );

                        // FIXED: Try to create snapshot, ignore if duplicate (unique constraint)
                        try {
                            await prisma.performanceSnapshot.create({
                                data: {
                                    portfolioId: firstAnalyst.portfolioId,
                                    totalValue: totalValue,
                                    timestamp: roundedTimestamp
                                }
                            });
                            // FIXED: Only reset failure count on successful create
                            this.snapshotFailureCount = 0;
                        } catch (createError: any) {
                            // Ignore unique constraint violations (P2002) - snapshot already exists
                            if (createError.code !== 'P2002') {
                                throw createError;
                            }
                            // Duplicate snapshot is fine - unique constraint prevents it
                            // Don't reset failure count for duplicates
                        }
                    }

                    // CRITICAL FIX: Cleanup old snapshots only once per hour (not every cycle)
                    // This prevents excessive database operations and lock contention
                    // FIXED: Use batch deletion to prevent lock contention on large datasets
                    const now = Date.now();
                    if (now - this.lastSnapshotCleanup > this.SNAPSHOT_CLEANUP_INTERVAL_MS) {
                        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
                        let deletedTotal = 0;

                        // Delete in batches to prevent lock contention
                        // Note: Prisma deleteMany doesn't support 'take', so we delete all at once
                        // For very large datasets, consider using raw SQL with LIMIT
                        const deleted = await prisma.performanceSnapshot.deleteMany({
                            where: {
                                portfolioId: firstAnalyst.portfolioId,
                                timestamp: { lt: sevenDaysAgo }
                            }
                        });
                        deletedTotal = deleted.count;

                        this.lastSnapshotCleanup = now;
                        if (deletedTotal > 0) {
                            logger.info(`🧹 Cleaned up ${deletedTotal} old performance snapshots`);
                        }
                    }
                } catch (snapshotError) {
                    this.snapshotFailureCount++;
                    logger.error(`Failed to create performance snapshot (${this.snapshotFailureCount}/${this.MAX_SNAPSHOT_FAILURES}):`,
                        snapshotError instanceof Error ? snapshotError.message : String(snapshotError));

                    // CRITICAL: Alert if snapshots are failing repeatedly
                    if (this.snapshotFailureCount >= this.MAX_SNAPSHOT_FAILURES) {
                        logger.error('🚨 CRITICAL: Performance snapshots failing repeatedly - circuit breaker may not work!');
                        this.emit('snapshotFailure', { count: this.snapshotFailureCount });
                    }
                    // Don't throw - snapshot creation failure shouldn't stop trading
                }
            }
        } catch (error) {
            logger.warn('Failed to update leaderboard:', error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Get analyst's current positions from WEEX
     * Includes unrealized PnL calculation
     */
    private async getAnalystPositions(): Promise<AnalystState['positions']> {
        try {
            const weexPositions = await this.weexClient.getPositions();

            // Fetch current prices for unrealized PnL calculation
            const symbolsToFetch = [...new Set(weexPositions.map(p => p.symbol))];
            const priceMap = new Map<string, number>();

            // Batch fetch tickers for all position symbols
            await Promise.all(symbolsToFetch.map(async (symbol) => {
                try {
                    const ticker = await this.weexClient.getTicker(symbol);
                    const price = parseFloat(ticker.last);
                    if (Number.isFinite(price) && price > 0) {
                        priceMap.set(symbol, price);
                    }
                } catch (err) {
                    logger.warn(`Failed to fetch ticker for ${symbol}:`, err instanceof Error ? err.message : String(err));
                }
            }));

            return weexPositions.map(p => {
                // Positions are now normalized by WeexClient - use camelCase properties
                const openValue = parseFloat(p.openValue || '0');
                const size = parseFloat(p.size);
                const leverage = parseFloat(p.leverage);

                if (!Number.isFinite(size) || size === 0) return null;

                // Calculate entry price: openValue / size
                // Note: markPrice is not available from position endpoint, would need separate ticker call
                let entryPrice: number;
                if (Number.isFinite(openValue) && openValue > 0 && size > 0) {
                    entryPrice = openValue / size;
                } else {
                    // Skip positions with no valid price data
                    logger.warn(`Position ${p.symbol} has no valid price data (openValue: ${openValue}, size: ${size}), skipping`);
                    return null;
                }

                // Calculate unrealized PnL
                let unrealizedPnl: number | undefined;
                const currentPrice = priceMap.get(p.symbol);
                if (currentPrice && Number.isFinite(currentPrice)) {
                    const priceDiff = currentPrice - entryPrice;
                    // For LONG: profit when price goes up, for SHORT: profit when price goes down
                    const direction = p.side === 'LONG' ? 1 : -1;
                    unrealizedPnl = priceDiff * size * direction;

                    // Validate the result
                    if (!Number.isFinite(unrealizedPnl)) {
                        unrealizedPnl = undefined;
                    }
                }

                return {
                    symbol: p.symbol,
                    side: p.side, // Already normalized to 'LONG' | 'SHORT' by normalizeWeexPosition
                    size,
                    entryPrice,
                    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : ASSUMED_AVERAGE_LEVERAGE,
                    unrealizedPnl,
                };
            }).filter((p): p is NonNullable<typeof p> => p !== null);
        } catch (error) {
            logger.warn('Failed to fetch positions:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }

    /**
     * Save trade to database
     * 
     * EDGE CASES HANDLED:
     * - Invalid trade data validation
     * - Database errors don't throw (trade already executed on WEEX)
     * 
     * FIXED: Added championId parameter to track which analyst won the debate
     */
    private async saveTrade(
        portfolioId: string,
        trade: { symbol: string; side: 'LONG' | 'SHORT'; size: number; price: number; orderId: number; clientOrderId: string; reason: string; confidence: number; championId?: string; }
    ): Promise<void> {
        // Validate required fields
        if (!portfolioId || typeof portfolioId !== 'string') {
            logger.error('Invalid portfolioId for saveTrade');
            return;
        }
        if (!trade.symbol || typeof trade.symbol !== 'string') {
            logger.error('Invalid trade symbol for saveTrade');
            return;
        }
        if (!Number.isFinite(trade.size) || trade.size <= 0) {
            logger.error(`Invalid trade size for saveTrade: ${trade.size}`);
            return;
        }
        if (!Number.isFinite(trade.price) || trade.price <= 0) {
            logger.error(`Invalid trade price for saveTrade: ${trade.price}`);
            return;
        }

        try {
            // Generate UUID for the trade
            const tradeId = crypto.randomUUID();

            await prisma.trade.create({
                data: {
                    id: tradeId,
                    portfolioId: portfolioId,
                    symbol: trade.symbol,
                    side: trade.side === 'LONG' ? 'BUY' : 'SELL', // Convert LONG/SHORT to BUY/SELL
                    type: 'MARKET',
                    size: trade.size,
                    price: trade.price,
                    status: 'FILLED',
                    reason: trade.reason,
                    confidence: trade.confidence,
                    championId: trade.championId, // FIXED: Track which analyst won the debate
                    clientOrderId: trade.clientOrderId,
                    weexOrderId: String(trade.orderId),
                    executedAt: new Date(),
                    createdAt: new Date()
                }
            });
        } catch (error) {
            logger.error('Failed to save trade to database:', error);
            // Don't throw - trade was already executed on WEEX, just log the DB failure
        }
    }

    /**
     * Emergency close all positions
     * FIXED: Collect positions to close first, then iterate to avoid modifying while iterating
     */
    private async emergencyCloseAllPositions(): Promise<void> {
        logger.error('🚨 EMERGENCY: Closing all positions');

        // Collect all unique symbols to close first
        const symbolsToClose = new Set<string>();
        for (const [, state] of this.analystStates) {
            for (const position of state.positions) {
                symbolsToClose.add(position.symbol);
            }
        }

        // Close positions by symbol
        for (const symbol of symbolsToClose) {
            try {
                await this.weexClient.closeAllPositions(symbol);
                logger.info(`Closed positions for ${symbol}`);
            } catch (error) {
                logger.error(`Failed to close ${symbol}:`, error);
            }
        }

        // Clear all analyst positions after closing
        for (const [, state] of this.analystStates) {
            state.positions = [];
        }

        this.emit('emergencyClose', { timestamp: Date.now() });
    }

    private sleep(ms: number): Promise<void> {
        // Validate ms to prevent issues with negative/NaN values
        if (!Number.isFinite(ms) || ms < 0) {
            logger.warn(`Invalid sleep duration: ${ms}, using 0`);
            ms = 0;
        }
        if (ms === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.sleepTimeout = setTimeout(() => { this.sleepTimeout = null; resolve(); }, ms);
        });
    }

    async cleanup(): Promise<void> {
        // FIXED: Guard against concurrent cleanup calls
        if (this.cleanupInProgress) {
            logger.warn('Cleanup already in progress, skipping');
            return;
        }

        this.cleanupInProgress = true;

        try {
            this.stop();

            // FIXED: Clear sleepTimeout to prevent memory leak
            if (this.sleepTimeout) {
                clearTimeout(this.sleepTimeout);
                this.sleepTimeout = null;
            }

            if (this.mainLoopPromise) {
                // Create a timeout that we can clean up
                let cleanupTimeoutId: NodeJS.Timeout | null = null;
                const timeoutPromise = new Promise<void>((_, reject) => {
                    cleanupTimeoutId = setTimeout(() => reject(new Error('cleanup timeout')), 5000);
                });

                try {
                    await Promise.race([this.mainLoopPromise, timeoutPromise]);
                } catch {
                    logger.warn('Cleanup timeout or error');
                } finally {
                    // Always clear the timeout to prevent memory leak
                    if (cleanupTimeoutId) {
                        clearTimeout(cleanupTimeoutId);
                        cleanupTimeoutId = null;
                    }
                }
            }

            // Clear state to prevent stale data on restart
            this.analystStates.clear();
            this.currentCycle = null;
            this.cycleCount = 0;
            this.consecutiveFailures = 0;
            this.mainLoopPromise = null;

            // FIXED: Reset totalDebatesRun to prevent stale count on restart
            this.totalDebatesRun = 0;
            this.totalTokensSaved = 0;

            // FIXED: Reset contract specs tracker to force fresh fetch on restart
            this.contractSpecsTracker.reset();

            // FIXED: Reset snapshot tracking to prevent stale state
            this.lastSnapshotCleanup = 0;
            this.snapshotFailureCount = 0;

            // FIXED: Clear weekly P&L cache
            this.weeklyPnLCache = null;

            // FIXED: Cleanup AILogService state
            aiLogService.cleanup();

            // FIXED: Cleanup CollaborativeFlowService to free AI model resources
            collaborativeFlowService.cleanup();

            // FIXED: Remove all listeners with error handling
            try {
                this.removeAllListeners();
            } catch (error) {
                logger.warn('Error removing event listeners:', error);
            }
        } finally {
            this.cleanupInProgress = false;
        }
    }
}

let engineInstance: AutonomousTradingEngine | null = null;
export function getAutonomousTradingEngine(): AutonomousTradingEngine {
    if (!engineInstance) engineInstance = new AutonomousTradingEngine();
    return engineInstance;
}

/**
 * Reset the singleton instance (for testing or restart scenarios)
 * Returns a Promise that resolves after cleanup is complete
 */
export async function resetAutonomousTradingEngine(): Promise<void> {
    if (engineInstance) {
        try {
            await engineInstance.cleanup();
        } catch (err) {
            logger.error('Error during engine reset cleanup:', err);
        }
        engineInstance = null;
    }
}

