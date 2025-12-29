/**
 * Autonomous Trading Engine - COLLABORATIVE MODE
 * 
 * 8 AI analysts collaborate on ONE shared portfolio.
 * Debates are the core decision mechanism.
 * 
 * 7-Stage Pipeline (from FLOW.md):
 * 1. Market Scan - Fetch data for all 8 coins
 * 2. Coin Selection - Ray, Jim, Quant pick best opportunity
 * 3. Specialist Analysis - Deep dive by assigned specialists
 * 4. Tournament - Bracket-style debates determine winner
 * 5. Risk Council - Karen approves/vetoes/adjusts
 * 6. Execution - Place trade on WEEX with TP/SL
 * 7. Position Management - Monitor and adjust positions
 */

import { EventEmitter } from 'events';
import { type ExtendedMarketData, type AnalysisResult } from '../ai/GeminiService';
import { collaborativeFlowService, type CoinSelectionResult, type RiskCouncilDecision } from '../ai/CollaborativeFlow';
import { getWeexClient } from '../weex/WeexClient';
import { tradingScheduler } from './TradingScheduler';
import { circuitBreakerService } from '../risk/CircuitBreakerService';
import { pool } from '../../config/database';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES } from '../../constants/analyst';

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

const ANALYST_IDS = ['warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil'] as const;

// =========================================================================
// DEBATE RESULT VALIDATION HELPERS
// =========================================================================

interface CoinSelectionDebateResult {
    winner: string;
    coinSymbol: string;
    direction: 'LONG' | 'SHORT';
    debate: { turns: unknown[]; scores: Record<string, unknown>; reasoning: string };
}

interface AnalysisDebateResult {
    winner: string;
    approach: { recommendation: string; confidence: number };
    debate: { turns: unknown[] };
}

interface RiskDebateResult {
    winner: string;
    riskFramework: { positionSize: number; riskLevel: string };
    debate: { turns: unknown[] };
}

interface ChampionshipDebateResult {
    champion: { analystName: string; confidence: number; thesis: string; priceTarget: { base: number; bear: number } };
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
        (result.direction === 'LONG' || result.direction === 'SHORT') &&
        result.debate !== null && typeof result.debate === 'object'
    );
}

/**
 * Validates analysis approach debate result has required properties
 */
function isValidAnalysisResult(obj: unknown): obj is AnalysisDebateResult {
    if (!obj || typeof obj !== 'object') return false;
    const result = obj as Record<string, unknown>;
    return (
        typeof result.winner === 'string' && result.winner.length > 0 &&
        result.approach !== null && typeof result.approach === 'object' &&
        result.debate !== null && typeof result.debate === 'object'
    );
}

/**
 * Validates risk assessment debate result has required properties
 */
function isValidRiskResult(obj: unknown): obj is RiskDebateResult {
    if (!obj || typeof obj !== 'object') return false;
    const result = obj as Record<string, unknown>;
    if (typeof result.winner !== 'string' || result.winner.length === 0) return false;
    if (!result.riskFramework || typeof result.riskFramework !== 'object') return false;
    if (!result.debate || typeof result.debate !== 'object') return false;
    const framework = result.riskFramework as Record<string, unknown>;
    return typeof framework.positionSize === 'number' && typeof framework.riskLevel === 'string';
}

