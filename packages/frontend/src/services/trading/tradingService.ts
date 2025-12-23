/**
 * Trading Service
 * 
 * Main orchestrator for the trading system. Handles trade execution,
 * portfolio management, and coordinates all trading-related operations.
 */

import {
    AgentPortfolio,
    Trade,
    TradeDecision,
    Position,
    TradingError,
    TradingErrorCode,
    TradingSystemState,
    RiskManagementRules
} from '../../types/trading';
import { InvestmentThesis, StockDebate } from '../../types/stock';
import { marketHoursService } from './marketHoursService';
import { priceValidationService } from './priceValidationService';
import { positionSizingService } from './positionSizingService';
import { performanceCalculator } from './performanceCalculator';
import { tradingSystemLock } from './tradingSystemLock';
import { getAllAnalysts } from '../../constants/analystPrompts';

export class TradingService {
    private readonly INITIAL_CASH = 100000;
    private readonly STORAGE_KEY = 'hypothesis_arena_trading';

    // Limits to prevent localStorage bloat
    private readonly MAX_TRADES_PER_PORTFOLIO = 1000;
    private readonly MAX_PERFORMANCE_SNAPSHOTS = 365;
    private readonly MAX_ERROR_LOG = 100;
    private readonly MAX_CORPORATE_ACTIONS = 50;

    initializeTradingSystem(): TradingSystemState {
        const analysts = getAllAnalysts();
        const portfolios: Record<string, AgentPortfolio> = {};

        analysts.forEach(analyst => {
            portfolios[analyst.id] = this.createInitialPortfolio(analyst.id, analyst.name, analyst.methodology);
        });

        const state: TradingSystemState = {
            version: 1,
            isEnabled: true,
            portfolios,
            positionSizingRules: {
                maxPositionPercent: 0.2,
                maxTotalInvested: 0.8,
                minTradeValue: 100,
                maxPositionsPerAgent: 10,
                reserveCashPercent: 0.05,
                maxSectorExposure: 0.4
            },
            riskManagementRules: {
                stopLossPercent: 0.15,
                takeProfitPercent: 0.25,
                maxDrawdownBeforePause: 0.3,
                maxDrawdownBeforeLiquidate: 0.8,
                enableStopLoss: false,
                enableTakeProfit: false
            },
            leaderboard: [],
            startDate: Date.now(),
            lastUpdated: Date.now(),
            lastBackup: Date.now(),
            dataIntegrityHash: '',
            totalTrades: 0,
            totalVolume: 0,
            mostTradedStocks: {},
            systemErrors: 0
        };

        // Fire-and-forget save (intentionally not awaited to avoid blocking initialization)
        void this.saveTradingState(state);
        return state;
    }

    private createInitialPortfolio(agentId: string, agentName: string, methodology: any): AgentPortfolio {
        return {
            agentId,
            agentName,
            methodology,
            initialCash: this.INITIAL_CASH,
            currentCash: this.INITIAL_CASH,
            reservedCash: 0,
            totalValue: this.INITIAL_CASH,
            totalReturn: 0,
            totalReturnDollar: 0,
            winRate: 0,
            sharpeRatio: null,
            maxDrawdown: 0,
            currentDrawdown: 0,
            peakValue: this.INITIAL_CASH,
            volatility: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            largestWin: 0,
            largestLoss: 0,
            profitFactor: 0,
            positions: [],
            pendingOrders: [],
            trades: [],
            corporateActions: [],
            errorLog: [],
            performanceHistory: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'active',
            lastTradeAt: null
        };
    }

