/**
 * Position Services Index
 * 
 * Exports position tracking and sync services.
 */

export {
    trackOpenTrade,
    getTrackedTrade,
    getTrackedTradeBySymbol,
    removeTrackedTrade,
    getAllTrackedTrades,
    clearTrackedTrades,
    syncPositions,
    resetState,
    shutdownPositionSyncService,
    type TrackedTrade,
    type PositionData,
} from './PositionSyncService';