/**
 * Validates championship debate result has required properties
 * Ensures champion.priceTarget has numeric base and bear properties
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

export class AutonomousTradingEngine extends EventEmitter {
    private isRunning = false;
    private isStarting = false; // Prevent concurrent starts
    private cycleCount = 0;
    private consecutiveFailures = 0; // Track consecutive failures for backoff
    private analystStates = new Map<string, AnalystState>();
    private weexClient = getWeexClient();
    private currentCycle: TradingCycle | null = null;
    private mainLoopPromise: Promise<void> | null = null;
    private sleepTimeout: NodeJS.Timeout | null = null;

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
        // Set max listeners to prevent memory leak warnings
        this.setMaxListeners(20);

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
     * Start the autonomous trading engine
     */
    async start(userId: string): Promise<void> {
        if (this.isRunning) {
            logger.warn('Autonomous trading engine already running');
            return;
        }

        // If a previous loop is still cleaning up, wait for cleanup to finish
        if (this.mainLoopPromise && !this.isStarting) {
            logger.warn('Previous engine loop detected. Performing cleanup before restart...');
            await this.cleanup();
        }

        if (this.isStarting) {
            logger.warn('Autonomous trading engine is starting...');
            return;
        }

        this.isStarting = true;

        try {
            logger.info('🏟️ Starting Autonomous Trading Engine (Collaborative Mode)...');

            // Initialize analyst portfolios
            await this.initializeAnalysts(userId);

            if (this.analystStates.size === 0) {
                throw new Error('Failed to initialize any analysts');
            }

            this.isRunning = true;
            this.emit('started');

            // Start the main loop
            this.mainLoopPromise = this.runMainLoop(userId).catch(err => {
                logger.error('Fatal error in trading engine:', err);
                this.stop();
            });

        } catch (error) {
            logger.error('Failed to start engine:', error);
            this.isRunning = false;
            throw error;
        } finally {
            this.isStarting = false;
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
     */
    private completeCycle(cycleStart: number, reason: string): void {
        if (!this.currentCycle) return;

        this.currentCycle.endTime = Date.now();
        const cycleDuration = this.currentCycle.endTime - cycleStart;
        logger.info(`✅ Cycle #${this.cycleCount} complete (${reason}): ${this.currentCycle.tradesExecuted} trades, ${this.currentCycle.debatesRun} debates (${(cycleDuration / 1000).toFixed(1)}s)`);
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
            analysts,
            currentCycle: this.currentCycle,
            sharedPortfolio: {
                balance: sharedBalance,
                totalTrades: sharedTotalTrades,
                positionCount: sharedPositions.length,
            },
            stats: {
                totalTrades: sharedTotalTrades,
                tradesThisCycle: this.currentCycle?.tradesExecuted || 0,
                avgCycleTime: this.CYCLE_INTERVAL_MS,
            },
            nextCycleIn: this.currentCycle
                ? Math.max(0, this.CYCLE_INTERVAL_MS - (Date.now() - this.currentCycle.startTime))
                : this.CYCLE_INTERVAL_MS,
        };
    }

    /**
     * Initialize ONE shared collaborative portfolio for all 8 analysts
     * COLLABORATIVE MODE: All analysts share a single portfolio per FLOW.md
     * Balance is ALWAYS fetched from WEEX wallet, not stored in database
     * 
     * EDGE CASES HANDLED:
     * - Invalid userId validation
     * - WEEX API failures with graceful degradation
     * - Database connection errors
     */
    private async initializeAnalysts(userId: string): Promise<void> {
        // Validate userId
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            throw new Error('Invalid userId provided to initializeAnalysts');
        }

        logger.info('Initializing collaborative portfolio (8 analysts, 1 shared portfolio)...');

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
            const existing = await pool.query(
                `SELECT id, total_trades, win_rate 
                 FROM portfolios 
                 WHERE user_id = $1 AND agent_id = 'collaborative'`,
                [userId]
            );

            let portfolioId: string;
            let totalTrades: number;
            let winRate: number;

            if (existing.rows.length > 0) {
                const row = existing.rows[0];
                portfolioId = row.id;
                totalTrades = parseInt(row.total_trades || '0', 10);
                winRate = parseFloat(row.win_rate || '0');

                // Update the database balance to match wallet (for display purposes only)
                await pool.query(
                    `UPDATE portfolios SET current_balance = $1, updated_at = NOW() WHERE id = $2`,
                    [walletBalance, portfolioId]
                );

                logger.info(`📊 Collaborative Portfolio: Existing (${walletBalance.toFixed(2)} USDT from wallet, ${totalTrades} trades)`);
            } else {
                const result = await pool.query(
                    `INSERT INTO portfolios (
                        user_id, agent_id, agent_name, initial_balance, current_balance, status
                    ) VALUES ($1, 'collaborative', 'Collaborative AI Team', $2, $3, 'active') RETURNING id`,
                    [userId, walletBalance, walletBalance]
                );

                portfolioId = result.rows[0].id;
                totalTrades = 0;
                winRate = 0;
                logger.info(`📊 Collaborative Portfolio: Created new (${walletBalance.toFixed(2)} USDT from wallet)`);
            }

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

            // Initialize all 8 analysts with the SAME shared portfolio
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

            logger.info(`📊 Collaborative portfolio initialized: 8 analysts sharing ${walletBalance.toFixed(2)} USDT`);

        } catch (error) {
            logger.error('Failed to initialize collaborative portfolio:', error);
            throw error;
        }
    }

    /**
     * Main trading loop
     */
    private async runMainLoop(userId: string): Promise<void> {
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
            this.emit('cycleStart', this.cycleCount);

            try {
                // =================================================================
                // STAGE 1: MARKET SCAN - Fetch data for all 8 coins
                // =================================================================
                const marketDataMap = await this.fetchAllMarketData();

                if (marketDataMap.size === 0) {
                    logger.warn('No market data available, skipping cycle');
                    this.currentCycle.errors.push('No market data available');

                    // Mark cycle as complete before skipping
                    this.currentCycle.endTime = Date.now();
                    const cycleDuration = this.currentCycle.endTime - cycleStart;
                    logger.info(`✅ Cycle #${this.cycleCount} complete (no data): 0 trades, 0 debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                    this.emit('cycleComplete', this.currentCycle);

                    // Sleep before next cycle
                    const elapsed = Date.now() - cycleStart;
                    const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
                    const sleepTime = Math.max(0, dynamicInterval - elapsed);

                    if (sleepTime > 0 && this.isRunning) {
                        logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle...`);
                        await this.sleep(sleepTime);
                    }
                    continue;
                }

                // =================================================================
                // CIRCUIT BREAKER CHECK
                // =================================================================
                const btcData = marketDataMap.get('cmt_btcusdt');
                if (btcData) {
                    const circuitBreakerStatus = await circuitBreakerService.checkCircuitBreakers(userId);

                    if (circuitBreakerStatus.level === 'RED') {
                        logger.error(`🚨 RED ALERT: ${circuitBreakerStatus.reason}`);
                        logger.error(`Action: ${circuitBreakerService.getRecommendedAction('RED')}`);
                        await this.emergencyCloseAllPositions(userId);
                        this.currentCycle.errors.push(`RED ALERT: ${circuitBreakerStatus.reason} - All positions closed`);

                        // Mark cycle as complete and sleep
                        this.currentCycle.endTime = Date.now();
                        const cycleDuration = this.currentCycle.endTime - cycleStart;
                        logger.info(`✅ Cycle #${this.cycleCount} complete (RED ALERT): 0 trades, 0 debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                        this.emit('cycleComplete', this.currentCycle);

                        const elapsed = Date.now() - cycleStart;
                        const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
                        const sleepTime = Math.max(0, dynamicInterval - elapsed);

                        if (sleepTime > 0 && this.isRunning) {
                            logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle...`);
                            await this.sleep(sleepTime);
                        }
                        continue;
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
                // STAGE 2: COIN SELECTION DEBATE (Turn-by-Turn)
                // 4 analysts (Ray, Jim, Quant, Elon) debate which coin to trade
                // =================================================================
                logger.info(`🎯 Stage 2: Coin Selection Debate (${4 * config.debate.turnsPerAnalyst} turns)...`);
                let coinSelectionDebate;
                try {
                    coinSelectionDebate = await collaborativeFlowService.runCoinSelectionDebate(marketDataMap);
                } catch (error) {
                    logger.error('Coin selection debate failed:', error);
                    this.currentCycle.errors.push('Coin selection debate failed');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'coin selection failed');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // Validate debate result before destructuring
                if (!isValidCoinSelectionResult(coinSelectionDebate)) {
                    logger.error('Coin selection debate returned malformed result:', coinSelectionDebate);
                    this.currentCycle.errors.push('Coin selection debate returned invalid data');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'invalid coin selection result');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                const { winner: coinSelectorWinner, coinSymbol, direction, debate: coinDebate } = coinSelectionDebate;
                this.currentCycle.debatesRun++;

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
                logger.info(`Scores: ${Object.entries(coinDebate.scores).map(([id, s]) => `${id}:${s.total}`).join(', ')}`);
                logger.info(`${'='.repeat(60)}\n`);

                this.emit('coinSelected', {
                    topCoin: { symbol: coinSymbol, direction, totalScore: coinDebate.scores[coinSelectorWinner]?.total || 0 },
                    debate: coinDebate
                });

                const selectedMarketData = marketDataMap.get(coinSymbol);
                if (!selectedMarketData) {
                    logger.error(`Market data not found for selected coin: ${coinSymbol}`);
                    this.currentCycle.errors.push(`Market data missing for ${coinSymbol}`);
                    this.consecutiveFailures++;
                    this.completeCycle(cycleStart, 'missing market data');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // =================================================================
                // STAGE 3: ANALYSIS APPROACH DEBATE (Turn-by-Turn)
                // 4 analysts (Warren, Cathie, Jim, Quant) debate HOW to analyze
                // =================================================================
                logger.info(`🔬 Stage 3: Analysis Approach Debate for ${coinSymbol} (${4 * config.debate.turnsPerAnalyst} turns)...`);
                let analysisDebate;
                try {
                    analysisDebate = await collaborativeFlowService.runAnalysisApproachDebate(
                        coinSymbol,
                        selectedMarketData,
                        direction,
                        [coinSelectorWinner]
                    );
                } catch (error) {
                    logger.error('Analysis approach debate failed:', error);
                    this.currentCycle.errors.push('Analysis approach debate failed');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'analysis debate failed');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // Validate debate result before destructuring
                if (!isValidAnalysisResult(analysisDebate)) {
                    logger.error('Analysis approach debate returned malformed result:', analysisDebate);
                    this.currentCycle.errors.push('Analysis approach debate returned invalid data');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'invalid analysis result');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                const { winner: analysisWinner, approach, debate: analysisApproachDebate } = analysisDebate;
                this.currentCycle.debatesRun++;

                // Log debate turns - FULL arguments, no truncation
                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🔬 ANALYSIS APPROACH DEBATE - ${analysisApproachDebate.turns.length} TURNS`);
                logger.info(`${'='.repeat(60)}`);
                for (let i = 0; i < analysisApproachDebate.turns.length; i++) {
                    const turn = analysisApproachDebate.turns[i];
                    logger.info(`\n[Turn ${i + 1}] ${turn.analystName} (strength: ${turn.strength}/10):`);
                    logger.info(turn.argument);
                    if (turn.dataPointsReferenced && turn.dataPointsReferenced.length > 0) {
                        logger.info(`Data points: ${turn.dataPointsReferenced.join(', ')}`);
                    }
                }
                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🏆 Winner: ${analysisWinner} with ${approach.recommendation} (${approach.confidence}% confidence)`);
                logger.info(`Scores: ${Object.entries(analysisApproachDebate.scores).map(([id, s]) => `${id}:${s.total}`).join(', ')}`);
                logger.info(`${'='.repeat(60)}\n`);

                this.emit('specialistAnalysis', { symbol: coinSymbol, winner: analysisWinner, approach, debate: analysisApproachDebate });

                // =================================================================
                // STAGE 4: RISK ASSESSMENT DEBATE (Turn-by-Turn)
                // 4 analysts (Karen, Warren, Devil, Ray) debate position sizing & risk
                // =================================================================
                logger.info(`🛡️ Stage 4: Risk Assessment Debate for ${coinSymbol} (${4 * config.debate.turnsPerAnalyst} turns)...`);
                let riskDebate;
                try {
                    riskDebate = await collaborativeFlowService.runRiskAssessmentDebate(
                        coinSymbol,
                        approach,
                        selectedMarketData,
                        [coinSelectorWinner, analysisWinner]
                    );
                } catch (error) {
                    logger.error('Risk assessment debate failed:', error);
                    this.currentCycle.errors.push('Risk assessment debate failed');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'risk debate failed');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // Validate debate result before destructuring
                if (!isValidRiskResult(riskDebate)) {
                    logger.error('Risk assessment debate returned malformed result:', riskDebate);
                    this.currentCycle.errors.push('Risk assessment debate returned invalid data');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'invalid risk result');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                const { winner: riskWinner, riskFramework, debate: riskAssessmentDebate } = riskDebate;
                this.currentCycle.debatesRun++;

                // Log debate turns - FULL arguments, no truncation
                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🛡️ RISK ASSESSMENT DEBATE - ${riskAssessmentDebate.turns.length} TURNS`);
                logger.info(`${'='.repeat(60)}`);
                for (let i = 0; i < riskAssessmentDebate.turns.length; i++) {
                    const turn = riskAssessmentDebate.turns[i];
                    logger.info(`\n[Turn ${i + 1}] ${turn.analystName} (strength: ${turn.strength}/10):`);
                    logger.info(turn.argument);
                    if (turn.dataPointsReferenced && turn.dataPointsReferenced.length > 0) {
                        logger.info(`Data points: ${turn.dataPointsReferenced.join(', ')}`);
                    }
                }
                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🏆 Winner: ${riskWinner} → Position: ${riskFramework.positionSize}/10, Risk: ${riskFramework.riskLevel}`);
                logger.info(`Scores: ${Object.entries(riskAssessmentDebate.scores).map(([id, s]) => `${id}:${s.total}`).join(', ')}`);
                logger.info(`${'='.repeat(60)}\n`);

                // =================================================================
                // STAGE 5: CHAMPIONSHIP DEBATE (Turn-by-Turn)
                // ALL 8 analysts compete - winner's thesis gets executed
                // =================================================================
                logger.info(`🏆 Stage 5: Championship Debate for ${coinSymbol} (${8 * config.debate.turnsPerAnalyst} turns - ALL 8 analysts)...`);

                // Refresh market data before championship debate
                // Price may have moved significantly during previous stages (could be 5+ minutes)
                let championshipMarketData = selectedMarketData;
                try {
                    const [freshTicker, freshFunding] = await Promise.all([
                        this.weexClient.getTicker(coinSymbol),
                        this.weexClient.getFundingRate(coinSymbol),
                    ]);
                    const freshPrice = parseFloat(freshTicker.last);
                    if (Number.isFinite(freshPrice) && freshPrice > 0) {
                        const priceChange = Math.abs((freshPrice - selectedMarketData.currentPrice) / selectedMarketData.currentPrice * 100);
                        if (priceChange > 0.5) { // Log if price moved more than 0.5%
                            logger.info(`📊 Market data refreshed: ${coinSymbol} price moved ${priceChange.toFixed(2)}% (${selectedMarketData.currentPrice.toFixed(2)} → ${freshPrice.toFixed(2)})`);
                        }
                        championshipMarketData = {
                            ...selectedMarketData,
                            currentPrice: freshPrice,
                            high24h: parseFloat(freshTicker.high_24h) || selectedMarketData.high24h,
                            low24h: parseFloat(freshTicker.low_24h) || selectedMarketData.low24h,
                            volume24h: parseFloat(freshTicker.volume_24h) || selectedMarketData.volume24h,
                            change24h: parseFloat(freshTicker.priceChangePercent || '0') * 100 || selectedMarketData.change24h,
                            fundingRate: parseFloat(freshFunding.fundingRate || '0'),
                        };
                    }
                } catch (err) {
                    logger.warn(`Failed to refresh market data for championship, using cached data:`, err instanceof Error ? err.message : String(err));
                }

                let championshipResult;
                try {
                    championshipResult = await collaborativeFlowService.runChampionshipDebate(
                        coinSymbol,
                        championshipMarketData,
                        {
                            coinSelector: coinSelectorWinner,
                            analysisApproach: analysisWinner,
                            riskAssessment: riskWinner,
                            // Pass winning arguments from previous stages for context
                            coinSelectorArgument: coinDebate.winningArguments?.[0],
                            analysisApproachArgument: analysisApproachDebate.winningArguments?.[0],
                            riskAssessmentArgument: riskAssessmentDebate.winningArguments?.[0]
                        }
                    );
                } catch (error) {
                    logger.error('Championship debate failed:', error);
                    this.currentCycle.errors.push('Championship debate failed');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'championship failed');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // Validate debate result before destructuring
                if (!isValidChampionshipResult(championshipResult)) {
                    logger.error('Championship debate returned malformed result:', championshipResult);
                    this.currentCycle.errors.push('Championship debate returned invalid data');
                    this.consecutiveFailures++;
                    await this.updateLeaderboard();
                    this.completeCycle(cycleStart, 'invalid championship result');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                const { champion, debate: championshipDebate } = championshipResult;
                this.currentCycle.debatesRun++;

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
                logger.info(`Scores: ${Object.entries(championshipDebate.scores).map(([id, s]) => `${id}:${s.total}`).join(', ')}`);
                logger.info(`${'='.repeat(60)}\n`);

                this.emit('tournamentComplete', { champion, debate: championshipDebate });

                // Check minimum confidence threshold
                if (champion.confidence < this.MIN_CONFIDENCE_TO_TRADE) {
                    logger.info(`Champion confidence ${champion.confidence}% below threshold ${this.MIN_CONFIDENCE_TO_TRADE}%, skipping trade`);
                    await this.updateLeaderboard();
                    this.consecutiveFailures = 0; // Reset on successful debate completion (just low confidence)
                    this.completeCycle(cycleStart, 'low confidence');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                // Reset consecutive failures on successful debate completion
                this.consecutiveFailures = 0;

                // Apply risk framework adjustments from Stage 4 to champion
                // This ensures the risk debate's position sizing is respected
                const adjustedChampion = {
                    ...champion,
                    positionSize: riskFramework.positionSize,
                    riskLevel: riskFramework.riskLevel
                };
                logger.info(`Applied Stage 4 risk adjustments: position ${adjustedChampion.positionSize}/10, risk ${adjustedChampion.riskLevel}`);

                // =================================================================
                // STAGE 6: RISK COUNCIL - Karen approves/vetoes/adjusts
                // =================================================================
                logger.info('🛡️ Stage 6: Risk Council Final Review...');

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
                        const priceChange = Math.abs((freshPrice - championshipMarketData.currentPrice) / championshipMarketData.currentPrice * 100);
                        if (priceChange > 0.3) { // Log if price moved more than 0.3%
                            logger.info(`📊 Market data refreshed for risk council: ${coinSymbol} price moved ${priceChange.toFixed(2)}%`);
                        }
                        riskCouncilMarketData = {
                            ...championshipMarketData,
                            currentPrice: freshPrice,
                            high24h: parseFloat(freshTicker.high_24h) || championshipMarketData.high24h,
                            low24h: parseFloat(freshTicker.low_24h) || championshipMarketData.low24h,
                            fundingRate: parseFloat(freshFunding.fundingRate || '0'),
                        };
                    }
                } catch (err) {
                    logger.warn(`Failed to refresh market data for risk council:`, err instanceof Error ? err.message : String(err));
                }

                // Get account state for risk assessment (fresh from WEEX)
                const accountBalance = await this.getWalletBalance();
                const currentPositions = this.getAllPositions();
                const recentPnL = await this.getRecentPnL(userId);

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
                    this.completeCycle(cycleStart, 'vetoed by risk council');
                    const sleepTime = this.getSleepTimeWithBackoff(cycleStart);
                    if (sleepTime > 0 && this.isRunning) await this.sleep(sleepTime);
                    continue;
                }

                logger.info('✅ Trade APPROVED by Risk Council');

                // =================================================================
                // STAGE 7: EXECUTION - Place trade on WEEX with TP/SL
                // =================================================================
                logger.info('🚀 Stage 7: Executing Trade...');

                // Build coin selection results for compatibility
                const coinSelectionResults = [{
                    analystId: coinSelectorWinner,
                    picks: [{ symbol: coinSymbol, direction, conviction: 8, reason: coinDebate.reasoning }]
                }];

                // Use the most recent market data for execution
                await this.executeCollaborativeTrade(
                    userId,
                    coinSymbol,
                    riskCouncilMarketData, // Use refreshed market data
                    adjustedChampion,
                    riskDecision,
                    coinSelectionResults
                );

                // =================================================================
                // STAGE 8: POSITION MANAGEMENT - Update leaderboard
                // =================================================================
                await this.updateLeaderboard();

                this.currentCycle.endTime = Date.now();
                const cycleDuration = this.currentCycle.endTime - cycleStart;

                logger.info(`✅ Cycle #${this.cycleCount} complete: ${this.currentCycle.tradesExecuted} trades, ${this.currentCycle.debatesRun} debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                const fourWayTurns = 4 * config.debate.turnsPerAnalyst;
                const champTurns = 8 * config.debate.turnsPerAnalyst;
                const totalTurns = fourWayTurns * 3 + champTurns;
                logger.info(`   📊 Debates: Coin Selection (${fourWayTurns}) + Analysis (${fourWayTurns}) + Risk (${fourWayTurns}) + Championship (${champTurns}) = ${totalTurns} total turns`);
                this.emit('cycleComplete', this.currentCycle);

            } catch (error: any) {
                logger.error('Cycle error:', error);
                this.consecutiveFailures++; // Increment on general cycle errors
                if (this.currentCycle) {
                    this.currentCycle.errors.push(`Cycle error: ${error.message}`);
                    this.currentCycle.endTime = Date.now();
                    this.emit('cycleComplete', this.currentCycle);
                }
            }

            // Sleep until next cycle (dynamic based on market activity)
            const elapsed = Date.now() - cycleStart;
            const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
            const sleepTime = Math.max(0, dynamicInterval - elapsed);

            if (sleepTime > 0 && this.isRunning) {
                const nextPeak = tradingScheduler.getTimeUntilPeakTrading();
                logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle... (Next peak: ${nextPeak.hours}h ${nextPeak.minutes}m)`);
                await this.sleep(sleepTime);
            }
        }

        logger.info('Main loop exited');
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
                const change24h = parseFloat(ticker.priceChangePercent || '0') * 100;
                const parsedFundingRate = parseFloat(fundingRate.fundingRate || '0');

                // Validate all numbers
                if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
                    throw new Error(`Invalid price for ${symbol}: ${currentPrice}`);
                }

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
     * - Invalid userId validation
     * - NaN/Infinity values from database
     * - Division by zero protection
     */
    private async getRecentPnL(userId: string): Promise<{ day: number; week: number }> {
        // Validate userId
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            logger.warn('Invalid userId provided to getRecentPnL');
            return { day: 0, week: 0 };
        }

        try {
            const dayResult = await pool.query(
                `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl, COALESCE(SUM(ABS(size * price)), 1) as total_volume
                 FROM trades 
                 WHERE user_id = $1 AND executed_at > NOW() - INTERVAL '24 hours' AND status = 'FILLED'`,
                [userId]
            );

            const weekResult = await pool.query(
                `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl, COALESCE(SUM(ABS(size * price)), 1) as total_volume
                 FROM trades 
                 WHERE user_id = $1 AND executed_at > NOW() - INTERVAL '7 days' AND status = 'FILLED'`,
                [userId]
            );

            const dayPnL = parseFloat(dayResult.rows[0]?.total_pnl || '0');
            const dayVolume = parseFloat(dayResult.rows[0]?.total_volume || '1');
            const weekPnL = parseFloat(weekResult.rows[0]?.total_pnl || '0');
            const weekVolume = parseFloat(weekResult.rows[0]?.total_volume || '1');

            // Validate all parsed values
            const safeDayPnL = Number.isFinite(dayPnL) ? dayPnL : 0;
            const safeDayVolume = Number.isFinite(dayVolume) && dayVolume > 0 ? dayVolume : 1;
            const safeWeekPnL = Number.isFinite(weekPnL) ? weekPnL : 0;
            const safeWeekVolume = Number.isFinite(weekVolume) && weekVolume > 0 ? weekVolume : 1;

            const dayPercent = (safeDayPnL / safeDayVolume) * 100;
            const weekPercent = (safeWeekPnL / safeWeekVolume) * 100;

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
     * Execute a collaborative trade (Stage 6)
     * Places the trade on WEEX with TP/SL orders
     */
    private async executeCollaborativeTrade(
        userId: string,
        symbol: string,
        marketData: ExtendedMarketData,
        champion: AnalysisResult,
        riskDecision: RiskCouncilDecision,
        coinSelectors: CoinSelectionResult[]
    ): Promise<void> {
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

        const size = positionValue / marketData.currentPrice;

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

        const order = {
            symbol,
            type: orderType as '1' | '2' | '3' | '4',
            size: size.toFixed(8),
            client_oid: clientOrderId,
            order_type: '2' as '0' | '1' | '2' | '3', // FOK
            match_price: '1' as '0' | '1', // Market price
            price: marketData.currentPrice.toFixed(2), // Required but ignored for market orders
            presetTakeProfitPrice: takeProfitPrice.toFixed(2),
            presetStopLossPrice: stopLoss.toFixed(2),
        };

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

            // Build AI log for WEEX compliance
            const aiLog = {
                stage: 'collaborative_trade',
                model: 'gemini-2.5-flash',
                input: {
                    symbol,
                    direction,
                    champion: champion.analystName,
                    confidence: champion.confidence,
                    coinSelectors: coinSelectors.map(cs => cs.analystId)
                },
                output: {
                    orderId: response.order_id,
                    size: size.toFixed(8),
                    leverage,
                    priceTargets: champion.priceTarget
                },
                explanation: `[${champion.analystName}] ${champion.thesis}`,
                orderId: response.order_id
            };

            await this.weexClient.uploadAILog(aiLog);

            await this.saveTrade(userId, firstAnalyst.portfolioId, {
                symbol,
                side: direction,
                size,
                price: marketData.currentPrice,
                orderId: parseInt(String(response.order_id), 10),
                clientOrderId,
                reason: `[${champion.analystName}] ${champion.thesis}`,
                confidence: champion.confidence,
            });

            // Update trade stats (balance will be refreshed from WEEX on next cycle)
            const now = Date.now();
            for (const state of this.analystStates.values()) {
                state.lastTradeTime = now;
                state.totalTrades++;
            }

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
     * Update leaderboard and portfolio values
     * Balance is ALWAYS fetched from WEEX wallet (source of truth)
     */
    private async updateLeaderboard(): Promise<void> {
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
                await pool.query(
                    `UPDATE portfolios SET current_balance = $1, total_value = $2, updated_at = NOW() WHERE id = $3`,
                    [walletBalance, totalValue, firstAnalyst.portfolioId]
                );
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
     */
    private async saveTrade(
        userId: string,
        portfolioId: string,
        trade: { symbol: string; side: 'LONG' | 'SHORT'; size: number; price: number; orderId: number; clientOrderId: string; reason: string; confidence: number; }
    ): Promise<void> {
        // Validate required fields
        if (!userId || typeof userId !== 'string') {
            logger.error('Invalid userId for saveTrade');
            return;
        }
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
            await pool.query(
                `INSERT INTO trades (user_id, portfolio_id, symbol, side, type, size, price, status, reason, confidence, client_order_id, weex_order_id, executed_at, created_at)
                 VALUES ($1, $2, $3, $4, 'MARKET', $5, $6, 'FILLED', $7, $8, $9, $10, NOW(), NOW())`,
                [userId, portfolioId, trade.symbol, trade.side, trade.size, trade.price, trade.reason, trade.confidence, trade.clientOrderId, trade.orderId]
            );
        } catch (error) {
            logger.error('Failed to save trade to database:', error);
            // Don't throw - trade was already executed on WEEX, just log the DB failure
        }
    }

    /**
     * Emergency close all positions
     * FIXED: Collect positions to close first, then iterate to avoid modifying while iterating
     */
    private async emergencyCloseAllPositions(userId: string): Promise<void> {
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

        this.emit('emergencyClose', { userId, timestamp: Date.now() });
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
        this.stop();
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
                }
            }
        }

        // Clear state to prevent stale data on restart
        this.analystStates.clear();
        this.currentCycle = null;
        this.cycleCount = 0;
        this.consecutiveFailures = 0;
        this.mainLoopPromise = null;

        this.removeAllListeners();
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