    async determineTradeDecision(
        thesis: InvestmentThesis,
        debate: StockDebate,
        portfolio: AgentPortfolio,
        currentPrice: number,
        priceTimestamp: number
    ): Promise<TradeDecision> {
        const warnings: string[] = [];
        const reasoning: string[] = [];
        const validationErrors: string[] = [];

        // Check portfolio status
        if (portfolio.status !== 'active') {
            return {
                action: 'HOLD',
                ticker: thesis.ticker,
                shares: 0,
                estimatedPrice: currentPrice,
                estimatedValue: 0,
                confidence: 0,
                reasoning: [`Portfolio is ${portfolio.status}`],
                warnings,
                thesisId: thesis.agentId,
                debateId: debate.matchId,
                recommendation: thesis.recommendation,
                isValid: false,
                validationErrors: [`Portfolio status: ${portfolio.status}`]
            };
        }

        // Validate market hours
        const marketStatus = marketHoursService.getMarketStatus();
        if (!marketStatus.isOpen) {
            warnings.push(marketHoursService.getMarketStatusMessage(marketStatus));
        }

        // Validate price
        const existingPosition = portfolio.positions.find(p => p.ticker === thesis.ticker);
        const priceValidation = priceValidationService.validatePrice(
            thesis.ticker,
            currentPrice,
            priceTimestamp,
            existingPosition?.currentPrice
        );

        if (!priceValidationService.isPriceValid(priceValidation)) {
            validationErrors.push(priceValidation.warning || 'Invalid price');
        }

        const priceWarning = priceValidationService.getPriceWarning(priceValidation);
        if (priceWarning) {
            warnings.push(priceWarning);
        }

        // Determine if agent won debate
        const wonDebate = (
            (debate.winner === 'bull' && (thesis.recommendation === 'strong_buy' || thesis.recommendation === 'buy')) ||
            (debate.winner === 'bear' && (thesis.recommendation === 'sell' || thesis.recommendation === 'strong_sell'))
        );

        const scoreMargin = Math.abs(debate.scores.bullScore - debate.scores.bearScore);
        const isCloseDebate = scoreMargin < 10;

        // Adjust confidence based on debate outcome
        let adjustedConfidence = thesis.confidence;

        if (wonDebate) {
            if (scoreMargin > 20) {
                adjustedConfidence = Math.min(100, adjustedConfidence + 10);
                reasoning.push(`Landslide victory (+${scoreMargin} points)`);
            } else {
                reasoning.push(`Won debate (+${scoreMargin} points)`);
            }
        } else {
            adjustedConfidence = adjustedConfidence * 0.5;
            reasoning.push(`Lost debate (margin: ${scoreMargin} points) - reducing confidence`);
        }

        if (isCloseDebate) {
            adjustedConfidence = adjustedConfidence * 0.8;
            reasoning.push('Close debate, reducing confidence');
        }

        // Factor in agent's historical accuracy
        if (portfolio.winRate < 0.4 && portfolio.totalTrades > 5) {
            adjustedConfidence = adjustedConfidence * 0.7;
            reasoning.push(`Low historical win rate (${(portfolio.winRate * 100).toFixed(0)}%)`);
        }

        // BUY logic
        if (thesis.recommendation === 'strong_buy' || thesis.recommendation === 'buy') {
            if (!wonDebate) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: ['Lost debate - skipping trade'],
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            if (adjustedConfidence < 50) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: ['Confidence too low after adjustments'],
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            const sizing = positionSizingService.calculatePositionSize(
                portfolio,
                thesis.ticker,
                adjustedConfidence,
                currentPrice
            );

            if (!sizing.isValid) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: sizing.warnings,
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            return {
                action: 'BUY',
                ticker: thesis.ticker,
                shares: sizing.shares,
                estimatedPrice: currentPrice,
                estimatedValue: sizing.value,
                confidence: adjustedConfidence,
                reasoning,
                warnings: [...warnings, ...sizing.warnings],
                thesisId: thesis.agentId,
                debateId: debate.matchId,
                recommendation: thesis.recommendation,
                isValid: validationErrors.length === 0,
                validationErrors
            };
        }

        // SELL logic
        if (thesis.recommendation === 'sell' || thesis.recommendation === 'strong_sell') {
            if (!existingPosition) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: ['No position to sell'],
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            if (!wonDebate) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: ['Lost debate - holding position'],
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            const sellPercent = thesis.recommendation === 'strong_sell' ? 1.0 : 0.5;
            let sharesToSell = Math.floor(existingPosition.shares * sellPercent);

            // Ensure at least 1 share is sold for small positions
            if (sharesToSell === 0 && existingPosition.shares > 0) {
                sharesToSell = 1;
            }

            // Skip if no shares to sell
            if (sharesToSell === 0) {
                return {
                    action: 'HOLD',
                    ticker: thesis.ticker,
                    shares: 0,
                    estimatedPrice: currentPrice,
                    estimatedValue: 0,
                    confidence: adjustedConfidence,
                    reasoning: ['Position too small to sell'],
                    warnings,
                    thesisId: thesis.agentId,
                    debateId: debate.matchId,
                    recommendation: thesis.recommendation,
                    isValid: false,
                    validationErrors
                };
            }

            return {
                action: 'SELL',
                ticker: thesis.ticker,
                shares: sharesToSell,
                estimatedPrice: currentPrice,
                estimatedValue: sharesToSell * currentPrice,
                confidence: adjustedConfidence,
                reasoning: [`Selling ${(sellPercent * 100).toFixed(0)}% of position`],
                warnings,
                thesisId: thesis.agentId,
                debateId: debate.matchId,
                recommendation: thesis.recommendation,
                isValid: validationErrors.length === 0,
                validationErrors
            };
        }

        // HOLD
        return {
            action: 'HOLD',
            ticker: thesis.ticker,
            shares: 0,
            estimatedPrice: currentPrice,
            estimatedValue: 0,
            confidence: adjustedConfidence,
            reasoning: ['Recommendation is HOLD or conditions not met'],
            warnings,
            thesisId: thesis.agentId,
            debateId: debate.matchId,
            recommendation: thesis.recommendation,
            isValid: true,
            validationErrors
        };
    }

