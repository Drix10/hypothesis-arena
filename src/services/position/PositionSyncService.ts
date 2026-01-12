/**
 * PositionSyncService - Track Position Closures & Create Journal Entries (v5.3.0)
 * 
 * Monitors open positions and detects when they close to:
 * 1. Update trade status in database
 * 2. Create journal entries with proper outcomes
 * 3. Track entry context for learning loop
 * 
 * Flow:
 * 1. When trade opens -> trackOpenTrade() stores entry context
 * 2. During sync cycle -> syncPositions() compares with WEEX positions
 * 3. When position closes -> handlePositionClosed() determines outcome
 * 4. Creates journal entry with full context
 */

import { logger } from '../../utils/logger';
import { prisma } from '../../config/database';
import { addJournalEntry, addLessonToEntry } from '../journal';
import type { WeexClient } from '../weex/WeexClient';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TrackedTrade {
    tradeId: string;
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    size: number;
    leverage: number;
    tpPrice: number | null;
    slPrice: number | null;

    // Fee tracking for accurate P&L calculation
    entryFee: number;
    exitFee: number;
    fundingPaid: number;

    // Entry context for journal (nullable - may not be available at trade open)
    entryRegime: string | null;
    entryZScore: number | null;
    entryFunding: number | null;
    entrySentiment: number | null;
    entrySignals?: Record<string, unknown> | null;

    // Analyst data (nullable - may not be available at trade open)
    winningAnalyst?: string | null;
    analystScores?: Record<string, number> | null;
    judgeReasoning?: string | null;

    // Tracking
    openedAt: number;
    lastSyncAt: number;
}

export interface PositionData {
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
}

interface CloseResult {
    closePrice: number;
    realizedPnl: number;
    realizedPnlPercent: number;
    exitReason: 'tp_hit' | 'sl_hit' | 'manual' | 'liquidation' | 'unknown';
    holdTimeHours: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Map key is tradeId (unique) to allow multiple positions per symbol
const trackedTrades = new Map<string, TrackedTrade>();
const MAX_TRACKED_TRADES = 100;
const STALE_TRADE_HOURS = 72; // Remove trades older than 72 hours

// Configurable outcome threshold (default ±1% to account for fees and leverage)
const POSITION_OUTCOME_THRESHOLD_PERCENT = 1.0;

// Minimum absolute price difference for TP/SL matching (handles very small prices)
const MIN_ABS_PRICE_DIFF = 1e-6;

// Concurrency guard: Set of tradeIds currently being processed
// Prevents duplicate journal entries and DB updates from concurrent syncPositions calls
const inProgressTradeIds = new Set<string>();

// Track consecutive "not seen" cycles for each trade to avoid premature removal during API issues
// Only remove stale trades after they've been missing for multiple consecutive sync cycles
const notSeenCounts = new Map<string, number>();
const MISSING_CYCLE_THRESHOLD = 3; // Require 3 consecutive missing cycles before stale removal

// ═══════════════════════════════════════════════════════════════════════════════
// SIDE NORMALIZATION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize position side to standard format
 * Handles various formats: 'BUY'/'SELL', 'long'/'short', 'LONG'/'SHORT'
 * Returns 'BUY' for long positions, 'SELL' for short positions, or null for invalid input
 * 
 * @throws Never - returns null for invalid input instead of throwing
 */
function normalizeSide(side: string): 'BUY' | 'SELL' | null {
    if (!side || typeof side !== 'string') {
        logger.error(`Invalid side value: ${side} (type: ${typeof side})`);
        return null;
    }

    const normalized = side.toUpperCase().trim();
    if (normalized === 'BUY' || normalized === 'LONG') {
        return 'BUY';
    }
    if (normalized === 'SELL' || normalized === 'SHORT') {
        return 'SELL';
    }

    // Unknown side format - return null instead of defaulting
    logger.error(`Unknown side format: "${side}" - cannot normalize`);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Track a newly opened trade for position sync
 * Call this after a trade is successfully executed
 */
export function trackOpenTrade(trade: Omit<TrackedTrade, 'lastSyncAt' | 'entryFee' | 'exitFee' | 'fundingPaid'>): void {
    // Validate required fields
    if (!trade.tradeId || !trade.symbol || !trade.orderId) {
        logger.warn('Cannot track trade: missing required fields (tradeId, symbol, or orderId)');
        return;
    }

    // Validate side field - must be 'BUY' or 'SELL' (TrackedTrade type)
    if (!trade.side || (trade.side !== 'BUY' && trade.side !== 'SELL')) {
        logger.warn(`Cannot track trade: invalid side value "${trade.side}" - must be 'BUY' or 'SELL'`);
        return;
    }

    // Enforce max tracked trades (remove oldest that is not in-progress)
    if (trackedTrades.size >= MAX_TRACKED_TRADES) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, t] of trackedTrades.entries()) {
            // Skip trades that are currently being processed to avoid race conditions
            if (inProgressTradeIds.has(key)) {
                continue;
            }
            if (t.openedAt < oldestTime) {
                oldestTime = t.openedAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            trackedTrades.delete(oldestKey);
            notSeenCounts.delete(oldestKey); // Clean up associated counter
            // Note: oldestKey is guaranteed not in inProgressTradeIds due to the check above
            logger.debug(`Evicted oldest tracked trade: ${oldestKey}`);
        } else {
            // All trades are in-progress, cannot add new trade without exceeding limit
            logger.warn(`Cannot track trade ${trade.tradeId}: at MAX_TRACKED_TRADES (${MAX_TRACKED_TRADES}) and all are in-progress`);
            return;
        }
    }

