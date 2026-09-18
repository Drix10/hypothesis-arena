/**
 * Quant Analysis Service Exports (v5.2.0)
 * 
 * Re-exports from:
 * - QuantAnalysisService: Core quant context, signals, and statistical metrics
 * - RegimeDetector: 4-state market regime detection (risk-on/risk-off/high-vol/low-vol)
 * - MonteCarloService: Fat-tailed Monte Carlo simulation for trade validation
 * 
 * Note: Re-exports execute their source modules on first import. Type exports are
 * side-effect free, but function exports may initialize module-level state (timers, caches).
 */

export {
    // Main functions
    getQuantContext,
    getAssetQuantAnalysis,
    formatQuantForPrompt,
    clearQuantCache,
    clearFundingHistory,  // v5.1.0
    shutdownQuantService,
    resetQuantServiceState,

    // Types
    type QuantSignal,
    type StatisticalMetrics,
    type PatternAnalysis,
    type ProbabilityMetrics,
    type AssetQuantAnalysis,
    type CrossAssetAnalysis,
    type QuantContext,
    // v5.1.0 Funding Rate Types
    type FundingRateAnalysis,
    type FundingSignal,
} from './QuantAnalysisService';

// v5.1.0 Phase 2: Regime Detection
export {
    detectRegime,
    formatRegimeForPrompt,
    clearRegimeHistory,
    cleanupStaleRegimeHistory,
    shutdownRegimeDetector,
    type MarketRegime,
    type RegimeInput,
} from './RegimeDetector';

// v5.1.0 Phase 2: Monte Carlo Simulation
export {
    runMonteCarloSimulation,
    analyzeWithMonteCarlo,
    validateTradeWithMonteCarlo,
    formatMonteCarloForPrompt,
    formatAnalysisForPrompt,
    type MonteCarloConfig,
    type MonteCarloResult,
    type MonteCarloAnalysis,
} from './MonteCarloService';
