/**
 * MonteCarloService - Fat-Tailed Monte Carlo Simulation (v5.4.0)
 * Implements Monte Carlo simulation with Student's t-distribution for fat tails and GARCH(1,1) for volatility clustering.
 */

export interface MonteCarloConfig {
    simulations: number;
    timeHorizon: number;
    volatility: number;
    drift: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    direction: 'long' | 'short';
}

export interface MonteCarloResult {
    expectedValue: number;
    winRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
    var95: number;
    var99: number;
    profitDistribution: {
        p10: number;
        p25: number;
        p50: number;
        p75: number;           // 75th percentile
        p90: number;           // 90th percentile
    };

    // Recommendation
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'avoid';
    recommendationReason: string;

    // Metadata
    simulations: number;
    timeHorizon: number;
    tradingCostApplied: number;
    computedAt: string;
}

export interface MonteCarloAnalysis {
    longScenario: MonteCarloResult;
    shortScenario: MonteCarloResult;
    recommendedDirection: 'long' | 'short' | 'none';
    edgeStrength: number;      // 0-100
    shouldTrade: boolean;
    reason: string;
}



const DEFAULT_TRADING_COST = 0.06;  // 0.06% per trade (per quant advisor)
const STUDENT_T_DF = 3;             // Degrees of freedom for Student's t (crypto fat tails)
// df=3 is more realistic for crypto's extreme tail events
// df=5 was too conservative - crypto has fatter tails than that
const GARCH_ALPHA = 0.1;            // GARCH alpha parameter
const GARCH_BETA = 0.85;            // GARCH beta parameter
const MIN_SHARPE_THRESHOLD = 1.2;   // Minimum Sharpe for trade approval (per quant advisor)



/**
 * Generate a random number from standard normal distribution
 * Using Box-Muller transform
 */
function normalRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();  // Avoid log(0)
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Generate a random number from Student's t-distribution
 * More realistic for crypto (fat tails)
 * 
 * Uses the ratio of a standard normal to sqrt(chi-squared/df)
 * This produces heavier tails than normal distribution
 * 
 * RECOMMENDED: df=3 for crypto markets (current default)
 * - df=3 produces infinite kurtosis (very heavy tails), which better models
 *   crypto's extreme price movements compared to df=5 or higher
 * - Extreme values are clamped to ±10 standard deviations to prevent
 *   simulation blow-ups while preserving fat-tail behavior
 * 
 * @param df - Degrees of freedom (must be a positive integer, df=3 recommended for crypto)
 * @throws TypeError if df is not a positive integer
 */
function studentTRandom(df: number = STUDENT_T_DF): number {
    // Validate df is a positive integer
    if (!Number.isInteger(df) || df < 1) {
        throw new TypeError(`Degrees of freedom (df) must be a positive integer, got: ${df}`);
    }

    const normal = normalRandom();
    let chiSquared = 0;

    // Generate chi-squared with df degrees of freedom
    // Chi-squared is sum of df squared standard normals
    for (let i = 0; i < df; i++) {
        const n = normalRandom();
        chiSquared += n * n;
    }

    // Avoid division by zero or very small values
    // In practice, chiSquared being exactly 0 is astronomically unlikely
    // but we guard against it and very small values that could cause extreme results
    if (chiSquared < 0.001) {
        // Return a bounded extreme value instead of infinity
        return normal > 0 ? 5 : -5;
    }

    const result = normal / Math.sqrt(chiSquared / df);

    // Clamp to reasonable range to prevent simulation blow-ups
    // 10 standard deviations is already extremely rare
    return Math.max(-10, Math.min(10, result));
}

/**
 * Simple GARCH(1,1) volatility multiplier
 * Increases vol after big moves (volatility clustering)
 * 
 * GARCH(1,1) model: σ²_t = ω + α * r²_{t-1} + β * σ²_{t-1}
 * We track the multiplier (σ) not variance (σ²) for direct use
 * 
 * @param previousReturn - Previous period return
 * @param previousMultiplier - Previous GARCH multiplier (σ, not σ²)
 * @param alpha - Weight on previous return squared (default 0.1)
 * @param beta - Weight on previous variance (default 0.85)
 */