    async executeTrade(
        portfolio: AgentPortfolio,
        decision: TradeDecision,
        state: TradingSystemState
    ): Promise<Trade | null> {
        // Guard: Don't execute HOLD actions
        if (decision.action === 'HOLD') {
            console.warn('Attempted to execute HOLD action, skipping');
            return null;
        }

        return tradingSystemLock.withLock(async () => {
            try {
                // Validate price
                if (decision.estimatedPrice <= 0) {
                    throw new TradingError(
                        'Invalid price: must be greater than 0',
                        TradingErrorCode.INVALID_PRICE,
                        false,
                        { price: decision.estimatedPrice }
                    );
                }

                // Validate shares
                if (!Number.isInteger(decision.shares) || decision.shares <= 0) {
                    throw new TradingError(
                        'Invalid shares: must be positive integer',
                        TradingErrorCode.INVALID_SHARES,
                        false,
                        { shares: decision.shares }
                    );
                }

                // Check for duplicate trades
                const recentTrades = portfolio.trades.slice(-10);
                const isDuplicate = recentTrades.some(t =>
                    t.ticker === decision.ticker &&
                    t.type === decision.action &&
                    t.shares === decision.shares &&
                    Math.abs(t.price - decision.estimatedPrice) < 0.01 &&
                    (Date.now() - t.timestamp) < 5000 // Within 5 seconds
                );

                if (isDuplicate) {
                    console.warn('Duplicate trade detected, skipping');
                    return null;
                }

                const marketStatus = marketHoursService.getMarketStatus();

                const trade: Trade = {
                    id: this.generateId(),
                    ticker: decision.ticker,
                    type: decision.action as 'BUY' | 'SELL',
                    shares: decision.shares,
                    price: decision.estimatedPrice,
                    totalValue: decision.estimatedValue,
                    commission: 0,
                    timestamp: Date.now(),
                    marketStatus: marketStatus.currentStatus,
                    priceTimestamp: Date.now(),
                    priceDelay: 0,
                    thesisId: decision.thesisId,
                    debateId: decision.debateId,
                    recommendation: decision.recommendation,
                    confidence: decision.confidence,
                    isValid: decision.isValid,
                    validationWarnings: decision.warnings,
                    executionMethod: marketStatus.isOpen ? 'IMMEDIATE' : 'PENDING_ORDER'
                };

                if (decision.action === 'BUY') {
                    this.executeBuy(portfolio, trade);
                } else if (decision.action === 'SELL') {
                    this.executeSell(portfolio, trade);
                }

                portfolio.trades.push(trade);
                portfolio.lastTradeAt = Date.now();
                portfolio.updatedAt = Date.now();

                // Update system stats
                state.totalTrades++;
                state.totalVolume += trade.totalValue;
                state.mostTradedStocks[trade.ticker] = (state.mostTradedStocks[trade.ticker] || 0) + 1;

                // Explicitly update portfolio in state
                state.portfolios[portfolio.agentId] = portfolio;

                this.updatePortfolioMetrics(portfolio, state.riskManagementRules);
                await this.saveTradingState(state);

                return trade;
            } catch (error) {
                this.handleError(portfolio, error as Error);
                return null;
            }
        });
    }

