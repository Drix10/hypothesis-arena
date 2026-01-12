/**
 * Autonomous Trading Engine - COLLABORATIVE MODE
 * 
 * 4 AI analysts collaborate on ONE shared portfolio.
 * 
 * Pipeline (Parallel Analysis v5.0.0):
 * 1. Market Scan - Fetch data for all 8 coins + indicators
 * 2. Parallel Analysis - 4 analysts analyze independently in parallel
 * 3. Judge Decision - Compare all 4 and pick winner
 * 4. Execution - Place trade on WEEX with TP/SL
 */

import { EventEmitter } from 'events';
import crypto from 'crypto'; // For generating UUIDs
import { type ExtendedMarketData } from '../../shared/types/market';
import { getCollaborativeFlow, resetCollaborativeFlow, type FinalDecision, type Position as FlowPosition, type MarketDataInput } from '../ai/CollaborativeFlow';

// Re-export resetCollaborativeFlow for use in cleanup
const _resetCollaborativeFlow = resetCollaborativeFlow;
import { getWeexClient } from '../weex/WeexClient';
import { tradingScheduler } from './TradingScheduler';
import { AnalystPortfolioService } from '../portfolio/AnalystPortfolioService';
import { aiLogService } from '../compliance/AILogService';
import { prisma } from '../../config/database';
import { Prisma } from '@prisma/client';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES, RISK_COUNCIL_VETO_TRIGGERS } from '../../constants/analyst';
import {
    GLOBAL_RISK_LIMITS,
    isLeverageAutoApproved,
    getMaxLeverageForExposure,
    getRequiredStopLossPercent,
    validateCompetitionMode,
    guardCompetitionModeTrade
} from '../../constants/analyst/riskLimits';
import { roundToStepSize, roundToTickSize, updateContractSpecs, getContractSpecs, clearContractSpecs } from '../../shared/utils/weex';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { validateTradeWithMonteCarlo } from '../quant';
import { trackOpenTrade, syncPositions, getTrackedTradeBySymbol, type PositionData } from '../position';
import { getSymbolSentimentScore } from '../sentiment';

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

const ANALYST_IDS = ['jim', 'ray', 'karen', 'quant'] as const;

// =========================================================================
// PRICE DERIVATION HELPER
// =========================================================================

/**
 * Derive current price from position data
 * 
 * Priority:
 * 1. Market data (most accurate, real-time)
 * 2. Derive from unrealizedPnl (calculated from position P&L)
 * 3. Fallback to entryPrice (stale but safe)
 * 
 * @param entryPrice - Position entry price
 * @param size - Position size
 * @param unrealizedPnl - Unrealized P&L from exchange
 * @param isLong - Whether position is LONG
 * @param marketPrice - Optional current market price (preferred if available)
 * @returns Derived current price
 */
function deriveCurrentPrice(
    entryPrice: number,
    size: number,
    unrealizedPnl: number,
    isLong: boolean,
    marketPrice?: number
): number {
    // Priority 1: Use market price if available and valid
    if (marketPrice !== undefined && Number.isFinite(marketPrice) && marketPrice > 0) {
        return marketPrice;
    }

    // Priority 2: Derive from unrealizedPnl
    // Formula: pnl = (currentPrice - entryPrice) * size * direction
    // For LONG: currentPrice = entryPrice + (pnl / size)
    // For SHORT: currentPrice = entryPrice - (pnl / size)
    if (size > 0 && entryPrice > 0 && Number.isFinite(unrealizedPnl)) {
        const pnlPerUnit = unrealizedPnl / size;
        const derivedPrice = isLong ? entryPrice + pnlPerUnit : entryPrice - pnlPerUnit;

        // Sanity check - price should be positive and finite
        if (Number.isFinite(derivedPrice) && derivedPrice > 0) {
            return derivedPrice;
        }
    }

    // Priority 3: Fallback to entry price
    return entryPrice;
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
        leverage?: number; // Actual leverage from WEEX (optional, may not always be available)
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
    analysesRun: number;  // v5.0.0: Renamed from debatesRun - counts parallel analysis runs
    errors: string[];
}

// =========================================================================
// PRE-STAGE-2 OPTIMIZATION: URGENCY LEVELS FOR POSITION MANAGEMENT
// =========================================================================

/**
 * Urgency levels for position management decisions
 * Used to determine whether to skip Stage 2 parallel analysis entirely
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
 * Uses hardcoded sensible defaults - AI handles TP/SL decisions naturally
 * 
 * @param position - Position to evaluate
 * @returns Urgency level and reason
 */