    const trackedTrade: TrackedTrade = {
        ...trade,
        // Provide safe defaults for optional fields
        entrySignals: trade.entrySignals ?? {},
        winningAnalyst: trade.winningAnalyst ?? '',
        analystScores: trade.analystScores ?? {},
        judgeReasoning: trade.judgeReasoning ?? '',
        entryFee: 0,  // Will be updated when available
        exitFee: 0,
        fundingPaid: 0,
        lastSyncAt: Date.now(),
    };

    // Use tradeId as key (unique) instead of symbol to allow multiple positions per symbol
    trackedTrades.set(trade.tradeId, trackedTrade);
    notSeenCounts.delete(trade.tradeId); // Reset missing counter for new/re-tracked trade
    logger.info(`Tracking trade: ${trade.symbol} ${trade.side} @ ${trade.entryPrice} (tradeId: ${trade.tradeId})`);
}

/**
 * Get tracked trade by tradeId
 */
export function getTrackedTrade(tradeId: string): TrackedTrade | null {
    return trackedTrades.get(tradeId) || null;
}

/**
 * Get tracked trade by symbol (returns first match - for backward compatibility)
 */
export function getTrackedTradeBySymbol(symbol: string): TrackedTrade | null {
    for (const trade of trackedTrades.values()) {
        if (trade.symbol === symbol) {
            return trade;
        }
    }
    return null;
}

/**
 * Remove tracked trade by tradeId (after closure processed)
 * Also removes associated entry from notSeenCounts to prevent memory leak
 */
export function removeTrackedTrade(tradeId: string): void {
    trackedTrades.delete(tradeId);
    notSeenCounts.delete(tradeId); // Clean up associated counter to prevent memory leak
}

/**
 * Get all tracked trades
 */
export function getAllTrackedTrades(): TrackedTrade[] {
    return Array.from(trackedTrades.values());
}

/**
 * Clear all tracked trades (for testing)
 * Also clears inProgressTradeIds and notSeenCounts to prevent stale entries
 */