    private executeBuy(portfolio: AgentPortfolio, trade: Trade): void {
        const requiredCash = trade.totalValue;

        if (portfolio.currentCash < requiredCash) {
            throw new TradingError(
                'Insufficient cash',
                TradingErrorCode.INSUFFICIENT_CASH,
                false,
                { required: requiredCash, available: portfolio.currentCash }
            );
        }

        portfolio.currentCash -= requiredCash;

        const existingPosition = portfolio.positions.find(p => p.ticker === trade.ticker);

        if (existingPosition) {
            // Add to existing position
            const totalShares = existingPosition.shares + trade.shares;
            const totalCost = existingPosition.totalCostBasis + trade.totalValue;

            // Guard against division by zero (should never happen but defensive)
            existingPosition.avgCostBasis = totalShares > 0 ? totalCost / totalShares : trade.price;
            existingPosition.shares = totalShares;
            existingPosition.totalCostBasis = totalCost;
            existingPosition.currentPrice = trade.price;
            existingPosition.marketValue = totalShares * trade.price;
            existingPosition.unrealizedPnL = (trade.price - existingPosition.avgCostBasis) * totalShares;
            existingPosition.unrealizedPnLPercent = totalCost > 0 ? (existingPosition.unrealizedPnL / totalCost) : 0;
            existingPosition.lastUpdated = Date.now();

            if (trade.price > existingPosition.highWaterMark) {
                existingPosition.highWaterMark = trade.price;
            }
            existingPosition.drawdownFromHigh = existingPosition.highWaterMark > 0
                ? (existingPosition.highWaterMark - trade.price) / existingPosition.highWaterMark
                : 0;
        } else {
            // Create new position
            const newPosition: Position = {
                ticker: trade.ticker,
                shares: trade.shares,
                avgCostBasis: trade.price,
                currentPrice: trade.price,
                lastPriceUpdate: Date.now(),
                marketValue: trade.totalValue,
                unrealizedPnL: 0,
                unrealizedPnLPercent: 0,
                openedAt: Date.now(),
                totalCostBasis: trade.totalValue,
                realizedPnL: 0,
                highWaterMark: trade.price,
                drawdownFromHigh: 0,
                lastUpdated: Date.now()
            };
            portfolio.positions.push(newPosition);
        }
    }

    private executeSell(portfolio: AgentPortfolio, trade: Trade): void {
        const position = portfolio.positions.find(p => p.ticker === trade.ticker);

        if (!position) {
            throw new TradingError(
                'Position not found',
                TradingErrorCode.POSITION_NOT_FOUND,
                false,
                { ticker: trade.ticker }
            );
        }

        // Validate shares BEFORE any calculations
        if (position.shares < trade.shares) {
            throw new TradingError(
                'Insufficient shares',
                TradingErrorCode.INVALID_SHARES,
                false,
                { available: position.shares, requested: trade.shares }
            );
        }

        const proceeds = trade.totalValue;
        portfolio.currentCash += proceeds;

        // Calculate realized P&L
        const costBasis = position.avgCostBasis * trade.shares;
        const realizedPnL = proceeds - costBasis;

        trade.realizedPnL = realizedPnL;
        trade.realizedPnLPercent = costBasis > 0 ? realizedPnL / costBasis : 0;

        // Calculate sell percent BEFORE modifying shares
        const originalShares = position.shares;
        // Guard against division by zero (should never happen due to validation above)
        const sellPercent = originalShares > 0 ? trade.shares / originalShares : 0;

        position.shares -= trade.shares;
        position.realizedPnL += realizedPnL;

        // Reduce totalCostBasis proportionally
        position.totalCostBasis = position.totalCostBasis * (1 - sellPercent);

        if (position.shares === 0) {
            // Remove position
            const index = portfolio.positions.indexOf(position);
            portfolio.positions.splice(index, 1);
        } else {
            // Update position
            position.marketValue = position.shares * trade.price;
            position.currentPrice = trade.price;
            position.unrealizedPnL = (trade.price - position.avgCostBasis) * position.shares;
            position.unrealizedPnLPercent = position.totalCostBasis > 0
                ? position.unrealizedPnL / position.totalCostBasis
                : 0;
            position.lastUpdated = Date.now();
        }
    }

    private shouldCreateSnapshot(portfolio: AgentPortfolio): boolean {
        if (portfolio.performanceHistory.length === 0) return true;

        const lastSnapshot = portfolio.performanceHistory[portfolio.performanceHistory.length - 1];
        const hoursSinceLastSnapshot = (Date.now() - lastSnapshot.timestamp) / (1000 * 60 * 60);

        // Create snapshot once per day (24 hours)
        return hoursSinceLastSnapshot >= 24;
    }