function garchMultiplier(
    previousReturn: number,
    previousMultiplier: number,
    alpha: number = GARCH_ALPHA,
    beta: number = GARCH_BETA
): number {
    // Validate inputs to prevent NaN/Infinity
    if (!Number.isFinite(previousReturn)) previousReturn = 0;
    if (!Number.isFinite(previousMultiplier) || previousMultiplier <= 0) previousMultiplier = 1;

    // Clamp previousReturn to prevent overflow (max ±50% move per period)
    const clampedReturn = Math.max(-0.5, Math.min(0.5, previousReturn));
    // Clamp previousMultiplier to reasonable range (this is σ, not σ²)
    const clampedPrevMult = Math.max(0.5, Math.min(3.0, previousMultiplier));

    // GARCH(1,1): σ²_t = ω + α * r²_{t-1} + β * σ²_{t-1}
    // ω = 1 - α - β ensures long-run variance converges to 1
    const omega = 1 - alpha - beta;
    // Convert multiplier to variance for GARCH calculation
    const prevVariance = clampedPrevMult * clampedPrevMult;
    const newVariance = omega + alpha * clampedReturn * clampedReturn + beta * prevVariance;

    // Clamp variance to reasonable range (0.25 to 9.0, i.e., σ from 0.5x to 3x)
    const clampedVariance = Math.max(0.25, Math.min(9.0, newVariance));
    const multiplier = Math.sqrt(clampedVariance);

    return Number.isFinite(multiplier) ? multiplier : 1.0;
}



/**
 * Run Monte Carlo simulation for a trade
 * 
 * Enhanced with:
 * - Student's t-distribution for fat tails
 * - GARCH(1,1) for volatility clustering
 * - Trading costs subtraction
 */
export function runMonteCarloSimulation(config: MonteCarloConfig): MonteCarloResult {
    // Validate and sanitize inputs
    const validatedConfig = validateConfig(config);

    const results: number[] = [];
    const tradingCost = DEFAULT_TRADING_COST;

    // Convert hourly volatility to per-step volatility
    // Assuming 1 step = 1 hour
    const stepVolatility = validatedConfig.volatility / 100;  // Convert % to decimal
    // Drift is per-hour, scale to per-step (already hourly, so use directly)
    const stepDrift = validatedConfig.drift || 0;

    // Direction multiplier (short = inverse returns)
    const directionMult = validatedConfig.direction === 'short' ? -1 : 1;

    for (let sim = 0; sim < validatedConfig.simulations; sim++) {
        let price = 100;  // Normalized starting price
        let pnl = 0;
        let hitExit = false;
        let garchMult = 1.0;

        for (let t = 0; t < validatedConfig.timeHorizon && !hitExit; t++) {
            // Generate random shock using Student's t for fat tails
            const randomShock = studentTRandom(STUDENT_T_DF) * stepVolatility * garchMult;
            // For shorts, invert drift (bearish drift helps shorts)
            const effectiveDrift = validatedConfig.direction === 'short' ? -stepDrift : stepDrift;
            const priceChange = effectiveDrift + randomShock;

            // Update GARCH multiplier for next period
            garchMult = garchMultiplier(priceChange, garchMult);

            // Apply price change
            price *= (1 + priceChange);

            // Safety check for invalid prices
            if (!Number.isFinite(price) || price <= 0) {
                // For shorts, price going to 0 is max profit; for longs, it's max loss
                pnl = validatedConfig.direction === 'short'
                    ? validatedConfig.takeProfitPercent  // Short wins when price collapses
                    : -validatedConfig.stopLossPercent;  // Long loses when price collapses
                hitExit = true;
                break;
            }

            // Calculate current PnL (adjusted for direction)
            const rawPnl = ((price - 100) / 100) * 100;
            const currentPnl = rawPnl * directionMult;

            // Check stop loss
            if (currentPnl <= -validatedConfig.stopLossPercent) {
                pnl = -validatedConfig.stopLossPercent;
                hitExit = true;
                break;
            }

            // Check take profit
            if (currentPnl >= validatedConfig.takeProfitPercent) {
                pnl = validatedConfig.takeProfitPercent;
                hitExit = true;
                break;
            }
        }

        // If no exit hit, use final price
        if (!hitExit) {
            const rawPnl = ((price - 100) / 100) * 100;
            // Apply direction multiplier and clamp to SL/TP bounds
            const directedPnl = rawPnl * directionMult;
            // Symmetrically clamp PnL between -stopLoss and +takeProfit
            pnl = Math.max(-validatedConfig.stopLossPercent, Math.min(validatedConfig.takeProfitPercent, directedPnl));
        }

        // Subtract trading costs (entry + exit)
        pnl -= tradingCost * 2;

        results.push(pnl);
    }

    return calculateStatistics(results, validatedConfig, tradingCost * 2);
}

/**
 * Calculate statistics from simulation results
 */
