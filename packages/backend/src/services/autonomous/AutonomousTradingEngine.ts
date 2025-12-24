/**
 * Autonomous Trading Engine
 * 
 * Keeps 8 AI analysts alive, trading, and debating 24/7.
 * Each analyst manages their own portfolio autonomously.
 * 
 * Core Loop:
 * 1. Fetch market data for all approved symbols
 * 2. Each AI analyst analyzes and decides
 * 3. Execute trades on WEEX
 * 4. Run debates between top performers
 * 5. Update portfolios and leaderboard
 * 6. Sleep and repeat
 */

import { EventEmitter } from 'events';
import { geminiService, type ExtendedMarketData } from '../ai/GeminiService';
import { getWeexClient } from '../weex/WeexClient';
import { tradingScheduler } from './TradingScheduler';
import { circuitBreakerService } from '../risk/CircuitBreakerService';
import { pool } from '../../config/database';
import { config } from '../../config';
import { logger } from '../../utils/logger';

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
    private tradingLocks = new Set<string>(); // Prevent concurrent trades per analyst

    // Configuration from environment
    private readonly CYCLE_INTERVAL_MS = config.autonomous.cycleIntervalMs;
    private readonly INITIAL_BALANCE = config.autonomous.aiAnalystBudget;
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
            initialBalance: this.INITIAL_BALANCE,
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
            logger.info('🏟️ Starting Autonomous Trading Engine...');

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

        // Clear trading locks
        this.tradingLocks.clear();

        this.emit('stopped');
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            analysts: Array.from(this.analystStates.values()),
            currentCycle: this.currentCycle,
        };
    }

    /**
     * Initialize all 8 analyst portfolios
     */
    private async initializeAnalysts(userId: string): Promise<void> {
        logger.info('Initializing 8 AI analysts...');

        const initPromises = ANALYST_IDS.map(async (analystId) => {
            try {
                // Check if portfolio exists
                const existing = await pool.query(
                    `SELECT id, current_balance, total_trades, win_rate 
                     FROM portfolios 
                     WHERE user_id = $1 AND agent_id = $2`,
                    [userId, analystId]
                );

                let portfolioId: string;
                let balance: number;
                let totalTrades: number;
                let winRate: number;

                if (existing.rows.length > 0) {
                    // Use existing portfolio
                    const row = existing.rows[0];
                    portfolioId = row.id;
                    balance = parseFloat(row.current_balance);
                    totalTrades = parseInt(row.total_trades || '0', 10);
                    winRate = parseFloat(row.win_rate || '0');

                    // Validate balance
                    if (!Number.isFinite(balance) || balance < 0) {
                        logger.warn(`${analystId}: Invalid balance ${balance}, resetting to ${this.INITIAL_BALANCE}`);
                        balance = this.INITIAL_BALANCE;
                    }

                    logger.info(`✓ ${analystId}: Existing portfolio ($${balance.toFixed(2)} USDT)`);
                } else {
                    // Create new portfolio
                    const profile = geminiService.getAnalysts().find(a => a.id === analystId);
                    if (!profile) {
                        logger.error(`Unknown analyst: ${analystId}`);
                        return;
                    }

                    const result = await pool.query(
                        `INSERT INTO portfolios (
                            user_id, agent_id, agent_name, initial_balance, current_balance, status
                        ) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
                        [userId, analystId, profile.name, this.INITIAL_BALANCE, this.INITIAL_BALANCE]
                    );

                    portfolioId = result.rows[0].id;
                    balance = this.INITIAL_BALANCE;
                    totalTrades = 0;
                    winRate = 0;
                    logger.info(`✓ ${analystId}: New portfolio created ($${balance.toFixed(2)} USDT)`);
                }

                // Get current positions from WEEX (with retry)
                let positions: AnalystState['positions'] = [];
                for (let retry = 0; retry < this.MAX_RETRIES; retry++) {
                    try {
                        positions = await this.getAnalystPositions();
                        break;
                    } catch (error) {
                        if (retry === this.MAX_RETRIES - 1) {
                            logger.warn(`${analystId}: Failed to fetch positions after ${this.MAX_RETRIES} retries`);
                        } else {
                            await this.sleep(1000 * (retry + 1)); // Exponential backoff
                        }
                    }
                }

                this.analystStates.set(analystId, {
                    analystId,
                    portfolioId,
                    balance,
                    positions,
                    lastTradeTime: 0,
                    totalTrades,
                    winRate,
                });
            } catch (error) {
                logger.error(`Failed to initialize ${analystId}:`, error);
            }
        });

        await Promise.allSettled(initPromises);

        logger.info(`✅ Initialized ${this.analystStates.size}/8 analysts`);
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
                // 1. Fetch market data for all symbols
                const marketDataMap = await this.fetchAllMarketData();

                // 2. CHECK CIRCUIT BREAKERS (NEW)
                const btcData = marketDataMap.get('cmt_btcusdt');
                if (btcData) {
                    const circuitBreakerStatus = await circuitBreakerService.checkCircuitBreakers(userId);

                    if (circuitBreakerStatus.level === 'RED') {
                        logger.error(`🚨 RED ALERT: ${circuitBreakerStatus.reason}`);
                        logger.error(`Action: ${circuitBreakerService.getRecommendedAction('RED')}`);
                        await this.emergencyCloseAllPositions(userId);
                        this.currentCycle.errors.push(`RED ALERT: ${circuitBreakerStatus.reason} - All positions closed`);

                        // RED ALERT: Stop trading and wait for next cycle
                        // This ensures we don't bypass the sleep interval
                        logger.error('🚨 RED ALERT: Skipping trading for this cycle, will check again next cycle');

                        // Mark cycle as complete
                        this.currentCycle.endTime = Date.now();
                        const cycleDuration = this.currentCycle.endTime - cycleStart;
                        logger.info(`✅ Cycle #${this.cycleCount} complete (RED ALERT): 0 trades, 0 debates (${(cycleDuration / 1000).toFixed(1)}s)`);
                        this.emit('cycleComplete', this.currentCycle);

                        // Sleep until next cycle
                        const elapsed = Date.now() - cycleStart;
                        const dynamicInterval = tradingScheduler.getDynamicCycleInterval(this.CYCLE_INTERVAL_MS);
                        const sleepTime = Math.max(0, dynamicInterval - elapsed);

                        if (sleepTime > 0 && this.isRunning) {
                            logger.info(`💤 Sleeping for ${(sleepTime / 1000).toFixed(0)}s until next cycle...`);
                            await this.sleep(sleepTime);
                        }

                        // Skip to next iteration
                        continue;
                    }

                    if (circuitBreakerStatus.level === 'ORANGE') {
                        logger.warn(`⚠️ ORANGE ALERT: ${circuitBreakerStatus.reason}`);
                        logger.warn(`Action: ${circuitBreakerService.getRecommendedAction('ORANGE')}`);
                        // Continue but analysts will see reduced leverage limits (handled in GeminiService)
                    }

                    if (circuitBreakerStatus.level === 'YELLOW') {
                        logger.warn(`⚠️ YELLOW ALERT: ${circuitBreakerStatus.reason}`);
                        logger.warn(`Action: ${circuitBreakerService.getRecommendedAction('YELLOW')}`);
                        // Continue but analysts will see reduced leverage limits (handled in GeminiService)
                    }
                }

                // 3. Each analyst analyzes and potentially trades
                for (const [analystId, state] of this.analystStates) {
                    try {
                        await this.runAnalystCycle(userId, analystId, state, marketDataMap);
                    } catch (error: any) {
                        logger.error(`Analyst ${analystId} cycle failed:`, error);
                        this.currentCycle.errors.push(`${analystId}: ${error.message}`);
                    }
                }

                // 4. Run debates every N cycles
                if (this.cycleCount % this.DEBATE_FREQUENCY === 0) {
                    await this.runDebates(userId, marketDataMap);
                }

                // 5. Update leaderboard
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

    /**
     * Run one analyst's trading cycle
     */
    private async runAnalystCycle(
        userId: string,
        analystId: string,
        state: AnalystState,
        marketDataMap: Map<string, ExtendedMarketData>
    ): Promise<void> {
        // Check if analyst is already trading (prevent concurrent trades)
        if (this.tradingLocks.has(analystId)) {
            logger.debug(`${analystId}: Already trading, skipping`);
            return;
        }

        // Check if analyst can trade (cooldown)
        const timeSinceLastTrade = Date.now() - state.lastTradeTime;
        if (timeSinceLastTrade < this.MIN_TRADE_INTERVAL_MS) {
            logger.debug(`${analystId}: Cooldown (${((this.MIN_TRADE_INTERVAL_MS - timeSinceLastTrade) / 1000).toFixed(0)}s remaining)`);
            return;
        }

        // Check if balance is sufficient
        if (state.balance < this.MIN_BALANCE_TO_TRADE) {
            logger.warn(`${analystId}: Insufficient balance ($${state.balance.toFixed(2)}), skipping`);
            return;
        }

        // Pick a random symbol to analyze
        const symbols = Array.from(marketDataMap.keys());
        if (symbols.length === 0) {
            logger.warn(`${analystId}: No market data available`);
            return;
        }

        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        const marketData = marketDataMap.get(symbol);
        if (!marketData) return;

        logger.info(`🤖 ${analystId}: Analyzing ${symbol} with full arena context...`);

        // Lock this analyst for trading
        this.tradingLocks.add(analystId);

        try {
            // Check if already has position in this symbol
            const existingPosition = state.positions.find(p => p.symbol === symbol);

            // Generate trading decision with arena context
            // This now builds full context including leaderboard, other analysts, etc.
            const decision = await geminiService.generateTradingDecision(
                marketData,
                state.balance,
                existingPosition,
                userId,
                analystId // Pass analyst ID for context building
            );

            logger.info(`${analystId}: ${decision.shouldTrade ? '✅ TRADE' : '⏸️ HOLD'} (confidence: ${decision.analysis.confidence}%, champion: ${decision.analysis.champion?.analystName || 'none'})`);

            // Execute trade if recommended
            if (decision.shouldTrade && decision.order) {
                // Calculate actual position size accounting for leverage
                const positionSizePercent = decision.riskManagement.positionSizePercent;
                const leverage = decision.riskManagement.leverage;

                // Position value is the notional value (size * price)
                const positionValue = state.balance * (positionSizePercent / 100);

                // Margin required is position value / leverage
                const marginRequired = positionValue / leverage;

                // Calculate margin already used by existing positions
                // IMPROVED: Now uses actual leverage from WEEX when available
                // Fallback to ASSUMED_AVERAGE_LEVERAGE only when leverage is not provided
                const existingMarginUsed = state.positions.reduce((sum, p) => {
                    // Estimate margin used: (position size * entry price) / leverage
                    const positionNotional = p.size * p.entryPrice;

                    // Use actual leverage from WEEX if available, otherwise fallback to assumption
                    const effectiveLeverage = p.leverage && p.leverage > 0
                        ? p.leverage
                        : ASSUMED_AVERAGE_LEVERAGE;

                    const marginUsed = positionNotional / effectiveLeverage;

                    // Log when using assumed leverage for monitoring
                    if (!p.leverage || p.leverage <= 0) {
                        logger.debug(`${analystId}: Using assumed ${ASSUMED_AVERAGE_LEVERAGE}x leverage for ${p.symbol} (actual leverage unavailable)`);
                    }

                    return sum + marginUsed;
                }, 0);

                // Available balance for new positions = total balance - existing margin
                const availableBalance = Math.max(0, state.balance - existingMarginUsed);

                // Log margin usage for monitoring
                if (existingMarginUsed > 0) {
                    const marginUtilization = (existingMarginUsed / state.balance) * 100;
                    logger.debug(`${analystId}: Margin utilization: ${marginUtilization.toFixed(1)}% (${existingMarginUsed.toFixed(2)} / ${state.balance.toFixed(2)})`);
                }

                // Ensure we have enough available balance for margin
                if (marginRequired > availableBalance * 0.95) {
                    logger.warn(`${analystId}: Insufficient available margin for ${symbol} (need ${marginRequired.toFixed(2)}, available ${availableBalance.toFixed(2)}, ${existingMarginUsed.toFixed(2)} already used)`);

                    // Track margin rejection for monitoring
                    this.emit('marginRejection', {
                        analystId,
                        symbol,
                        marginRequired,
                        availableBalance,
                        existingMarginUsed,
                        totalBalance: state.balance,
                        reason: 'insufficient_available_margin'
                    });

                    return;
                }

                // Calculate size
                const size = positionValue / marketData.currentPrice;

                // Validate size
                if (!Number.isFinite(size) || size <= 0) {
                    throw new Error(`Invalid position size: ${size}`);
                }

                // Update order with calculated size
                decision.order.size = size.toFixed(8);

                if (this.DRY_RUN) {
                    // Dry run mode - log but don't execute
                    logger.info(`🧪 ${analystId}: DRY RUN - Would execute ${decision.order.type === '1' ? 'LONG' : 'SHORT'} on ${symbol}, size: ${decision.order.size}`);
                } else {
                    // Place order on WEEX
                    const response = await this.weexClient.placeOrder(decision.order);

                    // Upload AI log for compliance
                    await this.weexClient.uploadAILog({
                        ...decision.aiLog,
                        orderId: response.order_id,
                    });

                    // Save trade to database
                    await this.saveTrade(userId, state.portfolioId, {
                        symbol,
                        side: decision.order.type === '1' || decision.order.type === '3' ? 'LONG' : 'SHORT',
                        size: parseFloat(decision.order.size),
                        price: marketData.currentPrice,
                        orderId: parseInt(String(response.order_id), 10),
                        clientOrderId: decision.order.client_oid,
                        reason: decision.analysis.champion?.thesis || 'Autonomous decision',
                        confidence: decision.analysis.confidence,
                    });

                    logger.info(`✅ ${analystId}: Trade executed on ${symbol} (Order ID: ${response.order_id})`);
                }

                // Update state
                state.lastTradeTime = Date.now();
                state.totalTrades++;

                // Update balance
                // NOTE: Balance management is simplified here. In production:
                // 1. Fetch actual account balance from WEEX after trade
                // 2. Track margin used vs available
                // 3. Handle partial fills
                // 4. Account for fees
                // 
                // For now, we estimate based on position value
                const isClosing = decision.order.type === '3' || decision.order.type === '4';
                if (!isClosing) {
                    // Opening position - deduct margin (position value / leverage)
                    state.balance = Math.max(0, state.balance - marginRequired);
                }
                // For closing positions, P&L will be reflected in next balance update

                if (this.currentCycle) {
                    this.currentCycle.tradesExecuted++;
                }

                this.emit('tradeExecuted', { analystId, symbol, order: decision.order, dryRun: this.DRY_RUN });
            }
        } catch (error) {
            logger.error(`${analystId}: Trade execution failed:`, error);
            this.currentCycle?.errors.push(`${analystId} trade failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // Always unlock
            this.tradingLocks.delete(analystId);
        }
    }

    /**
     * Run debates between top analysts
     */
    private async runDebates(
        userId: string,
        marketDataMap: Map<string, ExtendedMarketData>
    ): Promise<void> {
        logger.info('⚔️ Running debates...');

        // Pick a random symbol for debate
        const symbols = Array.from(marketDataMap.keys());
        if (symbols.length === 0) {
            logger.warn('No market data available for debates');
            return;
        }

        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        const marketData = marketDataMap.get(symbol);
        if (!marketData) return;

        try {
            // Generate analyses from all analysts
            const analyses = await geminiService.generateAllAnalyses({
                symbol,
                currentPrice: marketData.currentPrice,
                high24h: marketData.high24h,
                low24h: marketData.low24h,
                volume24h: marketData.volume24h,
                change24h: marketData.change24h,
            }, userId);

            if (analyses.length < 2) {
                logger.warn('Not enough analyses for debates');
                return;
            }

            // Run tournament
            const tournament = await geminiService.runTournament(
                analyses,
                {
                    price: marketData.currentPrice,
                    change24h: marketData.change24h,
                    volume24h: marketData.volume24h,
                },
                symbol,
                userId
            );

            const debatesRun = tournament.quarterfinals.length + tournament.semifinals.length + (tournament.final ? 1 : 0);
            if (this.currentCycle) {
                this.currentCycle.debatesRun = debatesRun;
            }

            logger.info(`⚔️ Debates complete: ${debatesRun} battles, Champion: ${tournament.champion?.analystName || 'None'}`);
            this.emit('debatesComplete', { symbol, tournament });

        } catch (error) {
            logger.error('Debates failed:', error);
            this.currentCycle?.errors.push(`Debates failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Update leaderboard and portfolio values
     */
    private async updateLeaderboard(): Promise<void> {
        const updatePromises = Array.from(this.analystStates.entries()).map(async ([analystId, state]) => {
            try {
                // Get current positions from WEEX
                const positions = await this.getAnalystPositions();
                state.positions = positions;

                // Calculate unrealized P&L from positions
                // Fetch current market prices for all positions
                const unrealizedPnL = await Promise.all(
                    positions.map(async (p) => {
                        try {
                            // Fetch current market price
                            const ticker = await this.weexClient.getTicker(p.symbol);
                            const currentPrice = parseFloat(ticker.last);

                            if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
                                logger.warn(`${analystId}: Invalid current price for ${p.symbol}: ${currentPrice}`);
                                return 0;
                            }

                            // Calculate P&L based on position side
                            // For LONG: (currentPrice - entryPrice) * size
                            // For SHORT: (entryPrice - currentPrice) * size
                            const pnl = p.side === 'LONG'
                                ? (currentPrice - p.entryPrice) * p.size
                                : (p.entryPrice - currentPrice) * p.size;

                            // Validate P&L
                            if (!Number.isFinite(pnl)) {
                                logger.warn(`${analystId}: Invalid P&L for ${p.symbol}: ${pnl}`);
                                return 0;
                            }

                            return pnl;
                        } catch (error) {
                            logger.warn(`${analystId}: Failed to calculate P&L for ${p.symbol}:`, error instanceof Error ? error.message : String(error));
                            return 0;
                        }
                    })
                ).then(pnls => pnls.reduce((sum, pnl) => sum + pnl, 0));

                const totalValue = state.balance + unrealizedPnL;
                const totalReturn = this.INITIAL_BALANCE > 0
                    ? ((totalValue - this.INITIAL_BALANCE) / this.INITIAL_BALANCE) * 100
                    : 0;

                // Validate values
                if (!Number.isFinite(totalValue) || !Number.isFinite(totalReturn)) {
                    logger.warn(`${analystId}: Invalid portfolio values, skipping update`);
                    return;
                }

                // Update database
                await pool.query(
                    `UPDATE portfolios 
                     SET total_value = $1, total_return = $2, updated_at = NOW()
                     WHERE id = $3`,
                    [totalValue, totalReturn, state.portfolioId]
                );

            } catch (error) {
                logger.warn(`Failed to update ${analystId} portfolio:`, error instanceof Error ? error.message : String(error));
            }
        });

        await Promise.allSettled(updatePromises);
    }

    /**
     * Get analyst's current positions from WEEX
     * 
     * NOTE: In the current implementation, all analysts share the same WEEX account
     * and therefore see the same positions. This is a limitation of using a single
     * API key for all analysts.
     * 
     * In production, you would either:
     * 1. Use separate WEEX sub-accounts for each analyst
     * 2. Track positions in the database and filter by portfolio_id
     * 3. Use position metadata (client_oid) to identify which analyst owns which position
     * 
     * For the hackathon/demo, we return all positions for simplicity.
     */
    private async getAnalystPositions(): Promise<AnalystState['positions']> {
        try {
            const weexPositions = await this.weexClient.getPositions();
            // Filter positions for this portfolio (would need portfolio-specific API keys in production)
            return weexPositions.map(p => {
                // Calculate entry price from openValue and size
                const openValue = parseFloat(p.openValue);
                const size = parseFloat(p.size);
                const markPrice = parseFloat(p.markPrice);
                const leverage = parseFloat(p.leverage); // WEEX provides actual leverage!

                // Validate values
                if (!Number.isFinite(openValue) || !Number.isFinite(size) || !Number.isFinite(markPrice)) {
                    logger.warn(`Invalid position data for ${p.symbol}`);
                    return null;
                }

                const entryPrice = size > 0 ? openValue / size : markPrice;

                return {
                    symbol: p.symbol,
                    side: p.side === 'long' ? 'LONG' as const : 'SHORT' as const,
                    size,
                    entryPrice: Number.isFinite(entryPrice) ? entryPrice : markPrice,
                    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : ASSUMED_AVERAGE_LEVERAGE, // Use actual leverage from WEEX
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
        trade: {
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            price: number;
            orderId: number;
            clientOrderId: string;
            reason: string;
            confidence: number;
        }
    ): Promise<void> {
        try {
            await pool.query(
                `INSERT INTO trades (
                    user_id, portfolio_id, symbol, side, type, size, price,
                    status, reason, confidence, client_order_id, weex_order_id,
                    executed_at, created_at
                ) VALUES ($1, $2, $3, $4, 'MARKET', $5, $6, 'FILLED', $7, $8, $9, $10, NOW(), NOW())`,
                [
                    userId,
                    portfolioId,
                    trade.symbol,
                    trade.side,
                    trade.size,
                    trade.price,
                    trade.reason,
                    trade.confidence,
                    trade.clientOrderId,
                    trade.orderId,
                ]
            );
        } catch (error) {
            logger.error('Failed to save trade to database:', error);
            throw error;
        }
    }

    /**
     * Emergency close all positions (RED ALERT)
     * FIXED: Added proper error handling, retry logic, and database persistence
     */
    private async emergencyCloseAllPositions(userId: string): Promise<void> {
        logger.error('🚨 EMERGENCY: Closing all leveraged positions');

        const closedPositions: Array<{ analystId: string; symbol: string; success: boolean }> = [];

        for (const [analystId, state] of this.analystStates) {
            if (state.positions.length > 0) {
                for (const position of state.positions) {
                    let success = false;
                    let lastError: Error | null = null;

                    // Retry up to 3 times
                    for (let retry = 0; retry < 3; retry++) {
                        try {
                            await this.weexClient.closeAllPositions(position.symbol);
                            logger.info(`✅ Closed ${position.symbol} position for ${analystId} (attempt ${retry + 1})`);
                            success = true;
                            break;
                        } catch (error) {
                            lastError = error instanceof Error ? error : new Error(String(error));
                            logger.warn(`Failed to close ${position.symbol} for ${analystId} (attempt ${retry + 1}):`, lastError.message);

                            // Wait before retry (exponential backoff)
                            if (retry < 2) {
                                await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
                            }
                        }
                    }

                    if (success) {
                        // Clear position from state
                        state.positions = state.positions.filter(p => p.symbol !== position.symbol);

                        // Update database to reflect closed position
                        try {
                            await pool.query(
                                `INSERT INTO trades (
                                    user_id, portfolio_id, symbol, side, type, size, price,
                                    status, reason, confidence, client_order_id, executed_at, created_at
                                ) VALUES ($1, $2, $3, $4, 'MARKET', $5, $6, 'FILLED', $7, 100, $8, NOW(), NOW())`,
                                [
                                    userId,
                                    state.portfolioId,
                                    position.symbol,
                                    position.side === 'LONG' ? 'SHORT' : 'LONG', // Opposite side to close
                                    position.size,
                                    0, // Price will be filled by WEEX
                                    'EMERGENCY CLOSE - Circuit Breaker RED ALERT',
                                    `emergency_close_${Date.now()}`
                                ]
                            );
                        } catch (dbError) {
                            logger.error(`Failed to save emergency close to database for ${position.symbol}:`, dbError);
                        }
                    } else {
                        logger.error(`❌ FAILED to close ${position.symbol} for ${analystId} after 3 attempts: ${lastError?.message}`);
                    }

                    closedPositions.push({ analystId, symbol: position.symbol, success });
                }
            }
        }

        // Log summary
        const successCount = closedPositions.filter(p => p.success).length;
        const failCount = closedPositions.filter(p => !p.success).length;
        logger.error(`🚨 Emergency close complete: ${successCount} positions closed, ${failCount} failed`);

        // Emit event with details
        this.emit('emergencyClose', {
            userId,
            timestamp: Date.now(),
            closedPositions,
            successCount,
            failCount
        });
    }

    /**
     * Sleep utility with cancellation support
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.sleepTimeout = setTimeout(() => {
                this.sleepTimeout = null;
                resolve();
            }, ms);
        });
    }

    /**
     * Cleanup method for graceful shutdown
     */
    async cleanup(): Promise<void> {
        this.stop();

        // Wait for main loop to finish
        if (this.mainLoopPromise) {
            try {
                await Promise.race([
                    this.mainLoopPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup timeout')), 5000))
                ]);
            } catch (error) {
                logger.warn('Main loop cleanup timeout');
            }
        }

        // Remove all listeners to prevent memory leaks
        this.removeAllListeners();

        logger.info('Autonomous engine cleanup complete');
    }
}

// Singleton instance
let engineInstance: AutonomousTradingEngine | null = null;

export function getAutonomousTradingEngine(): AutonomousTradingEngine {
    if (!engineInstance) {
        engineInstance = new AutonomousTradingEngine();
    }
    return engineInstance;
}