    private updatePortfolioMetrics(portfolio: AgentPortfolio, riskRules?: RiskManagementRules): void {
        // Update total value
        const positionsValue = portfolio.positions.reduce((sum, p) => sum + p.marketValue, 0);
        portfolio.totalValue = portfolio.currentCash + positionsValue;

        // Update returns
        portfolio.totalReturnDollar = portfolio.totalValue - portfolio.initialCash;
        portfolio.totalReturn = portfolio.initialCash > 0
            ? portfolio.totalReturnDollar / portfolio.initialCash
            : 0;

        // Update peak and drawdown
        if (portfolio.totalValue > portfolio.peakValue) {
            portfolio.peakValue = portfolio.totalValue;
        }
        portfolio.currentDrawdown = portfolio.peakValue > 0
            ? (portfolio.peakValue - portfolio.totalValue) / portfolio.peakValue
            : 0;
        portfolio.maxDrawdown = Math.max(portfolio.maxDrawdown, portfolio.currentDrawdown);

        // Update trade statistics
        const stats = performanceCalculator.calculateTradeStatistics(portfolio.trades);
        portfolio.totalTrades = stats.totalTrades;
        portfolio.winningTrades = stats.winningTrades;
        portfolio.losingTrades = stats.losingTrades;
        portfolio.avgWin = stats.avgWin;
        portfolio.avgLoss = stats.avgLoss;
        portfolio.largestWin = stats.largestWin;
        portfolio.largestLoss = stats.largestLoss;

        // Update win rate
        portfolio.winRate = performanceCalculator.calculateWinRate(portfolio.trades);
        portfolio.profitFactor = performanceCalculator.calculateProfitFactor(portfolio.trades);

        // Create performance snapshot only once per day
        if (this.shouldCreateSnapshot(portfolio)) {
            this.createPerformanceSnapshot(portfolio);
        }

        // Update Sharpe ratio and volatility (if enough data)
        if (portfolio.performanceHistory.length >= 30) {
            const returns = portfolio.performanceHistory.map(s => s.dailyReturn);
            portfolio.sharpeRatio = performanceCalculator.calculateSharpeRatio(returns);
            portfolio.volatility = performanceCalculator.calculateVolatility(returns);
        }

        // Check if portfolio should be paused or liquidated using configured rules
        // Use provided rules or fall back to defaults
        const { maxDrawdownBeforePause, maxDrawdownBeforeLiquidate } =
            riskRules || { maxDrawdownBeforePause: 0.3, maxDrawdownBeforeLiquidate: 0.8 };

        if (portfolio.currentDrawdown >= maxDrawdownBeforeLiquidate) {
            portfolio.status = 'liquidated';
        } else if (portfolio.currentDrawdown >= maxDrawdownBeforePause) {
            portfolio.status = 'paused';
        }
    }

    private createPerformanceSnapshot(portfolio: AgentPortfolio): void {
        const positionsValue = portfolio.positions.reduce((sum, p) => sum + p.marketValue, 0);

        // Calculate daily return from 24 hours ago, not last snapshot
        let dailyReturn = 0;
        if (portfolio.performanceHistory.length > 0) {
            const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

            // Find snapshot closest to 24 hours ago
            const yesterdaySnapshot = portfolio.performanceHistory
                .slice()
                .reverse()
                .find(s => s.timestamp <= oneDayAgo);

            if (yesterdaySnapshot && yesterdaySnapshot.totalValue > 0) {
                dailyReturn = (portfolio.totalValue - yesterdaySnapshot.totalValue) / yesterdaySnapshot.totalValue;
            }
        }

        // Find largest position
        let largestPosition = '';
        let largestPositionPercent = 0;
        if (portfolio.positions.length > 0 && portfolio.totalValue > 0) {
            const largest = portfolio.positions.reduce((max, p) =>
                p.marketValue > max.marketValue ? p : max
            );
            largestPosition = largest.ticker;
            largestPositionPercent = largest.marketValue / portfolio.totalValue;
        }

        const snapshot = {
            timestamp: Date.now(),
            totalValue: portfolio.totalValue,
            cash: portfolio.currentCash,
            positionsValue,
            totalReturn: portfolio.totalReturn,
            dailyReturn,
            volatility: portfolio.volatility,
            sharpeRatio: portfolio.sharpeRatio || 0,
            maxDrawdown: portfolio.maxDrawdown,
            currentDrawdown: portfolio.currentDrawdown,
            numPositions: portfolio.positions.length,
            largestPosition,
            largestPositionPercent
        };

        portfolio.performanceHistory.push(snapshot);
    }