function calculateStatistics(
    results: number[],
    config: MonteCarloConfig,
    tradingCostApplied: number
): MonteCarloResult {
    const timestamp = new Date().toISOString();

    if (results.length === 0) {
        return createEmptyResult(config, tradingCostApplied, timestamp);
    }

    // Sort for percentile calculations
    const sorted = [...results].sort((a, b) => a - b);
    const n = sorted.length;

    // Expected value (mean)
    const sum = results.reduce((a, b) => a + b, 0);
    const expectedValue = sum / n;

    // Win rate
    const wins = results.filter(r => r > 0).length;
    const winRate = (wins / n) * 100;

    // Standard deviation
    const squaredDiffs = results.map(r => Math.pow(r - expectedValue, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / Math.max(1, n - 1);
    const stdDev = Math.sqrt(variance);

    // Sharpe ratio (annualized)
    // Conservative estimate: ~2 trades/day × 365 days = ~730 trades/year
    // We use per-trade Sharpe, so annualize by sqrt(tradesPerYear)
    const tradesPerYear = 750;  // Conservative estimate (~2 trades/day)
    const sharpeRatio = stdDev > 0.001
        ? (expectedValue / stdDev) * Math.sqrt(tradesPerYear)
        : 0;

    // Max drawdown (worst loss only - ignore gains)
    // sorted[0] is the worst outcome; only count as drawdown if it's a loss
    const maxDrawdown = Math.max(0, -sorted[0]);

    // Value at Risk - using (n-1) convention for better quantile targeting with small n
    // For p-th percentile, index = floor((n-1) * p) gives the value at or below which p% of data falls
    // When n=1, all indices are 0, which is correct (only one value)
    const var95Index = Math.max(0, Math.floor((n - 1) * 0.05));
    const var99Index = Math.max(0, Math.floor((n - 1) * 0.01));
    const var95 = sorted[var95Index] ?? sorted[0];
    const var99 = sorted[var99Index] ?? sorted[0];

    // Percentiles - using (n-1) convention for consistent quantile calculation
    // When n=1, all percentiles return sorted[0] (the only value)
    const getPercentile = (p: number): number => {
        if (n === 1) return sorted[0];
        const index = Math.min(Math.floor((n - 1) * p), n - 1);
        return sorted[index];
    };

    const profitDistribution = {
        p10: getPercentile(0.1),
        p25: getPercentile(0.25),
        p50: getPercentile(0.5),
        p75: getPercentile(0.75),
        p90: getPercentile(0.9),
    };

    // Generate recommendation
    const { recommendation, reason } = generateRecommendation(
        expectedValue,
        winRate,
        sharpeRatio,
        maxDrawdown
    );

    return {
        expectedValue: safeNumber(expectedValue),
        winRate: safeNumber(winRate),
        maxDrawdown: safeNumber(maxDrawdown),
        sharpeRatio: safeNumber(sharpeRatio),
        var95: safeNumber(var95),
        var99: safeNumber(var99),
        profitDistribution: {
            p10: safeNumber(profitDistribution.p10),
            p25: safeNumber(profitDistribution.p25),
            p50: safeNumber(profitDistribution.p50),
            p75: safeNumber(profitDistribution.p75),
            p90: safeNumber(profitDistribution.p90),
        },
        recommendation,
        recommendationReason: reason,
        simulations: config.simulations,
        timeHorizon: config.timeHorizon,
        tradingCostApplied,
        computedAt: timestamp,
    };
}

function generateRecommendation(
    ev: number,
    winRate: number,
    sharpe: number,
    maxDD: number
): { recommendation: MonteCarloResult['recommendation']; reason: string } {
    // Per quant advisor: Sharpe > 1.2 minimum for trade approval

    // Safely format numbers with NaN guard
    // For non-finite values, return properly formatted zero (e.g., "0.00" for decimals=2)
    const formatNum = (n: number, decimals: number = 2): string =>
        Number.isFinite(n) ? n.toFixed(decimals) : (0).toFixed(decimals);

    // Ensure all inputs are valid numbers for comparisons
    const safeEv = Number.isFinite(ev) ? ev : -Infinity;
    const safeWinRate = Number.isFinite(winRate) ? winRate : 0;
    const safeSharpe = Number.isFinite(sharpe) ? sharpe : -Infinity;
    const safeMaxDD = Number.isFinite(maxDD) ? maxDD : Infinity;

    if (safeEv > 1.5 && safeWinRate > 55 && safeSharpe > 1.5 && safeMaxDD < 5) {
        return {
            recommendation: 'strong_buy',
            reason: `Strong edge: EV=${formatNum(ev)}%, WR=${formatNum(winRate, 0)}%, Sharpe=${formatNum(sharpe)}`,
        };
    }

    if (safeEv > 0.5 && safeWinRate > 50 && safeSharpe > MIN_SHARPE_THRESHOLD) {
        return {
            recommendation: 'buy',
            reason: `Positive edge: EV=${formatNum(ev)}%, WR=${formatNum(winRate, 0)}%, Sharpe=${formatNum(sharpe)}`,
        };
    }

    if (safeEv > 0 && safeWinRate > 45 && safeSharpe > 0.8) {
        return {
            recommendation: 'hold',
            reason: `Marginal edge: EV=${formatNum(ev)}%, WR=${formatNum(winRate, 0)}%, Sharpe=${formatNum(sharpe)} (need ≥${MIN_SHARPE_THRESHOLD})`,
        };
    }

    return {
        recommendation: 'avoid',
        reason: `Negative/insufficient edge: EV=${formatNum(ev)}%, WR=${formatNum(winRate, 0)}%, Sharpe=${formatNum(sharpe)}`,
    };
}



/**
 * Run Monte Carlo analysis for both long and short scenarios
 * Returns comprehensive analysis with recommendation
 */
export function analyzeWithMonteCarlo(
    volatility: number,
    stopLossPercent: number,
    takeProfitPercent: number,
    drift: number = 0,
    simulations: number = 500,
    timeHorizon: number = 24
): MonteCarloAnalysis {
    const baseConfig = {
        simulations,
        timeHorizon,
        volatility,
        drift,
        stopLossPercent,
        takeProfitPercent,
    };

    // Run long scenario
    const longResult = runMonteCarloSimulation({
        ...baseConfig,
        direction: 'long',
    });

    // Run short scenario
    // NOTE: runMonteCarloSimulation already inverts drift internally for shorts,
    // so we pass the same drift value here (not -drift)
    const shortResult = runMonteCarloSimulation({
        ...baseConfig,
        direction: 'short',
    });

    // Determine recommended direction
    let recommendedDirection: MonteCarloAnalysis['recommendedDirection'] = 'none';
    let shouldTrade = false;
    let reason = '';

    const longValid = longResult.expectedValue > 0 && longResult.sharpeRatio >= MIN_SHARPE_THRESHOLD;
    const shortValid = shortResult.expectedValue > 0 && shortResult.sharpeRatio >= MIN_SHARPE_THRESHOLD;

    if (longValid && shortValid) {
        // Both valid - pick better one
        if (longResult.sharpeRatio > shortResult.sharpeRatio) {
            recommendedDirection = 'long';
            shouldTrade = true;
            reason = `Long preferred: Sharpe ${longResult.sharpeRatio.toFixed(2)} vs ${shortResult.sharpeRatio.toFixed(2)}`;
        } else {
            recommendedDirection = 'short';
            shouldTrade = true;
            reason = `Short preferred: Sharpe ${shortResult.sharpeRatio.toFixed(2)} vs ${longResult.sharpeRatio.toFixed(2)}`;
        }
    } else if (longValid) {
        recommendedDirection = 'long';
        shouldTrade = true;
        reason = `Long valid: EV=${longResult.expectedValue.toFixed(2)}%, Sharpe=${longResult.sharpeRatio.toFixed(2)}`;
    } else if (shortValid) {
        recommendedDirection = 'short';
        shouldTrade = true;
        reason = `Short valid: EV=${shortResult.expectedValue.toFixed(2)}%, Sharpe=${shortResult.sharpeRatio.toFixed(2)}`;
    } else {
        recommendedDirection = 'none';
        shouldTrade = false;
        reason = `No valid edge: Long Sharpe=${longResult.sharpeRatio.toFixed(2)}, Short Sharpe=${shortResult.sharpeRatio.toFixed(2)} (need ≥${MIN_SHARPE_THRESHOLD})`;
    }

    // Calculate edge strength (0-100)
    const bestSharpe = Math.max(longResult.sharpeRatio, shortResult.sharpeRatio);
    const edgeStrength = Math.min(100, Math.max(0, bestSharpe * 40));  // Sharpe 2.5 = 100

    return {
        longScenario: longResult,
        shortScenario: shortResult,
        recommendedDirection,
        edgeStrength: Math.round(edgeStrength),
        shouldTrade,
        reason,
    };
}

/**
 * Quick Monte Carlo check for trade validation
 * Returns true if trade passes Monte Carlo validation
 */
export function validateTradeWithMonteCarlo(
    direction: 'long' | 'short',
    volatility: number,
    stopLossPercent: number,
    takeProfitPercent: number,
    drift: number = 0
): { valid: boolean; sharpe: number; ev: number; reason: string } {
    // NOTE: runMonteCarloSimulation already inverts drift internally for shorts,
    // so we pass the drift value as-is regardless of direction
    const result = runMonteCarloSimulation({
        simulations: 200,  // Faster validation
        timeHorizon: 24,
        volatility,
        drift,
        stopLossPercent,
        takeProfitPercent,
        direction,
    });

    const valid = result.expectedValue > 0 && result.sharpeRatio >= MIN_SHARPE_THRESHOLD;

    return {
        valid,
        sharpe: result.sharpeRatio,
        ev: result.expectedValue,
        reason: valid
            ? `MC validated: EV=${result.expectedValue.toFixed(2)}%, Sharpe=${result.sharpeRatio.toFixed(2)}`
            : `MC rejected: EV=${result.expectedValue.toFixed(2)}%, Sharpe=${result.sharpeRatio.toFixed(2)} (need ≥${MIN_SHARPE_THRESHOLD})`,
    };
}



function validateConfig(config: MonteCarloConfig): MonteCarloConfig {
    return {
        simulations: Math.min(1000, Math.max(100, config.simulations || 500)),  // 100-1000 per interface
        timeHorizon: Math.min(48, Math.max(1, config.timeHorizon || 24)),       // 1-48 hours per interface
        volatility: Math.min(50, Math.max(0.01, config.volatility || 2)),       // Cap at 50% hourly vol (extreme)
        drift: Math.max(-0.01, Math.min(0.01, config.drift || 0)),              // -0.01 to +0.01 per interface
        stopLossPercent: Math.max(1, Math.min(5, config.stopLossPercent || 2)), // 1-5% per interface comments
        takeProfitPercent: Math.max(2, Math.min(10, config.takeProfitPercent || 4)), // 2-10% per interface comments
        direction: config.direction || 'long',
    };
}

function safeNumber(value: number, defaultValue: number = 0): number {
    return Number.isFinite(value) ? value : defaultValue;
}

function createEmptyResult(
    config: MonteCarloConfig,
    tradingCostApplied: number,
    timestamp: string
): MonteCarloResult {
    return {
        expectedValue: 0,
        winRate: 0,
        maxDrawdown: config.stopLossPercent,
        sharpeRatio: 0,
        var95: -config.stopLossPercent,
        var99: -config.stopLossPercent,
        profitDistribution: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
        recommendation: 'avoid',
        recommendationReason: 'No simulation results',
        simulations: config.simulations,
        timeHorizon: config.timeHorizon,
        tradingCostApplied,
        computedAt: timestamp,
    };
}

/**
 * Format Monte Carlo result for AI prompt (compact version)
 */
export function formatMonteCarloForPrompt(result: MonteCarloResult): string {
    // Safely format numbers with NaN guard
    const ev = Number.isFinite(result.expectedValue) ? result.expectedValue.toFixed(2) : '0.00';
    const wr = Number.isFinite(result.winRate) ? result.winRate.toFixed(0) : '0';
    const sharpe = Number.isFinite(result.sharpeRatio) ? result.sharpeRatio.toFixed(2) : '0.00';
    const var95 = Number.isFinite(result.var95) ? result.var95.toFixed(2) : '0.00';
    const recommendation = result.recommendation || 'avoid';
    const simulations = Number.isFinite(result.simulations) ? result.simulations : 0;

    return `MC(${simulations}): EV=${ev}% WR=${wr}% ` +
        `Sharpe=${sharpe} VaR95=${var95}% → ${recommendation.toUpperCase()}`;
}

/**
 * Format full analysis for AI prompt
 */
export function formatAnalysisForPrompt(analysis: MonteCarloAnalysis): string {
    const edgeStrength = Number.isFinite(analysis.edgeStrength) ? analysis.edgeStrength : 0;
    const recommendedDirection = analysis.recommendedDirection || 'none';

    const lines: string[] = [
        '=== MONTE CARLO ANALYSIS ===',
        `Long:  ${formatMonteCarloForPrompt(analysis.longScenario)}`,
        `Short: ${formatMonteCarloForPrompt(analysis.shortScenario)}`,
        `Recommendation: ${recommendedDirection.toUpperCase()} (edge: ${edgeStrength}/100)`,
        `Trade: ${analysis.shouldTrade ? 'YES' : 'NO'} - ${analysis.reason || 'No reason provided'}`,
    ];
    return lines.join('\n');
}

export default {
    runMonteCarloSimulation,
    analyzeWithMonteCarlo,
    validateTradeWithMonteCarlo,
    formatMonteCarloForPrompt,
    formatAnalysisForPrompt,
};