export function clearTrackedTrades(): void {
    trackedTrades.clear();
    inProgressTradeIds.clear();
    notSeenCounts.clear();
    logger.info('Tracked trades cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION SYNC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync positions with WEEX and detect closures
 * Call this during each trading cycle
 * 
 * @param weexClient - WEEX client for API calls
 * @param currentPositions - Current positions from WEEX
 * @returns Number of closed positions processed
 */
export async function syncPositions(
    weexClient: WeexClient,
    currentPositions: PositionData[]
): Promise<number> {
    const now = Date.now();
    let closedCount = 0;

    // Create a map of current positions by symbol+side for accurate matching
    // NOTE: WEEX typically aggregates positions per symbol+side, so we don't expect
    // multiple positions with the same symbol+side. If this assumption changes,
    // we'd need to track by position ID instead.
    const currentPositionMap = new Map<string, PositionData>();
    for (const pos of currentPositions) {
        // Validate size is a positive finite number
        if (!Number.isFinite(pos.size) || pos.size <= 0) continue;

        // Normalize side - skip positions with invalid side
        const normalizedSide = normalizeSide(pos.side);
        if (normalizedSide === null) {
            logger.warn(`Skipping position with invalid side: ${pos.symbol} side=${pos.side}`);
            continue;
        }

        // Create composite key: symbol + normalized side
        const key = `${pos.symbol}:${normalizedSide}`;

        // If we already have a position for this key, log a warning (unexpected)
        if (currentPositionMap.has(key)) {
            logger.warn(`Multiple positions detected for ${key} - using latest`);
        }
        currentPositionMap.set(key, pos);
    }

    // Collect trades to process (avoid modifying Map while iterating)
    const tradesToProcess: Array<{ tradeId: string; tracked: TrackedTrade }> = [];
    const tradesToUpdateSyncTime: string[] = [];

    // Check each tracked trade by tradeId
    for (const [tradeId, tracked] of trackedTrades.entries()) {
        // Create composite key for this tracked trade
        const trackedKey = `${tracked.symbol}:${tracked.side}`;

        // Skip if position still exists with matching symbol AND side
        if (currentPositionMap.has(trackedKey)) {
            // Mark for sync time update (don't modify during iteration)
            tradesToUpdateSyncTime.push(tradeId);
            continue;
        }

        // Position closed - atomically check-and-set inProgressTradeIds to prevent race condition
        // This ensures no concurrent syncPositions can also queue this trade
        if (inProgressTradeIds.has(tradeId)) {
            logger.debug(`Trade ${tradeId} already being processed, skipping`);
            continue;
        }

        // Atomically add to inProgressTradeIds BEFORE adding to tradesToProcess
        // JavaScript is single-threaded, so between the check above and this add,
        // no other code can run (no race condition in synchronous code)
        inProgressTradeIds.add(tradeId);

        // Now safe to add to processing queue
        tradesToProcess.push({ tradeId, tracked });
    }

    // Update sync times for active positions and reset their missing counters
    for (const tradeId of tradesToUpdateSyncTime) {
        const tracked = trackedTrades.get(tradeId);
        if (tracked) {
            tracked.lastSyncAt = now;
        }
        // Reset missing counter - trade was seen in current positions
        notSeenCounts.delete(tradeId);
    }

    // Process closed positions
    for (const { tradeId, tracked } of tradesToProcess) {
        // Note: tradeId was already added to inProgressTradeIds atomically above
        // Position closed - process it
        logger.info(`Position closed detected: ${tracked.symbol} ${tracked.side} (tradeId: ${tradeId})`);

        try {
            const closeResult = await determineCloseResult(weexClient, tracked);
            await handlePositionClosed(tracked, closeResult);
            // Only remove from tracking and increment count on SUCCESS
            trackedTrades.delete(tradeId);
            notSeenCounts.delete(tradeId); // Clean up associated counter
            closedCount++;
        } catch (error) {
            // On failure, leave trade in trackedTrades for retry on next sync cycle
            logger.error(`Failed to process closed position ${tracked.symbol}:`, error);
        } finally {
            // Always remove from in-progress set
            inProgressTradeIds.delete(tradeId);
        }
    }

    // Cleanup stale trades (older than 72 hours with no position AND missing for multiple cycles)
    // This prevents premature removal during transient API issues
    // Collect stale trade IDs first to avoid modifying Map while iterating
    const staleTradeIds: string[] = [];
    const staleThreshold = now - (STALE_TRADE_HOURS * 60 * 60 * 1000);
    for (const [tradeId, tracked] of trackedTrades.entries()) {
        const trackedKey = `${tracked.symbol}:${tracked.side}`;
        const isOldEnough = tracked.openedAt < staleThreshold;
        const isNotInPositions = !currentPositionMap.has(trackedKey);

        if (isNotInPositions) {
            // Increment missing counter for trades not seen in current positions
            const currentCount = notSeenCounts.get(tradeId) || 0;
            notSeenCounts.set(tradeId, currentCount + 1);

            // Only mark as stale if old enough AND missing for multiple consecutive cycles
            if (isOldEnough && currentCount + 1 >= MISSING_CYCLE_THRESHOLD) {
                staleTradeIds.push(tradeId);
            }
        } else {
            // Trade is in positions - reset counter (shouldn't happen here, but defensive)
            notSeenCounts.delete(tradeId);
        }
    }

    // Remove stale trades
    for (const tradeId of staleTradeIds) {
        const tracked = trackedTrades.get(tradeId);
        if (tracked) {
            const missingCount = notSeenCounts.get(tradeId) || 0;
            logger.warn(`Removing stale tracked trade: ${tracked.symbol} ${tracked.side} (tradeId: ${tradeId}, opened ${STALE_TRADE_HOURS}+ hours ago, missing for ${missingCount} cycles)`);
            trackedTrades.delete(tradeId);
            notSeenCounts.delete(tradeId);
        }
    }

    return closedCount;
}

/**
 * Determine how a position was closed by querying order history
 */
async function determineCloseResult(
    weexClient: WeexClient,
    tracked: TrackedTrade
): Promise<CloseResult> {
    const holdTimeHours = (Date.now() - tracked.openedAt) / (1000 * 60 * 60);

    try {
        // Query recent order history for this symbol
        const orders = await weexClient.getHistoryOrders(tracked.symbol, 20);

        if (!orders || orders.length === 0) {
            return createUnknownCloseResult(tracked, holdTimeHours);
        }

        // Find the most recent filled close order
        // Sort by createTime descending to get the latest order first
        const sortedOrders = [...orders].sort((a, b) => {
            const timeA = Number(a.createTime) || 0;
            const timeB = Number(b.createTime) || 0;
            return timeB - timeA;
        });

        const closeOrder = sortedOrders.find(o => {
            const isClose = o.type?.includes('close') ||
                o.type?.includes('liquidate') ||
                o.type?.includes('burst');
            const isFilled = o.status === 'filled';
            return isClose && isFilled;
        });

        if (!closeOrder) {
            return createUnknownCloseResult(tracked, holdTimeHours);
        }

        // Parse close price
        const closePrice = parseFloat(closeOrder.priceAvg || closeOrder.price || '0');
        if (!Number.isFinite(closePrice) || closePrice <= 0) {
            return createUnknownCloseResult(tracked, holdTimeHours);
        }

        // Calculate P&L
        // Note: For perpetual futures, P&L is simply price_diff * size
        // Leverage affects margin requirement, not the P&L calculation itself
        const isLong = tracked.side === 'BUY';
        const priceDiff = isLong
            ? closePrice - tracked.entryPrice
            : tracked.entryPrice - closePrice;

        // Gross P&L = price difference × size (leverage is NOT multiplied here)
        // Leverage determines how much margin was used, not the P&L
        const grossPnl = priceDiff * tracked.size;

        // Subtract fees and funding
        const entryFee = tracked.entryFee ?? 0;
        const exitFee = tracked.exitFee ?? 0;
        const fundingPaid = tracked.fundingPaid ?? 0;
        const totalCosts = entryFee + exitFee + fundingPaid;

        const realizedPnl = grossPnl - totalCosts;

        // Calculate P&L percent relative to margin (notional / leverage = margin)
        // This gives the actual return on invested capital (ROI on margin)
        const notional = tracked.size * tracked.entryPrice;
        // Guard against non-positive leverage (0, negative, or NaN) to prevent division by zero
        const leverage = (Number.isFinite(tracked.leverage) && tracked.leverage > 0) ? tracked.leverage : 1;
        const margin = notional / leverage;
        // Guard against zero/negative margin to prevent division by zero or Infinity
        const realizedPnlPercent = (Number.isFinite(margin) && margin > 0) ? (realizedPnl / margin) * 100 : 0;

        // Determine exit reason with proper null/zero checks
        // Use combined threshold: max of relative (0.5%) and absolute (MIN_ABS_PRICE_DIFF) to handle tiny prices
        let exitReason: CloseResult['exitReason'] = 'unknown';

        if (closeOrder.type?.includes('liquidate') || closeOrder.type?.includes('burst')) {
            exitReason = 'liquidation';
        } else if (tracked.tpPrice != null && tracked.tpPrice !== 0) {
            // Use combined threshold for TP matching
            const tpThreshold = Math.max(tracked.tpPrice * 0.005, MIN_ABS_PRICE_DIFF);
            if (Math.abs(closePrice - tracked.tpPrice) < tpThreshold) {
                exitReason = 'tp_hit';
            }
        }

        // Only check SL if not already determined as TP
        if (exitReason === 'unknown' && tracked.slPrice != null && tracked.slPrice !== 0) {
            // Use combined threshold for SL matching
            const slThreshold = Math.max(tracked.slPrice * 0.005, MIN_ABS_PRICE_DIFF);
            if (Math.abs(closePrice - tracked.slPrice) < slThreshold) {
                exitReason = 'sl_hit';
            }
        }

        // Default to manual if no specific exit reason found
        if (exitReason === 'unknown') {
            exitReason = 'manual';
        }

        return {
            closePrice,
            realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
            realizedPnlPercent: Number.isFinite(realizedPnlPercent) ? realizedPnlPercent : 0,
            exitReason,
            holdTimeHours,
        };
    } catch (error) {
        logger.warn(`Failed to query order history for ${tracked.symbol}:`, error);
        return createUnknownCloseResult(tracked, holdTimeHours);
    }
}

function createUnknownCloseResult(tracked: TrackedTrade, holdTimeHours: number): CloseResult {
    return {
        closePrice: tracked.entryPrice, // Fallback
        realizedPnl: 0,
        realizedPnlPercent: 0,
        exitReason: 'unknown',
        holdTimeHours,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION CLOSURE HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle a closed position - update DB and create journal entry
 * 
 * NOTE: DB update and journal creation are NOT atomic. If journal creation fails,
 * the error is re-thrown so the caller can keep the trade tracked for retry.
 * This ensures we don't lose journal entries for closed positions.
 */
async function handlePositionClosed(
    tracked: TrackedTrade,
    closeResult: CloseResult
): Promise<void> {
    const { realizedPnl, realizedPnlPercent, exitReason, holdTimeHours } = closeResult;

    // Determine outcome using configurable threshold (default ±1%)
    // This accounts for fees and leverage effects on small price movements
    const threshold = POSITION_OUTCOME_THRESHOLD_PERCENT;
    let outcome: 'win' | 'loss' | 'breakeven';
    if (realizedPnlPercent > threshold) {
        outcome = 'win';
    } else if (realizedPnlPercent < -threshold) {
        outcome = 'loss';
    } else {
        outcome = 'breakeven';
    }

    // Map exit reason to journal format
    const journalExitReason = mapExitReason(exitReason);

    // Update trade in database
    try {
        const updateResult = await prisma.trade.updateMany({
            where: {
                weexOrderId: tracked.orderId,
                status: { not: 'FILLED' } // Don't update if already filled
            },
            data: {
                status: 'FILLED',
                realizedPnl,
                realizedPnlPercent,
            },
        });

        // Validate exactly one row was updated
        if (updateResult.count === 0) {
            logger.warn(`No trade found to update for orderId ${tracked.orderId} (may already be FILLED)`);
        } else if (updateResult.count > 1) {
            logger.error(`Multiple trades (${updateResult.count}) updated for orderId ${tracked.orderId} - data integrity issue`);
        }

        logger.info(`Updated trade ${tracked.orderId} in database: ${outcome} (${realizedPnlPercent.toFixed(2)}%)`);
    } catch (dbError) {
        logger.error(`Failed to update trade in database:`, dbError);
        // Re-throw to signal failure - caller will keep trade tracked for retry
        throw dbError;
    }

    // Create journal entry using internal tradeId (not orderId)
    // If this fails, re-throw so the caller knows to keep the trade tracked for retry
    try {
        await addJournalEntry({
            tradeId: tracked.tradeId, // Use internal tradeId, not orderId
            entryRegime: tracked.entryRegime || 'unknown',
            // Use 0 as default for nullable numeric fields when creating journal entry
            entryZScore: tracked.entryZScore ?? 0,
            entryFunding: tracked.entryFunding ?? 0,
            entrySentiment: tracked.entrySentiment ?? 0,
            entrySignals: tracked.entrySignals ?? {},
            winningAnalyst: tracked.winningAnalyst ?? '',
            analystScores: tracked.analystScores ?? {},
            judgeReasoning: tracked.judgeReasoning ?? '',
            outcome,
            pnlPercent: realizedPnlPercent,
            holdTimeHours,
            exitReason: journalExitReason,
            lessonsLearned: null, // Will be generated by addLessonToEntry
        });
        logger.info(`Journal entry created for ${tracked.symbol}: ${outcome} via ${journalExitReason}`);

        // Generate lesson from trade outcome (v5.2.0)
        // This auto-generates insights based on entry conditions and outcome
        try {
            const lesson = await addLessonToEntry(tracked.tradeId); // Use tradeId, await the Promise
            if (lesson && lesson.length > 0) {
                // Truncate long lessons for logging, only add ellipsis if actually truncated
                const truncatedLesson = lesson.length > 100 ? `${lesson.slice(0, 100)}...` : lesson;
                logger.info(`📚 Lesson generated for ${tracked.symbol}: ${truncatedLesson}`);
            }
        } catch (lessonError) {
            // Lesson generation is non-critical - log but don't fail
            logger.debug('Lesson generation skipped:', lessonError instanceof Error ? lessonError.message : 'unknown');
        }
    } catch (journalError) {
        logger.error(`Failed to create journal entry:`, journalError);
        // Re-throw to signal failure - caller will keep trade tracked for retry
        throw journalError;
    }
}

function mapExitReason(
    exitReason: CloseResult['exitReason']
): 'tp_hit' | 'sl_hit' | 'manual' | 'time_exit' | 'invalidated' {
    switch (exitReason) {
        case 'tp_hit': return 'tp_hit';
        case 'sl_hit': return 'sl_hit';
        case 'liquidation': return 'sl_hit'; // Liquidation is essentially a forced SL
        case 'manual': return 'manual';
        default: return 'manual'; // Default to manual for unknown
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHUTDOWN & STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset module-level state (for testing)
 * Clears all tracked trades, in-progress set, and missing counters
 */
export function resetState(): void {
    trackedTrades.clear();
    inProgressTradeIds.clear();
    notSeenCounts.clear();
    logger.debug('Position sync service state reset');
}

/**
 * Shutdown the position sync service
 */
export function shutdownPositionSyncService(): void {
    trackedTrades.clear();
    inProgressTradeIds.clear();
    notSeenCounts.clear();
    logger.info('Position sync service shutdown complete');
}

export default {
    trackOpenTrade,
    getTrackedTrade,
    getTrackedTradeBySymbol,
    removeTrackedTrade,
    getAllTrackedTrades,
    clearTrackedTrades,
    syncPositions,
    resetState,
    shutdownPositionSyncService,
};