    async updatePositionPrices(
        portfolio: AgentPortfolio,
        priceData: Map<string, number>
    ): Promise<void> {
        return tradingSystemLock.withLock(async () => {
            for (const position of portfolio.positions) {
                const newPrice = priceData.get(position.ticker);
                if (newPrice && newPrice > 0) {
                    position.currentPrice = newPrice;
                    position.lastPriceUpdate = Date.now();
                    position.marketValue = position.shares * newPrice;
                    position.unrealizedPnL = (newPrice - position.avgCostBasis) * position.shares;
                    position.unrealizedPnLPercent = position.totalCostBasis > 0
                        ? position.unrealizedPnL / position.totalCostBasis
                        : 0;

                    if (newPrice > position.highWaterMark) {
                        position.highWaterMark = newPrice;
                    }
                    position.drawdownFromHigh = position.highWaterMark > 0
                        ? (position.highWaterMark - newPrice) / position.highWaterMark
                        : 0;
                }
            }

            // Save state after price updates - use fresh state to avoid stale data
            // IMPORTANT: We must use the portfolio parameter that was just updated,
            // but get fresh riskManagementRules from state to avoid stale config
            const freshState = this.loadTradingState();
            if (freshState) {
                // Update metrics using fresh rules but the portfolio we just modified
                this.updatePortfolioMetrics(portfolio, freshState.riskManagementRules);
                // Save the updated portfolio back to fresh state
                freshState.portfolios[portfolio.agentId] = portfolio;
                await this.saveTradingState(freshState);
            }
        });
    }

    private handleError(portfolio: AgentPortfolio, error: Error): void {
        const tradingError = error instanceof TradingError ? error : new TradingError(
            error.message,
            TradingErrorCode.API_FAILURE,
            true
        );

        portfolio.errorLog.push({
            id: this.generateId(),
            timestamp: Date.now(),
            code: tradingError.code,
            message: tradingError.message,
            severity: tradingError.recoverable ? 'MEDIUM' : 'CRITICAL',
            context: tradingError.context,
            resolved: false
        });

        console.error('Trading error:', tradingError);
    }

