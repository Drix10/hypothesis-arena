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
import { ANALYST_PROFILES } from '../../constants/analystPrompts';

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

        // Clear any pending sleep timeout
        if (this.sleepTimeout) {
            clearTimeout(this.sleepTimeout);
            this.sleepTimeout = null;
        }

        this.emit('stopped');
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
     */
    private async initializeAnalysts(userId: string): Promise<void> {
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
                        logger.warn(`Collaborative portfolio: Failed to fetch positions after ${this.MAX_RETRIES} retries`);
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
                // STAGE 2: COIN SELECTION - Ray, Jim, Quant pick best opportunity
                // =================================================================
                logger.info('🎯 Stage 2: Coin Selection Debate...');
                const { results: coinSelectionResults, topCoin } = await collaborativeFlowService.runCoinSelection(marketDataMap);

                if (!topCoin || topCoin.totalScore === 0) {
                    logger.warn('No coin selected, skipping cycle');
                    this.currentCycle.errors.push('Coin selection failed - no consensus');
                    await this.updateLeaderboard();
                    continue;
                }

                logger.info(`🏆 Top Coin: ${topCoin.symbol} (${topCoin.direction}) - Score: ${topCoin.totalScore}`);
                this.emit('coinSelected', { topCoin, selectors: coinSelectionResults });

                const selectedMarketData = marketDataMap.get(topCoin.symbol);
                if (!selectedMarketData) {
                    logger.error(`Market data not found for selected coin: ${topCoin.symbol}`);
                    this.currentCycle.errors.push(`Market data missing for ${topCoin.symbol}`);
                    continue;
                }

                // =================================================================
                // STAGE 3: SPECIALIST ANALYSIS - Deep dive by assigned specialists
                // =================================================================
                logger.info(`🔬 Stage 3: Specialist Analysis for ${topCoin.symbol}...`);
                const specialists = await collaborativeFlowService.runSpecialistAnalysis(
                    topCoin.symbol,
                    selectedMarketData,
                    topCoin.direction
                );

                if (specialists.length < 2) {
                    logger.warn('Not enough specialist analyses, skipping cycle');
                    this.currentCycle.errors.push('Specialist analysis failed - insufficient responses');
                    await this.updateLeaderboard();
                    continue;
                }

                logger.info(`📊 ${specialists.length} specialists analyzed ${topCoin.symbol}`);
                this.emit('specialistAnalysis', { symbol: topCoin.symbol, specialists });

                // =================================================================
                // STAGE 4: TOURNAMENT - Bracket-style debates determine winner
                // =================================================================
                logger.info('⚔️ Stage 4: Championship Tournament...');
                const { matches, champion } = await collaborativeFlowService.runTournament(specialists, selectedMarketData);

                this.currentCycle.debatesRun = matches.length;

                if (!champion) {
                    logger.warn('No tournament champion, skipping trade');
                    this.currentCycle.errors.push('Tournament failed - no champion');
                    await this.updateLeaderboard();
                    continue;
                }

                logger.info(`🏆 Champion: ${champion.analystName} (${champion.confidence}% confidence)`);
                this.emit('tournamentComplete', { matches, champion });

                // Check minimum confidence threshold
                if (champion.confidence < this.MIN_CONFIDENCE_TO_TRADE) {
                    logger.info(`Champion confidence ${champion.confidence}% below threshold ${this.MIN_CONFIDENCE_TO_TRADE}%, skipping trade`);
                    await this.updateLeaderboard();
                    continue;
                }

                // =================================================================
                // STAGE 5: RISK COUNCIL - Karen approves/vetoes/adjusts
                // =================================================================
                logger.info('🛡️ Stage 5: Risk Council Review...');

                // Get account state for risk assessment (fresh from WEEX)
                const accountBalance = await this.getWalletBalance();
                const currentPositions = this.getAllPositions();
                const recentPnL = await this.getRecentPnL(userId);

                const riskDecision = await collaborativeFlowService.runRiskCouncil(
                    champion,
                    selectedMarketData,
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
                    continue;
                }

                logger.info('✅ Trade APPROVED by Risk Council');

                // =================================================================
                // STAGE 6: EXECUTION - Place trade on WEEX with TP/SL
                // =================================================================
                logger.info('🚀 Stage 6: Executing Trade...');

                await this.executeCollaborativeTrade(
                    userId,
                    topCoin.symbol,
                    selectedMarketData,
                    champion,
                    riskDecision,
                    coinSelectionResults
                );

                // =================================================================
                // STAGE 7: POSITION MANAGEMENT - Update leaderboard
                // =================================================================
                await this.updateLeaderboard();

                this.currentCycle.endTime = Date.now();
                const cycleDuration = this.currentCycle.endTime - cycleStart;

                logger.info(`✅ Cycle #${this.cycleCount} complete: ${this.currentCycle.tradesExecuted} trades, ${this.currentCycle.debatesRun} debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                this.emit('cycleComplete', this.currentCycle);

            } catch (error: any) {
                logger.error('Cycle error:', error);
                this.currentCycle?.errors.push(`Cycle error: ${error.message}`);
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
     */
    private getAllPositions(): Array<{ symbol: string; side: string; size: number }> {
        const firstAnalyst = this.analystStates.values().next().value;
        if (!firstAnalyst) return [];

        return firstAnalyst.positions.map(pos => ({
            symbol: pos.symbol,
            side: pos.side,
            size: pos.size
        }));
    }

    /**
     * Get recent P&L for risk assessment
     * Uses realized_pnl column from trades table
     */
    private async getRecentPnL(userId: string): Promise<{ day: number; week: number }> {
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

            return {
                day: dayVolume > 0 ? (dayPnL / dayVolume) * 100 : 0,
                week: weekVolume > 0 ? (weekPnL / weekVolume) * 100 : 0
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
            presetTakeProfitPrice: champion.priceTarget.base.toFixed(2),
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
     */
    private async getAnalystPositions(): Promise<AnalystState['positions']> {
        try {
            const weexPositions = await this.weexClient.getPositions();
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

                return {
                    symbol: p.symbol,
                    side: p.side, // Already normalized to 'LONG' | 'SHORT' by normalizeWeexPosition
                    size,
                    entryPrice,
                    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : ASSUMED_AVERAGE_LEVERAGE,
                };
            }).filter((p): p is NonNullable<typeof p> => p !== null);
        } catch (error) {
            logger.warn('Failed to fetch positions:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }

    /**
     * Save trade to database
     */
    private async saveTrade(
        userId: string,
        portfolioId: string,
        trade: { symbol: string; side: 'LONG' | 'SHORT'; size: number; price: number; orderId: number; clientOrderId: string; reason: string; confidence: number; }
    ): Promise<void> {
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
        this.mainLoopPromise = null;

        this.removeAllListeners();
    }
}

let engineInstance: AutonomousTradingEngine | null = null;
export function getAutonomousTradingEngine(): AutonomousTradingEngine {
    if (!engineInstance) engineInstance = new AutonomousTradingEngine();
    return engineInstance;
}