function calculatePositionUrgency(position: {
    unrealizedPnlPercent: number;
    holdTimeHours: number;
}): { urgency: PositionUrgency; reason: string } {
    // Hardcoded sensible defaults - AI handles actual TP/SL decisions
    // These are just for urgency classification to optimize token usage
    const TARGET_PROFIT_PCT = 5;   // Consider urgent at +5%
    const STOP_LOSS_PCT = 5;       // Consider urgent at -5%
    const MAX_HOLD_HOURS = 12;     // Consider urgent after 12h

    // FLAW FIX: Validate inputs - treat invalid values as LOW urgency
    const pnl = Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : 0;
    const holdHours = Number.isFinite(position.holdTimeHours) ? position.holdTimeHours : 0;

    // VERY_URGENT: Needs immediate action
    if (pnl >= TARGET_PROFIT_PCT) {
        return { urgency: 'VERY_URGENT', reason: `P&L +${pnl.toFixed(1)}% >= target (${TARGET_PROFIT_PCT}%)` };
    }
    if (pnl <= -STOP_LOSS_PCT) {
        return { urgency: 'VERY_URGENT', reason: `P&L ${pnl.toFixed(1)}% <= -SL (${STOP_LOSS_PCT}%)` };
    }
    if (holdHours >= MAX_HOLD_HOURS) {
        return { urgency: 'VERY_URGENT', reason: `Hold time ${holdHours.toFixed(1)}h >= max (${MAX_HOLD_HOURS}h)` };
    }

    // MODERATE: Should consider action
    if (pnl >= TARGET_PROFIT_PCT * 0.4) { // 2% for 5% target
        return { urgency: 'MODERATE', reason: `P&L +${pnl.toFixed(1)}% in partial TP zone` };
    }
    if (pnl <= -STOP_LOSS_PCT / 2) {
        return { urgency: 'MODERATE', reason: `P&L ${pnl.toFixed(1)}% approaching SL` };
    }
    if (holdHours >= MAX_HOLD_HOURS * 0.75) {
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
    action: 'RUN_STAGE_2' | 'DIRECT_MANAGE' | 'RULE_BASED_MANAGE' | 'SKIP_CYCLE';  // v5.0.0: Renamed LIGHTWEIGHT_DEBATE to RULE_BASED_MANAGE
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
    private totalAnalysesRun = 0; // v5.0.0: Track cumulative parallel analyses across all cycles
    private totalTokensSaved = 0; // Track tokens saved by pre-Stage-2 optimization
    private consecutiveFailures = 0; // Track consecutive failures for backoff
    private consecutiveHolds = 0; // Track consecutive HOLD decisions to reduce cycle frequency
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

        // Get tracked trade context for better decision making (v5.2.0)
        const trackedTrade = getTrackedTradeBySymbol(positionToManage.symbol);
        if (trackedTrade) {
            logger.debug(`   Tracked trade found: ${trackedTrade.winningAnalyst} analyst, entry regime: ${trackedTrade.entryRegime}`);
        }

        let actionExecuted = false;
        try {
            const managementDecision = await (async () => {
                // Rule-based fallback management (v5.0.0 - no AI call)
                // Hardcoded sensible defaults - AI handles actual decisions in normal flow
                const TARGET_PROFIT_PCT = 5;
                const STOP_LOSS_PCT = 5;
                const MAX_HOLD_HOURS = 12;
                const PARTIAL_TP_THRESHOLD = 3; // Take partial at 3%

                const pnl = positionToManage.unrealizedPnlPercent;
                // FIXED: Validate holdTimeHours to prevent NaN comparison issues
                const holdHours = Number.isFinite(positionToManage.holdTimeHours) ? positionToManage.holdTimeHours : 0;

                // Take profit if P&L exceeds target
                if (pnl >= TARGET_PROFIT_PCT) {
                    return { manageType: 'CLOSE_FULL', conviction: 9, reason: `P&L +${pnl.toFixed(1)}% exceeds target` };
                }
                // Cut loss if P&L exceeds stop loss
                if (pnl <= -STOP_LOSS_PCT) {
                    return { manageType: 'CLOSE_FULL', conviction: 10, reason: `P&L ${pnl.toFixed(1)}% exceeds stop loss` };
                }
                // Close if held too long
                if (holdHours >= MAX_HOLD_HOURS) {
                    return { manageType: 'CLOSE_FULL', conviction: 7, reason: `Hold time exceeds max` };
                }
                // Partial take profit
                if (pnl >= PARTIAL_TP_THRESHOLD) {
                    return { manageType: 'TAKE_PARTIAL', conviction: 7, reason: `P&L in partial TP zone`, closePercent: 50 };
                }
                return null;
            })();

            if (managementDecision && managementDecision.manageType) {
                const { manageType, conviction, reason, closePercent } = managementDecision;
                logger.info(`📋 Management Decision: ${manageType} (conviction: ${conviction}/10)`);
                logger.info(`Reason: ${reason}`);

                if (!config.autonomous.dryRun) {
                    try {
                        // NOTE: TIGHTEN_STOP and ADJUST_TP are not supported in rule-based fallback management
                        // They require AI-generated newStopLoss/newTakeProfit values which are not available here
                        // These actions are only available through full parallel analysis

                        switch (manageType) {
                            case 'CLOSE_FULL':
                                await this.weexClient.closeAllPositions(positionToManage.symbol);
                                logger.info(`✅ Closed full position: ${positionToManage.symbol}`);
                                actionExecuted = true;
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
                                    actionExecuted = true;
                                }
                                break;
                            case 'TIGHTEN_STOP':
                            case 'ADJUST_TP':
                                // Not supported in rule-based fallback - requires AI-generated values
                                logger.info(`ℹ️ ${manageType} not supported in rule-based fallback management`);
                                break;
                            case 'ADD_MARGIN':
                                // ADD_MARGIN is rarely used and requires careful handling
                                logger.info(`ℹ️ ADD_MARGIN action noted but not auto-executed in fallback mode`);
                                break;
                            default:
                                logger.warn(`⚠️ Unknown management action: ${manageType}`);
                        }

                        // Record the management trade to database (for CLOSE actions that were executed)
                        if (actionExecuted && (manageType === 'CLOSE_FULL' || manageType === 'CLOSE_PARTIAL' || manageType === 'TAKE_PARTIAL')) {
                            await this.recordManagementTrade(
                                positionToManage,
                                manageType,
                                `FALLBACK: ${manageType} - ${fallbackReason}`,
                                (manageType === 'CLOSE_PARTIAL' || manageType === 'TAKE_PARTIAL') && closePercent ? closePercent : 100
                            );
                        }

                        if (actionExecuted && this.currentCycle) {
                            this.currentCycle.tradesExecuted++;
                        }
                    } catch (execError) {
                        logger.error(`Failed to execute management action:`, execError);
                    }
                } else {
                    logger.info(`[DRY RUN] Would execute ${manageType} on ${positionToManage.symbol}`);
                    // NOTE: DRY RUN does NOT count as "executed" for metrics purposes
                    // This prevents skewing trade counts and win rates with simulated trades
                    // actionExecuted remains false - only real executions count
                }
            } else {
                // No management decision - position doesn't need action based on rules
                logger.info(`📋 No management action needed for ${positionToManage.symbol} based on current rules`);
            }
        } catch (manageError) {
            logger.error(`Failed to get management decision:`, manageError);
        }

        return { executed: actionExecuted, symbol: positionToManage.symbol };
    }

    /**
     * PRE-STAGE-2 OPTIMIZATION: Check if we can skip the expensive Stage 2 parallel analysis
     * 
     * This method runs BEFORE Stage 2 to save ~8000 tokens when:
     * - Balance is too low to trade
     * - Weekly drawdown limit exceeded
     * - Max positions reached with no urgent management needed
     * 
     * @returns Decision on whether to run Stage 2, skip, or go direct to manage
     */
    private async runPreStage2Checks(): Promise<PreStage2CheckResult> {
        const TOKENS_FULL_ANALYSIS = 8000;  // v5.0.0: Renamed from TOKENS_FULL_DEBATE
        const TOKENS_LIGHTWEIGHT = 3000;
        const TOKENS_DIRECT = 500;

        // =====================================================================
        // CHECK 1: BALANCE
        // =====================================================================
        let currentBalance: number;
        try {
            const assets = await this.weexClient.getAccountAssets();
            currentBalance = parseFloat(assets.available || '0');
        } catch (_error) {
            logger.warn('Failed to fetch balance for pre-check, continuing to Stage 2');
            return { canRunStage2: true, reason: 'Balance check failed', action: 'RUN_STAGE_2', tokensSaved: 0 };
        }

        if (!Number.isFinite(currentBalance) || currentBalance < config.autonomous.minBalanceToTrade) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`💰 PRE-CHECK: Insufficient balance ($${currentBalance?.toFixed(2) || 'N/A'} < $${config.autonomous.minBalanceToTrade})`);
            logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_ANALYSIS} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Insufficient balance: $${currentBalance?.toFixed(2) || 'N/A'}`,
                action: 'SKIP_CYCLE',
                tokensSaved: TOKENS_FULL_ANALYSIS
            };
        }

        // =====================================================================
        // CHECK 2: WEEKLY DRAWDOWN
        // =====================================================================
        const weeklyPnL = await this.getRecentPnLCached();
        if (weeklyPnL && Number.isFinite(weeklyPnL.week) && weeklyPnL.week < -RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`📉 PRE-CHECK: Weekly drawdown exceeded (${weeklyPnL.week.toFixed(1)}% < -${RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN}%)`);
            logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_ANALYSIS} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Weekly drawdown: ${weeklyPnL.week.toFixed(1)}%`,
                action: 'SKIP_CYCLE',
                tokensSaved: TOKENS_FULL_ANALYSIS
            };
        }

        // =====================================================================
        // CHECK 2.5: DAILY TRADE LIMIT
        // Skip expensive parallel analysis if we've already hit max daily trades
        // =====================================================================
        const dailyTradeCount = await this.getDailyTradeCount();
        if (dailyTradeCount >= config.trading.maxDailyTrades) {
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`🚫 PRE-CHECK: Max daily trades reached (${dailyTradeCount}/${config.trading.maxDailyTrades})`);
            logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_ANALYSIS} tokens)`);
            logger.info(`💡 Daily trade counter resets at midnight UTC`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Max daily trades: ${dailyTradeCount}/${config.trading.maxDailyTrades}`,
                action: 'SKIP_CYCLE',
                tokensSaved: TOKENS_FULL_ANALYSIS
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
                } catch (_dbErr) {
                    logger.debug('Failed to fetch hold times for pre-check, using defaults');
                }
            }

            positions = activePositions.map(pos => {
                const size = parseFloat(String(pos.size)) || 0;
                const openValue = parseFloat(String(pos.openValue)) || 0;
                const entryPrice = pos.entryPrice || (size > 0 ? openValue / size : 0);
                const unrealizedPnl = parseFloat(String(pos.unrealizePnl)) || 0;
                const unrealizedPnlPercent = openValue > 0 ? (unrealizedPnl / openValue) * 100 : 0;

                // Derive currentPrice using helper function
                const isLong = pos.side?.toUpperCase().includes('LONG');
                const currentPrice = deriveCurrentPrice(entryPrice, size, unrealizedPnl, isLong);

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
        } catch (_error) {
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
            // VERY URGENT: Go direct to rule-based management (skip parallel analysis entirely)
            const urgent = veryUrgent[0];
            logger.info(`🚨 VERY URGENT: ${urgent.symbol} - ${urgent.urgencyReason}`);
            logger.info(`🎯 ACTION: DIRECT MANAGE (saving ~${TOKENS_FULL_ANALYSIS - TOKENS_DIRECT} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Very urgent: ${urgent.urgencyReason}`,
                action: 'DIRECT_MANAGE',
                urgentPosition: urgent,
                allPositions: positionsWithUrgency,
                tokensSaved: TOKENS_FULL_ANALYSIS - TOKENS_DIRECT
            };
        }

        if (moderate.length > 0) {
            // MODERATE: Use rule-based position management (v5.0.0 - no AI call)
            const mod = moderate[0];
            logger.info(`⚠️ MODERATE: ${mod.symbol} - ${mod.urgencyReason}`);
            logger.info(`🎯 ACTION: RULE-BASED MANAGE (saving ~${TOKENS_FULL_ANALYSIS - TOKENS_LIGHTWEIGHT} tokens)`);
            logger.info(`${'='.repeat(60)}\n`);
            return {
                canRunStage2: false,
                reason: `Moderate urgency: ${mod.urgencyReason}`,
                action: 'RULE_BASED_MANAGE',
                urgentPosition: mod,
                allPositions: positionsWithUrgency,
                tokensSaved: TOKENS_FULL_ANALYSIS - TOKENS_LIGHTWEIGHT
            };
        }

        // All positions are LOW urgency - skip cycle entirely
        logger.info(`✅ All positions LOW urgency - nothing to do`);
        logger.info(`🎯 ACTION: SKIP CYCLE (saving ~${TOKENS_FULL_ANALYSIS} tokens)`);
        logger.info(`${'='.repeat(60)}\n`);
        return {
            canRunStage2: false,
            reason: 'At limits, no urgent positions',
            action: 'SKIP_CYCLE',
            allPositions: positionsWithUrgency,
            tokensSaved: TOKENS_FULL_ANALYSIS
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

                // Validate competition mode configuration (v5.2.0)
                // This throws if COMPETITION_MODE is enabled but ACK is missing
                try {
                    validateCompetitionMode();
                } catch (competitionError) {
                    logger.error('Competition mode validation failed:', competitionError);
                    throw competitionError;
                }

                // Check competition mode and log prominent warning
                const { isCompetitionModeAllowed } = await import('../../constants/analyst/riskLimits');
                if (isCompetitionModeAllowed()) {
                    logger.warn('');
                    logger.warn('╔══════════════════════════════════════════════════════════════════════════════╗');
                    logger.warn('║  ⚠️  COMPETITION MODE ENABLED - AGGRESSIVE SETTINGS ACTIVE                   ║');
                    logger.warn('╠══════════════════════════════════════════════════════════════════════════════╣');
                    logger.warn('║  This mode is for DEMO/PAPER TRADING ONLY!                                   ║');
                    logger.warn('║                                                                              ║');
                    logger.warn('║  IMPORTANT: The WEEX API does NOT provide a way to detect demo vs live       ║');
                    logger.warn('║  accounts. YOU must verify your account type in WEEX settings.               ║');
                    logger.warn('║                                                                              ║');
                    logger.warn('║  Settings: 20x max leverage, 50% max position, 50 trades/day                 ║');
                    logger.warn('║                                                                              ║');
                    logger.warn('║  If you are connected to a LIVE account, STOP NOW and disable                ║');
                    logger.warn('║  COMPETITION_MODE in your .env file!                                         ║');
                    logger.warn('╚══════════════════════════════════════════════════════════════════════════════╝');
                    logger.warn('');
                }

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

        // v5.0.0: Accumulate total analyses across all cycles for frontend display
        this.totalAnalysesRun += this.currentCycle.analysesRun;

        logger.info(`✅ Cycle #${this.cycleCount} complete (${reason}): ${this.currentCycle.tradesExecuted} trades, ${this.currentCycle.analysesRun} analyses (${(cycleDuration / 1000).toFixed(1)}s)`);

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

        // Update collaborative portfolio metrics (totalReturn, totalValue, drawdown)
        // Do this every cycle to keep metrics current even without trades
        try {
            const firstAnalyst = this.analystStates.values().next().value;
            if (firstAnalyst) {
                const unrealizedPnl = firstAnalyst.positions.reduce(
                    (sum, p) => sum + (p.unrealizedPnl || 0),
                    0
                );
                await AnalystPortfolioService.updateCollaborativePortfolioMetrics(
                    firstAnalyst.balance,
                    unrealizedPnl
                );
            }
        } catch (error) {
            logger.error('Failed to update collaborative portfolio metrics:', error);
            // Don't throw - cycle is complete, this is just metrics
        }

        this.emit('cycleComplete', this.currentCycle);
    }

    /**
     * Calculate sleep time with exponential backoff for consecutive failures or HOLDs
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
        // Apply gradual backoff for consecutive HOLDs (max 2x normal interval)
        // This saves tokens when market is boring/sideways
        // Starts at 1.25x after 3 HOLDs, increases by 0.25x per additional HOLD
        else if (this.consecutiveHolds >= 3) {
            const holdBackoff = Math.min(2, 1 + (this.consecutiveHolds - 2) * 0.25);
            sleepTime = Math.min(sleepTime * holdBackoff, this.CYCLE_INTERVAL_MS * 2);
            logger.info(`💤 Market quiet (${this.consecutiveHolds} consecutive HOLDs, ${holdBackoff.toFixed(2)}x backoff): sleeping ${(sleepTime / 1000).toFixed(0)}s`);
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
            // v5.0.0: Include totalAnalysesRun for frontend display
            totalAnalysesRun: this.totalAnalysesRun,
            totalTokensSaved: this.totalTokensSaved, // Pre-Stage-2 optimization savings
            sharedPortfolio: {
                balance: sharedBalance,
                totalTrades: sharedTotalTrades,
                positionCount: sharedPositions.length,
            },
            stats: {
                totalTrades: sharedTotalTrades,
                tradesThisCycle: this.currentCycle?.tradesExecuted || 0,
                totalAnalyses: this.totalAnalysesRun,  // v5.0.0: Renamed from totalDebates
                tokensSaved: this.totalTokensSaved,
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
            // Each analyst gets a virtual portfolio to track their analysis wins
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
                analysesRun: 0,  // v5.0.0: Renamed from debatesRun
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
                logger.info(`✅ Cycle #${this.cycleCount} complete (no data): 0 trades, 0 analyses (${(cycleDuration / 1000).toFixed(1)}s)`);
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
        // PRE-STAGE-2 OPTIMIZATION: Check if we can skip expensive parallel analysis
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
                    // Very urgent - go directly to rule-based management (no AI call)
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

                case 'RULE_BASED_MANAGE':
                    // v5.0.0: Use rule-based management (no AI call)
                    if (preCheck.urgentPosition && preCheck.allPositions && preCheck.allPositions.length > 0) {
                        logger.info(`⚠️ RULE-BASED MANAGE: ${preCheck.urgentPosition.symbol} (${preCheck.urgentPosition.urgencyReason})`);
                        const result = await this.executeFallbackManagement(
                            preCheck.allPositions,
                            marketDataMap,
                            `rule-based: ${preCheck.urgentPosition.urgencyReason}`
                        );
                        await this.updateLeaderboard();
                        if (result.executed) {
                            await this.completeCycle(cycleStart, `managed ${result.symbol}`);
                        } else {
                            await this.completeCycle(cycleStart, 'management skipped');
                        }
                    } else {
                        await this.completeCycle(cycleStart, 'no position to manage');
                    }
                    return;
            }
        }

        // =================================================================
        // STAGE 2: PARALLEL ANALYSIS (v5.0.0)
        // 4 analysts analyze independently in parallel, judge picks winner
        // =================================================================
        logger.info(`🎯 Stage 2: Parallel Analysis (4 analysts + judge)...`);

        // Get account balance
        const accountBalance = await this.getWalletBalance();
        if (accountBalance < this.MIN_BALANCE_TO_TRADE) {
            logger.warn(`Balance ${accountBalance.toFixed(2)} below minimum ${this.MIN_BALANCE_TO_TRADE}`);
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'insufficient balance');
            return;
        }

        // Convert positions to FlowPosition format
        const flowPositions: FlowPosition[] = [];
        try {
            const weexPositions = await this.weexClient.getPositions();
            for (const pos of weexPositions) {
                const posSize = parseFloat(String(pos.size || '0'));
                if (posSize > 0) {
                    const entryPrice = pos.entryPrice || 0;
                    const unrealizedPnl = parseFloat(String(pos.unrealizePnl || '0'));
                    const isLong = pos.side === 'LONG';

                    // Use helper function to derive current price
                    // Priority: 1) Market data, 2) Derive from unrealizedPnl, 3) Fallback to entryPrice
                    const marketData = marketDataMap.get(pos.symbol);
                    const marketPrice = marketData?.currentPrice;
                    const currentPrice = deriveCurrentPrice(entryPrice, posSize, unrealizedPnl, isLong, marketPrice);

                    flowPositions.push({
                        symbol: pos.symbol,
                        side: pos.side as 'LONG' | 'SHORT',
                        size: posSize,
                        entryPrice,
                        currentPrice,
                        leverage: parseFloat(String(pos.leverage || '5')),
                        unrealizedPnl,
                        liquidationPrice: pos.liquidationPrice ? parseFloat(String(pos.liquidationPrice)) : undefined,
                    });
                }
            }

            // POSITION SYNC (v5.3.0): Detect closed positions and create journal entries
            try {
                const positionData: PositionData[] = flowPositions.map(p => ({
                    symbol: p.symbol,
                    side: p.side === 'LONG' ? 'long' : 'short',
                    size: p.size,
                    entryPrice: p.entryPrice,
                    unrealizedPnl: p.unrealizedPnl,
                    leverage: p.leverage,
                }));
                const closedCount = await syncPositions(this.weexClient, positionData);
                if (closedCount > 0) {
                    logger.info(`📓 Position sync: ${closedCount} closed position(s) processed`);
                }
            } catch (syncError) {
                logger.warn('Position sync failed:', syncError);
            }
        } catch (error) {
            logger.warn('Failed to get positions:', error);
        }

        // Convert market data to flow format
        const flowMarketData = new Map<string, MarketDataInput>();
        for (const [symbol, data] of marketDataMap) {
            flowMarketData.set(symbol, {
                symbol,
                currentPrice: data.currentPrice,
                high24h: data.high24h,
                low24h: data.low24h,
                volume24h: data.volume24h,
                change24h: data.change24h,
                // FIXED: fundingRate is optional in ExtendedMarketData (undefined = unavailable)
                // Use 0 as fallback since MarketDataInput requires a number
                // Note: 0 funding rate is neutral (neither longs nor shorts pay)
                fundingRate: data.fundingRate ?? 0,
                openInterest: data.openInterest ?? null,
            });
        }

        // Run parallel analysis
        const flowService = getCollaborativeFlow(prisma);
        let decision: FinalDecision;
        try {
            decision = await flowService.runParallelAnalysis(accountBalance, flowPositions, flowMarketData);
            // v5.0.0: Increment analysesRun when parallel analysis completes successfully
            // This tracks the number of parallel analysis runs (4 analysts + 1 judge = 1 analysis)
            if (this.currentCycle) {
                this.currentCycle.analysesRun++;
            }
        } catch (error) {
            logger.error('Parallel analysis failed:', error);
            this.consecutiveFailures++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'parallel analysis failed');
            return;
        }

        // Log decision
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`📊 DECISION: ${decision.action} ${decision.symbol}`);
        logger.info(`   Winner: ${decision.winner}, Confidence: ${decision.confidence}%`);
        if (decision.warnings.length > 0) {
            logger.info(`   Warnings: ${decision.warnings.join(', ')}`);
        }
        logger.info(`${'='.repeat(60)}\n`);

        // Handle HOLD action
        if (decision.action === 'HOLD' || decision.winner === 'NONE') {
            logger.info('📊 Decision: HOLD - No trade this cycle');
            // FIXED: Reset consecutive failures on successful cycle (even if HOLD)
            this.consecutiveFailures = 0;
            // Track consecutive HOLDs to reduce cycle frequency when market is boring
            this.consecutiveHolds++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, 'HOLD decision');
            return;
        }

        // Handle CLOSE/REDUCE actions BEFORE confidence check
        // CRITICAL: Exit actions (CLOSE/REDUCE) should NOT be blocked by confidence threshold
        // We want to be able to exit positions even with low confidence signals
        // (e.g., cutting losses, taking profits based on exit plan invalidation)
        if (decision.action === 'CLOSE' || decision.action === 'REDUCE') {
            // Reset consecutive HOLDs when we take action
            this.consecutiveHolds = 0;

            const position = flowPositions.find(p => p.symbol.toLowerCase() === decision.symbol.toLowerCase());
            if (position) {
                try {
                    if (decision.action === 'CLOSE') {
                        await this.weexClient.closeAllPositions(decision.symbol);
                        logger.info(`✅ Closed position: ${decision.symbol}`);
                    } else {
                        const sizeToClose = roundToStepSize(position.size * 0.5, decision.symbol);
                        await this.weexClient.closePartialPosition(decision.symbol, position.side, sizeToClose, '1');
                        logger.info(`✅ Reduced position: ${decision.symbol} by 50%`);
                    }
                    if (this.currentCycle) this.currentCycle.tradesExecuted++;
                    // FIXED: Reset consecutive failures on successful action
                    this.consecutiveFailures = 0;
                } catch (error) {
                    logger.error(`Failed to ${decision.action} position:`, error);
                }
            } else {
                logger.warn(`Cannot ${decision.action}: No position found for ${decision.symbol}`);
            }
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, `${decision.action} executed`);
            return;
        }

        // CRITICAL: Check minimum confidence threshold ONLY for entry actions (BUY/SELL)
        // Exit actions (CLOSE/REDUCE) are handled above and bypass this check
        if (decision.confidence < this.MIN_CONFIDENCE_TO_TRADE) {
            logger.info(`📊 Decision: HOLD - Confidence ${decision.confidence}% below threshold ${this.MIN_CONFIDENCE_TO_TRADE}%`);
            logger.info(`   Original recommendation was ${decision.action} ${decision.symbol} by ${decision.winner}`);
            this.consecutiveFailures = 0;
            this.consecutiveHolds++;
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, `confidence too low: ${decision.confidence}% < ${this.MIN_CONFIDENCE_TO_TRADE}%`);
            return;
        }

        // Reset consecutive HOLDs when we take action
        this.consecutiveHolds = 0;

        // Check anti-churn ONLY for BUY/SELL (new position entries)
        const direction = decision.action === 'BUY' ? 'LONG' : 'SHORT';
        const antiChurnCheck = flowService.checkAntiChurn(decision.symbol, direction);
        if (!antiChurnCheck.allowed) {
            logger.info(`⏳ Anti-churn blocked: ${antiChurnCheck.reason}`);
            await this.updateLeaderboard();
            await this.completeCycle(cycleStart, `anti-churn: ${antiChurnCheck.reason}`);
            return;
        }

        // Handle BUY/SELL actions
        if (decision.action === 'BUY' || decision.action === 'SELL') {
            const tradeSuccess = await this.executeParallelAnalysisTrade(decision, marketDataMap);
            if (tradeSuccess) {
                // FIXED: Only record trade for anti-churn AFTER successful execution
                flowService.recordTrade(decision.symbol, direction);
                // FIXED: Reset consecutive failures on successful trade
                this.consecutiveFailures = 0;
            }
            await this.updateLeaderboard();
            // Determine completion message based on result and DRY_RUN mode
            let completionMessage: string;
            if (tradeSuccess) {
                completionMessage = `${decision.action} executed`;
            } else if (config.autonomous.dryRun) {
                completionMessage = `${decision.action} simulated (DRY_RUN)`;
            } else {
                completionMessage = `${decision.action} failed`;
            }
            await this.completeCycle(cycleStart, completionMessage);
            return;
        }

        await this.updateLeaderboard();
        await this.completeCycle(cycleStart, 'unknown action');
    }

    /**
     * Execute trade from parallel analysis decision
     */
    private async executeParallelAnalysisTrade(
        decision: FinalDecision,
        marketDataMap: Map<string, ExtendedMarketData>
    ): Promise<boolean> {
        const symbolData = marketDataMap.get(decision.symbol);
        if (!symbolData) {
            logger.error(`No market data for ${decision.symbol}`);
            return false;
        }

        const currentPrice = symbolData.currentPrice;
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            logger.error(`Invalid current price for ${decision.symbol}: ${currentPrice}`);
            return false;
        }

        const orderType: '1' | '2' = decision.action === 'BUY' ? '1' : '2';
        const isLong = decision.action === 'BUY';

        // Validate allocation_usd before calculating size
        if (!Number.isFinite(decision.allocation_usd) || decision.allocation_usd <= 0) {
            logger.error(`Invalid allocation_usd for ${decision.symbol}: ${decision.allocation_usd}`);
            return false;
        }

        // CHANGED: Trust AI's leverage decision - only apply exchange limits
        // The AI decides leverage based on confidence, volatility, funding rate
        const specs = getContractSpecs(decision.symbol);
        let leverage = decision.leverage;

        // Basic validation - invalid leverage should have been caught by CollaborativeFlow
        // but we check again as a defensive measure
        if (!Number.isFinite(leverage) || leverage <= 0) {
            // FIXED: Return false instead of using arbitrary default
            // This is consistent with CollaborativeFlow returning HOLD for invalid leverage
            logger.error(`Invalid leverage from AI: ${leverage} (type: ${typeof leverage}), aborting trade`);
            return false;
        }

        // RISK LIMIT VALIDATION (v5.2.0)
        // Check if leverage is auto-approved based on confidence level
        // FIXED: Use ?? instead of || to preserve valid zero confidence
        const confidence = decision.confidence ?? 50;
        if (!isLeverageAutoApproved(leverage, confidence)) {
            logger.warn(`Leverage ${leverage}x requires confidence >= 70% (got ${confidence}%), reducing to auto-approve threshold`);
            leverage = GLOBAL_RISK_LIMITS.AUTO_APPROVE_LEVERAGE_THRESHOLD;
        }

        // Check max leverage based on current portfolio exposure
        // This prevents over-leveraging when already heavily exposed
        try {
            const assets = await this.weexClient.getAccountAssets();
            const equity = parseFloat(assets.equity || '0');
            const positions = await this.weexClient.getPositions();

            // Calculate current total notional exposure
            // openValue is already the notional value (size * price), NOT margin
            // We sum openValue directly to get total notional exposure
            // Then divide by equity to get exposure percentage
            let totalNotionalExposure = 0;
            for (const pos of positions) {
                const posSize = parseFloat(String(pos.size)) || 0;
                const openValue = parseFloat(String(pos.openValue)) || 0;
                if (posSize > 0 && openValue > 0) {
                    // openValue IS the notional - don't multiply by leverage again
                    totalNotionalExposure += openValue;
                }
            }

            // currentExposurePct = (total notional / equity) * 100
            // This represents how much notional exposure we have relative to equity
            const currentExposurePct = equity > 0 ? (totalNotionalExposure / equity) * 100 : 0;
            const maxAllowedLeverage = getMaxLeverageForExposure(currentExposurePct);

            if (leverage > maxAllowedLeverage) {
                logger.warn(`Leverage ${leverage}x exceeds max ${maxAllowedLeverage}x for current exposure ${currentExposurePct.toFixed(1)}%, reducing`);
                leverage = maxAllowedLeverage;
            }
        } catch (exposureError) {
            logger.debug('Could not check exposure for leverage limit:', exposureError instanceof Error ? exposureError.message : 'unknown');
        }

        // Only clamp to exchange-specific limits (not our conservative limits)
        if (specs) {
            const originalLeverage = leverage;
            // Clamp to exchange limits, but also enforce our 20x safety cap
            const effectiveMax = Math.min(specs.maxLeverage, 20);

            // DEFENSIVE CHECK #1: Detect invalid spec configuration where minLeverage > maxLeverage
            // This indicates corrupted or invalid contract specs from the exchange
            if (specs.minLeverage > specs.maxLeverage) {
                logger.error(`CRITICAL: Invalid leverage specs for ${decision.symbol}: ` +
                    `minLeverage (${specs.minLeverage}) > maxLeverage (${specs.maxLeverage}). ` +
                    `Contract specs appear corrupted - aborting trade.`);
                return false;
            }

            // DEFENSIVE CHECK #2: Detect invalid spec configuration where minLeverage > effectiveMax
            // This can happen if exchange minLeverage > 20 (our safety cap) or if specs are corrupted
            if (specs.minLeverage > effectiveMax) {
                logger.error(`CRITICAL: Invalid leverage specs for ${decision.symbol}: ` +
                    `minLeverage (${specs.minLeverage}) > effectiveMax (${effectiveMax}). ` +
                    `Exchange limits: ${specs.minLeverage}-${specs.maxLeverage}x, safety cap: 20x. ` +
                    `Cannot determine valid leverage - aborting trade.`);
                return false;
            }

            leverage = Math.max(specs.minLeverage, Math.min(effectiveMax, leverage));
            if (leverage !== originalLeverage) {
                logger.info(`Leverage adjusted from ${originalLeverage}x to ${leverage}x (exchange limits: ${specs.minLeverage}-${specs.maxLeverage}x, safety cap: 20x)`);
            }
        } else if (leverage > 20) {
            // Absolute safety cap if no specs available (20x max)
            logger.warn(`Leverage ${leverage}x exceeds 20x safety cap, clamping`);
            leverage = 20;
        }

        // Calculate size from AI's allocation_usd (AI decides the notional exposure)
        const size = decision.allocation_usd / currentPrice;
        let roundedSize: string;
        try {
            roundedSize = roundToStepSize(size, decision.symbol);
        } catch (_error) {
            logger.warn(`Size too small for ${decision.symbol}: ${size}`);
            return false;
        }

        const roundedSizeNum = parseFloat(roundedSize);
        if (!Number.isFinite(roundedSizeNum) || roundedSizeNum <= 0) {
            logger.warn(`Size too small after rounding: ${size} -> ${roundedSize}`);
            return false;
        }

        // Validate TP/SL direction
        let validatedTpPrice = decision.tp_price;
        let validatedSlPrice = decision.sl_price;

        if (validatedTpPrice !== null && Number.isFinite(validatedTpPrice)) {
            const tpValid = isLong ? validatedTpPrice > currentPrice : validatedTpPrice < currentPrice;
            if (!tpValid) validatedTpPrice = null;
        }

        if (validatedSlPrice !== null && Number.isFinite(validatedSlPrice)) {
            const slValid = isLong ? validatedSlPrice < currentPrice : validatedSlPrice > currentPrice;
            if (!slValid) validatedSlPrice = null;
        }

        // MONTE CARLO VALIDATION (v5.1.0)
        // Validate trade with Monte Carlo simulation before execution
        if (validatedSlPrice !== null && validatedTpPrice !== null && currentPrice > 0) {
            const slPercent = Math.abs(currentPrice - validatedSlPrice) / currentPrice * 100;
            const tpPercent = Math.abs(validatedTpPrice - currentPrice) / currentPrice * 100;

            // Use default volatility since ExtendedMarketData doesn't have ATR
            // In crypto, 2% hourly volatility is a reasonable default
            const volatility = 2;

            const mcValidation = validateTradeWithMonteCarlo(
                isLong ? 'long' : 'short',
                volatility,
                slPercent,
                tpPercent,
                0 // No drift assumption
            );

            if (!mcValidation.valid) {
                logger.info(`🎲 MC advisory: trade flagged - ${mcValidation.reason}`);
                // Don't block the trade, but log the warning
                // The AI's Q-value validation is the primary gate
            } else {
                logger.info(`🎲 Monte Carlo validated: ${mcValidation.reason}`);
            }
        }

        // PER-SYMBOL SENTIMENT CHECK (v5.2.0)
        // Check sentiment for the specific symbol being traded
        // Advisory only - logs warning if sentiment contradicts trade direction
        try {
            const sentimentResult = await getSymbolSentimentScore(decision.symbol);
            if (sentimentResult) {
                const { score, sentiment } = sentimentResult;
                // Score: -1 (very bearish) to +1 (very bullish)
                const sentimentAligned = (isLong && score > 0.2) || (!isLong && score < -0.2);
                const sentimentContradicts = (isLong && score < -0.3) || (!isLong && score > 0.3);

                if (sentimentAligned) {
                    logger.info(`📰 Sentiment confirms ${isLong ? 'LONG' : 'SHORT'}: ${sentiment} (score: ${score.toFixed(2)})`);
                } else if (sentimentContradicts) {
                    logger.warn(`📰 Sentiment contradicts ${isLong ? 'LONG' : 'SHORT'}: ${sentiment} (score: ${score.toFixed(2)}) - advisory only`);
                } else {
                    logger.debug(`📰 Sentiment neutral for ${decision.symbol}: ${sentiment} (score: ${score.toFixed(2)})`);
                }
            }
        } catch (sentimentError) {
            logger.debug('Sentiment check skipped:', sentimentError instanceof Error ? sentimentError.message : 'unknown error');
        }

        // ADDED: Validate stop loss is not too wide for the leverage level
        // At high leverage, stop loss must be tighter than liquidation distance
        // Liquidation distance = 100% / leverage (e.g., 5% at 20x)
        if (validatedSlPrice !== null && leverage >= 10 && currentPrice > 0) {
            const slDistancePct = Math.abs(currentPrice - validatedSlPrice) / currentPrice * 100;

            // Use getRequiredStopLossPercent for leverage-appropriate stop loss limits
            const requiredMaxSlPct = getRequiredStopLossPercent(leverage);
            const liquidationDistancePct = 100 / leverage; // e.g., 5% at 20x
            const maxSafeSlPct = Math.min(requiredMaxSlPct, liquidationDistancePct * 0.8); // Use stricter of the two

            // FIXED: Only tighten if slDistancePct is valid (finite and positive)
            if (Number.isFinite(slDistancePct) && slDistancePct > 0 && slDistancePct > maxSafeSlPct) {
                logger.warn(`Stop loss ${slDistancePct.toFixed(2)}% exceeds safe limit ${maxSafeSlPct.toFixed(2)}% for ${leverage}x leverage. ` +
                    `Required max: ${requiredMaxSlPct}%, Liquidation at ${liquidationDistancePct.toFixed(2)}%. Tightening stop loss.`);

                // Tighten stop loss to safe level
                const safeSlDistance = currentPrice * (maxSafeSlPct / 100);
                const newSlPrice = isLong
                    ? currentPrice - safeSlDistance
                    : currentPrice + safeSlDistance;

                // FIXED: Validate the new stop loss is valid before using it
                if (Number.isFinite(newSlPrice) && newSlPrice > 0) {
                    validatedSlPrice = newSlPrice;
                    logger.info(`Adjusted stop loss to ${validatedSlPrice.toFixed(2)} (${maxSafeSlPct.toFixed(2)}% from current price)`);
                } else {
                    logger.warn(`Could not calculate valid adjusted stop loss, keeping original: ${validatedSlPrice}`);
                }
            }
        }

        // COMPETITION MODE GUARD (v5.3.0)
        // Per-trade guard that logs warnings and blocks trades if account type is live
        const competitionGuard = guardCompetitionModeTrade(decision.symbol, decision.action, leverage);
        if (!competitionGuard.allowed) {
            logger.error(`🚫 Trade blocked by competition mode guard: ${competitionGuard.warning}`);
            return false;
        }

        if (config.autonomous.dryRun) {
            logger.info(`[DRY RUN] Would ${decision.action} ${roundedSize} ${decision.symbol} @ ${currentPrice}`);
            // Return false in DRY_RUN mode to prevent recordTrade from being called.
            // No actual trade was executed, so anti-churn should not track it.
            return false;
        }

        try {
            // Set leverage
            try {
                await this.weexClient.changeLeverage(decision.symbol, leverage, '1');
            } catch (leverageError) {
                const errMsg = leverageError instanceof Error ? leverageError.message : String(leverageError);
                if (!errMsg.includes('50007') && !errMsg.includes('already')) {
                    logger.warn(`Could not set leverage: ${errMsg}`);
                }
            }

            // Place order
            const clientOid = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const result = await this.weexClient.placeOrder({
                symbol: decision.symbol,
                client_oid: clientOid,
                size: roundedSize,
                type: orderType,
                order_type: '0',
                match_price: '1',
                price: roundToTickSize(currentPrice, decision.symbol),
                marginMode: 1,
            });
            logger.info(`✅ ${decision.action} order placed: ${result.order_id}`);

            // Place TP/SL
            // FIXED: Round TP/SL prices to symbol's tick size to prevent WEEX rejection
            const positionSide: 'long' | 'short' = isLong ? 'long' : 'short';
            if (validatedTpPrice !== null && validatedTpPrice > 0) {
                try {
                    // Round to tick size - parseFloat converts string back to number
                    const roundedTpPrice = parseFloat(roundToTickSize(validatedTpPrice, decision.symbol));
                    if (Number.isFinite(roundedTpPrice) && roundedTpPrice > 0) {
                        await this.weexClient.placeTpSlOrder({
                            symbol: decision.symbol,
                            planType: 'profit_plan',
                            triggerPrice: roundedTpPrice,
                            size: roundedSizeNum,
                            positionSide,
                        });
                    } else {
                        logger.warn(`TP price rounding failed: ${validatedTpPrice} -> ${roundedTpPrice}`);
                    }
                } catch (tpError) {
                    logger.warn('Failed to set TP:', tpError instanceof Error ? tpError.message : String(tpError));
                }
            }

            if (validatedSlPrice !== null && validatedSlPrice > 0) {
                try {
                    // Round to tick size - parseFloat converts string back to number
                    const roundedSlPrice = parseFloat(roundToTickSize(validatedSlPrice, decision.symbol));
                    if (Number.isFinite(roundedSlPrice) && roundedSlPrice > 0) {
                        await this.weexClient.placeTpSlOrder({
                            symbol: decision.symbol,
                            planType: 'loss_plan',
                            triggerPrice: roundedSlPrice,
                            size: roundedSizeNum,
                            positionSide,
                        });
                    } else {
                        logger.warn(`SL price rounding failed: ${validatedSlPrice} -> ${roundedSlPrice}`);
                    }
                } catch (slError) {
                    logger.warn('Failed to set SL:', slError instanceof Error ? slError.message : String(slError));
                }
            }

            // Save trade to database
            await this.saveParallelAnalysisTrade(decision, roundedSizeNum, currentPrice, String(result.order_id));

            if (this.currentCycle) this.currentCycle.tradesExecuted++;
            return true;

        } catch (error) {
            logger.error(`Failed to execute ${decision.action}:`, error);
            return false;
        }
    }

    /**
     * Save parallel analysis trade to database
     */
    private async saveParallelAnalysisTrade(decision: FinalDecision, size: number, price: number, orderId: string): Promise<void> {
        try {
            // CRITICAL: Validate all required fields before saving
            if (!decision.symbol || typeof decision.symbol !== 'string') {
                logger.error('Cannot save trade: invalid symbol');
                return;
            }
            if (!Number.isFinite(size) || size <= 0) {
                logger.error(`Cannot save trade: invalid size ${size}`);
                return;
            }
            if (!Number.isFinite(price) || price <= 0) {
                logger.error(`Cannot save trade: invalid price ${price}`);
                return;
            }
            if (!orderId || typeof orderId !== 'string') {
                logger.error('Cannot save trade: invalid orderId');
                return;
            }

            const portfolio = await prisma.portfolio.findFirst({ where: { agentId: 'collaborative' } });
            if (!portfolio) {
                logger.error('Collaborative portfolio not found');
                return;
            }

            // Validate and sanitize all fields
            const validatedLeverage = Number.isFinite(decision.leverage) && decision.leverage >= 1
                ? Math.min(decision.leverage, 20)
                : 1;
            const validatedAllocation = Number.isFinite(decision.allocation_usd) && decision.allocation_usd >= 0
                ? decision.allocation_usd
                : size * price;
            const validatedConfidence = Number.isFinite(decision.confidence)
                ? Math.min(100, Math.max(0, decision.confidence))
                : 50;
            const validatedTp = decision.tp_price !== null && Number.isFinite(decision.tp_price) && decision.tp_price > 0
                ? decision.tp_price
                : null;
            const validatedSl = decision.sl_price !== null && Number.isFinite(decision.sl_price) && decision.sl_price > 0
                ? decision.sl_price
                : null;

            // Generate trade ID once and reuse for both DB and position tracking
            const tradeId = crypto.randomUUID();

            await prisma.trade.create({
                data: {
                    id: tradeId,
                    portfolioId: portfolio.id,
                    symbol: decision.symbol,
                    side: decision.action === 'BUY' ? 'BUY' : 'SELL',
                    action: decision.action,
                    type: 'MARKET',
                    size,
                    entryPrice: price,
                    price,
                    status: 'FILLED',
                    reason: (decision.rationale || '').slice(0, 500),
                    rationale: (decision.rationale || '').slice(0, 500),
                    confidence: validatedConfidence,
                    championId: decision.winner || 'NONE',
                    weexOrderId: orderId,
                    leverage: validatedLeverage,
                    allocationUsd: validatedAllocation,
                    takeProfit: validatedTp,
                    stopLoss: validatedSl,
                    exitPlan: (decision.exit_plan || '').slice(0, 500),
                    entryThesis: (decision.judgeDecision?.reasoning || '').slice(0, 1000),
                    entryConfidence: validatedConfidence,
                    executedAt: new Date(),
                    createdAt: new Date(),
                },
            });
            logger.info(`Trade saved to database: ${decision.symbol} ${decision.action} size=${size} price=${price}`);

            // Track trade for position sync (v5.3.0)
            // When this position closes, PositionSyncService will create the journal entry
            try {
                // Extract analyst scores from the parallel analysis result
                // Each analyst's confidence score is used for performance tracking
                // Use explicit null/undefined checks to preserve valid zero values
                const analystScores: Record<string, number> = {};
                const analysisResult = decision.analysisResult;
                if (analysisResult) {
                    if (analysisResult.jim?.recommendation?.confidence != null) analystScores['jim'] = analysisResult.jim.recommendation.confidence;
                    if (analysisResult.ray?.recommendation?.confidence != null) analystScores['ray'] = analysisResult.ray.recommendation.confidence;
                    if (analysisResult.karen?.recommendation?.confidence != null) analystScores['karen'] = analysisResult.karen.recommendation.confidence;
                    if (analysisResult.quant?.recommendation?.confidence != null) analystScores['quant'] = analysisResult.quant.recommendation.confidence;
                }

                trackOpenTrade({
                    tradeId,  // Use the same tradeId as saved to database
                    orderId,
                    symbol: decision.symbol,
                    side: decision.action === 'BUY' ? 'BUY' : 'SELL',
                    entryPrice: price,
                    size,
                    leverage: validatedLeverage,
                    tpPrice: validatedTp,
                    slPrice: validatedSl,
                    // Entry context - null for unavailable fields (proper nullable types)
                    // TODO: Pass TradingContext to saveParallelAnalysisTrade to populate these fields
                    entryRegime: null,  // Not available in FinalDecision
                    entryZScore: null,  // Not available in FinalDecision
                    entryFunding: null,  // Not available in FinalDecision
                    entrySentiment: null,  // Not available in FinalDecision
                    entrySignals: {},  // Empty object when not available
                    winningAnalyst: decision.winner || 'unknown',
                    analystScores,
                    judgeReasoning: (decision.judgeDecision?.reasoning || '').slice(0, 500),
                    openedAt: Date.now(),
                });
                logger.debug(`Trade tracked for position sync: ${decision.symbol}`);
            } catch (trackError) {
                // Don't fail the trade if tracking fails
                logger.warn('Failed to track trade for position sync:', trackError);
            }
        } catch (error) {
            logger.error('Failed to save trade:', error);
        }
    }

    // =========================================================================
    // UTILITY METHODS
    // These methods support the main trading cycle and are actively used.
    // =========================================================================

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

            // Calculate P&L in one pass
            let dayPnL = 0;
            for (const trade of dayTrades) {
                dayPnL += trade.realizedPnl ?? 0;
            }

            let weekPnL = 0;
            for (const trade of weekTrades) {
                weekPnL += trade.realizedPnl ?? 0;
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

                        // NOTE: For closure trades, entryPrice/price store the CLOSE price (execution price),
                        // not the original entry price. This is intentional because:
                        // 1. The closure trade is a separate record from the entry trade
                        // 2. The entry trade already has the original entry price
                        // 3. For P&L calculation, we use realizedPnl from WEEX (already calculated)
                        // 4. This matches the schema comment: "entryPrice is the canonical field for the trade's entry price"
                        //    where "entry" refers to THIS trade record's execution price
                        await prisma.trade.create({
                            data: {
                                id: tradeId,
                                portfolioId: portfolioId,
                                symbol: symbol,
                                side: closeSide as 'BUY' | 'SELL',
                                type: 'MARKET',
                                size: closeSize,
                                entryPrice: closePrice, // Execution price of this closure trade
                                price: closePrice,      // Same as entryPrice (schema invariant)
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

                // Create performance snapshot for historical tracking
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

                        // Note: Prisma deleteMany doesn't support 'take', so we delete all at once
                        // For very large datasets with lock contention issues, consider using raw SQL with LIMIT
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
     * Record management trade to database (shared helper)
     * 
     * Used by rule-based management and fallback management to record position closures.
     * This ensures all position closures are tracked for P&L reporting.
     */
    private async recordManagementTrade(
        position: { symbol: string; side: string; size: number; currentPrice: number; unrealizedPnl: number },
        manageType: string,
        reason: string,
        closePercent: number
    ): Promise<void> {
        try {
            // Validate and normalize currentPrice - must be a valid positive number
            let closePrice = position.currentPrice;
            if (!Number.isFinite(closePrice) || closePrice <= 0) {
                // Try to fetch current price from market data
                try {
                    const ticker = await this.weexClient.getTicker(position.symbol);
                    closePrice = parseFloat(ticker.last);
                    if (!Number.isFinite(closePrice) || closePrice <= 0) {
                        logger.warn(`Cannot record management trade: invalid closePrice ${closePrice} for ${position.symbol}`);
                        return;
                    }
                } catch (_err) {
                    logger.warn(`Cannot record management trade: failed to fetch price for ${position.symbol}`);
                    return;
                }
            }

            // Find original champion who opened this position
            let originalChampionId: string | null = null;
            try {
                const originalTrade = await prisma.trade.findFirst({
                    where: {
                        symbol: position.symbol,
                        status: 'FILLED',
                        realizedPnl: null, // Entry trade
                        side: position.side === 'LONG' ? 'BUY' : 'SELL'
                    },
                    orderBy: { executedAt: 'desc' },
                    select: { championId: true }
                });
                originalChampionId = originalTrade?.championId || null;
            } catch (err) {
                logger.debug(`Failed to lookup original champion for ${position.symbol}: ${err instanceof Error ? err.message : 'Unknown error'}`);
                originalChampionId = null;
            }

            // Calculate size and P&L for the trade record
            let loggedSize = Number.isFinite(position.size) ? position.size : 0;
            let loggedPnl = Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl : 0;

            // Validate closePercent
            const safeClosePercent = Number.isFinite(closePercent) && closePercent > 0 && closePercent <= 100
                ? closePercent
                : 100;

            if (safeClosePercent < 100) {
                loggedSize = (loggedSize * safeClosePercent) / 100;
                loggedPnl = (loggedPnl * safeClosePercent) / 100;
            }

            // Final validation
            if (!Number.isFinite(loggedSize)) loggedSize = 0;
            if (!Number.isFinite(loggedPnl)) loggedPnl = 0;

            // Get collaborative portfolio ID
            const firstAnalyst = this.analystStates.values().next().value;
            let portfolioId = firstAnalyst?.portfolioId;

            if (!portfolioId) {
                const collabPortfolio = await prisma.portfolio.findFirst({
                    where: { agentId: 'collaborative' },
                    select: { id: true }
                });
                if (!collabPortfolio) {
                    logger.error('Cannot record management trade: collaborative portfolio not found');
                    return;
                }
                portfolioId = collabPortfolio.id;
            }

            const tradeId = crypto.randomUUID();
            await prisma.trade.create({
                data: {
                    id: tradeId,
                    portfolioId: portfolioId,
                    symbol: position.symbol,
                    side: position.side === 'LONG' ? 'SELL' : 'BUY',
                    type: 'MARKET',
                    size: loggedSize,
                    entryPrice: closePrice, // For management trades, entry price is the close price (execution price)
                    price: closePrice,
                    status: 'FILLED',
                    reason: reason,
                    championId: originalChampionId,
                    realizedPnl: loggedPnl,
                    executedAt: new Date(),
                    createdAt: new Date()
                }
            });
            logger.info(`📊 Recorded management trade: ${position.symbol} ${manageType} P&L: ${loggedPnl.toFixed(2)} (${originalChampionId})`);
        } catch (dbError) {
            logger.error('Failed to record management trade:', dbError);
        }
    }

    private sleep(ms: number): Promise<void> {
        // Validate ms to prevent issues with negative/NaN values
        if (!Number.isFinite(ms) || ms < 0) {
            logger.warn(`Invalid sleep duration: ${ms}, using 0`);
            ms = 0;
        }

        // FIXED: Clear any existing sleep timeout to prevent memory leak
        // This ensures only one sleep timeout is active at a time
        if (this.sleepTimeout) {
            clearTimeout(this.sleepTimeout);
            this.sleepTimeout = null;
        }
        if (ms === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.sleepTimeout = setTimeout(() => { this.sleepTimeout = null; resolve(); }, ms);
            // FIXED: Use .unref() to not block process exit
            if (this.sleepTimeout.unref) {
                this.sleepTimeout.unref();
            }
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
            this.consecutiveHolds = 0;
            this.mainLoopPromise = null;

            // v5.0.0: Reset totalAnalysesRun to prevent stale count on restart
            this.totalAnalysesRun = 0;
            this.totalTokensSaved = 0;

            // FIXED: Reset contract specs tracker to force fresh fetch on restart
            this.contractSpecsTracker.reset();

            // Clear contract specs cache to ensure fresh data on restart (v5.2.0)
            clearContractSpecs();

            // FIXED: Reset snapshot tracking to prevent stale state
            this.lastSnapshotCleanup = 0;
            this.snapshotFailureCount = 0;

            // FIXED: Clear weekly P&L cache
            this.weeklyPnLCache = null;

            // FIXED: Cleanup AILogService state
            aiLogService.cleanup();

            // FIXED: Cleanup CollaborativeFlowService to free AI model resources
            _resetCollaborativeFlow();

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