    loadTradingState(): TradingSystemState | null {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            if (!data) return null;
            const parsed = JSON.parse(data);
            // Basic validation to ensure we got valid data
            if (!parsed || typeof parsed !== 'object' || !parsed.portfolios) {
                console.error('Invalid trading state structure in localStorage');
                return null;
            }
            return parsed;
        } catch (error) {
            console.error('Failed to load trading state:', error);
            return null;
        }
    }

    async saveTradingState(state: TradingSystemState): Promise<boolean> {
        return tradingSystemLock.withLock(async () => {
            try {
                state.lastUpdated = Date.now();

                // Trim all portfolios to prevent bloat
                for (const portfolio of Object.values(state.portfolios)) {
                    this.trimPortfolioData(portfolio);
                }

                const data = JSON.stringify(state);

                // Check size before saving
                const sizeInBytes = new Blob([data]).size;
                const sizeInMB = sizeInBytes / (1024 * 1024);

                if (sizeInMB > 4) { // Leave 1MB buffer for 5MB limit
                    console.warn(`Trading data is large (${sizeInMB.toFixed(2)}MB), already trimmed`);
                }

                localStorage.setItem(this.STORAGE_KEY, data);
                return true;
            } catch (error: any) {
                if (error.name === 'QuotaExceededError') {
                    console.error('Storage quota exceeded - attempting emergency save');
                    try {
                        // Emergency: Save only essential data
                        const minimalState = this.createMinimalState(state);
                        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(minimalState));
                        return false;
                    } catch (e) {
                        console.error('Emergency save failed:', e);
                        return false;
                    }
                }
                console.error('Failed to save trading state:', error);
                return false;
            }
        });
    }

    private trimPortfolioData(portfolio: AgentPortfolio): void {
        // Trim trades - keep most recent
        if (portfolio.trades.length > this.MAX_TRADES_PER_PORTFOLIO) {
            portfolio.trades = portfolio.trades.slice(-this.MAX_TRADES_PER_PORTFOLIO);
        }

        // Trim performance history - keep most recent
        if (portfolio.performanceHistory.length > this.MAX_PERFORMANCE_SNAPSHOTS) {
            portfolio.performanceHistory = portfolio.performanceHistory.slice(-this.MAX_PERFORMANCE_SNAPSHOTS);
        }

        // Trim error log - keep unresolved + recent resolved
        if (portfolio.errorLog.length > this.MAX_ERROR_LOG) {
            const unresolved = portfolio.errorLog.filter(e => !e.resolved);
            const resolved = portfolio.errorLog.filter(e => e.resolved).slice(-50);
            portfolio.errorLog = [...unresolved, ...resolved].slice(-this.MAX_ERROR_LOG);
        }

        // Trim corporate actions - keep most recent
        if (portfolio.corporateActions.length > this.MAX_CORPORATE_ACTIONS) {
            portfolio.corporateActions = portfolio.corporateActions.slice(-this.MAX_CORPORATE_ACTIONS);
        }
    }

    private createMinimalState(state: TradingSystemState): TradingSystemState {
        const minimalPortfolios: Record<string, AgentPortfolio> = {};

        for (const [id, portfolio] of Object.entries(state.portfolios)) {
            minimalPortfolios[id] = {
                ...portfolio,
                trades: portfolio.trades.slice(-100), // Keep last 100 trades
                performanceHistory: portfolio.performanceHistory.slice(-30), // Keep last 30 days
                errorLog: portfolio.errorLog.filter(e => !e.resolved).slice(-20), // Keep unresolved only
                corporateActions: portfolio.corporateActions.slice(-10)
            };
        }

        return {
            ...state,
            portfolios: minimalPortfolios
        };
    }

    exportTradingData(state: TradingSystemState): string {
        return JSON.stringify(state, null, 2);
    }

    async importTradingData(jsonData: string): Promise<TradingSystemState | null> {
        try {
            const state = JSON.parse(jsonData) as TradingSystemState;

            // Validate structure
            if (!state.version || typeof state.version !== 'number') {
                throw new Error('Invalid or missing version');
            }

            if (!state.portfolios || typeof state.portfolios !== 'object') {
                throw new Error('Invalid or missing portfolios');
            }

            if (!state.positionSizingRules || !state.riskManagementRules) {
                throw new Error('Invalid or missing rules');
            }

            // Validate each portfolio
            for (const [id, portfolio] of Object.entries(state.portfolios)) {
                if (!this.validatePortfolio(portfolio)) {
                    throw new Error(`Invalid portfolio structure: ${id}`);
                }
            }

            // Validate numeric values
            if (state.totalTrades < 0 || state.totalVolume < 0 || state.systemErrors < 0) {
                throw new Error('Invalid numeric values (negative)');
            }

            // Validate dates
            if (!state.startDate || !state.lastUpdated || state.startDate > Date.now()) {
                throw new Error('Invalid dates');
            }

            // Use await for async save operation
            await this.saveTradingState(state);
            return state;
        } catch (error) {
            console.error('Failed to import trading data:', error);
            return null;
        }
    }

    private validatePortfolio(portfolio: any): boolean {
        if (!portfolio || typeof portfolio !== 'object') return false;

        // Required fields
        const requiredFields = [
            'agentId', 'agentName', 'methodology', 'initialCash', 'currentCash',
            'totalValue', 'positions', 'trades', 'status'
        ];

        for (const field of requiredFields) {
            if (!(field in portfolio)) {
                console.error(`Missing required field: ${field}`);
                return false;
            }
        }

        // Validate arrays
        if (!Array.isArray(portfolio.positions) || !Array.isArray(portfolio.trades)) {
            console.error('Positions or trades is not an array');
            return false;
        }

        // Validate numeric values
        if (portfolio.initialCash < 0 || portfolio.currentCash < 0 || portfolio.totalValue < 0) {
            console.error('Invalid numeric values in portfolio');
            return false;
        }

        // Validate status
        if (!['active', 'paused', 'liquidated'].includes(portfolio.status)) {
            console.error(`Invalid status: ${portfolio.status}`);
            return false;
        }

        return true;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }
}

export const tradingService = new TradingService();
