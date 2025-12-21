/**
 * Performance Calculator
 * 
 * Calculates accurate performance metrics including Sharpe ratio, max drawdown,
 * win rate, and volatility with proper statistical methods.
 */

import { Trade, ClosedPosition } from '../../types/trading';

export class PerformanceCalculator {
    calculateSharpeRatio(returns: number[], riskFreeRate: number = 0.04): number {
        if (returns.length < 30) return 0; // Need 30+ data points

        const annualizedRiskFreeRate = riskFreeRate / 252; // Daily risk-free rate
        const excessReturns = returns.map(r => r - annualizedRiskFreeRate);

        const avgExcessReturn = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
        const stdDev = this.calculateStdDev(excessReturns);

        if (stdDev < 1e-10) return 0; // Treat very small stdDev as zero

        // Annualize
        return (avgExcessReturn / stdDev) * Math.sqrt(252);
    }

    calculateVolatility(returns: number[]): number {
        if (returns.length < 2) return 0;
        const stdDev = this.calculateStdDev(returns);
        return stdDev * Math.sqrt(252); // Annualize
    }

    calculateMaxDrawdown(values: number[]): number {
        if (values.length < 2) return 0;

        let maxDrawdown = 0;
        let peak = values[0];

        for (const value of values) {
            if (value > peak) {
                peak = value;
            }
            // Guard against division by zero
            if (peak > 0) {
                const drawdown = (peak - value) / peak;
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown;
                }
            }
        }

        return maxDrawdown;
    }

    calculateCurrentDrawdown(values: number[]): number {
        if (values.length < 2) return 0;

        const peak = Math.max(...values);
        const current = values[values.length - 1];

        // Guard against division by zero
        if (peak <= 0) return 0;

        return (peak - current) / peak;
    }

    calculateWinRate(trades: Trade[]): number {
        const closedPositions = this.groupTradesByPosition(trades);
        const profitable = closedPositions.filter(p => p.realizedPnL > 0).length;
        return closedPositions.length > 0 ? profitable / closedPositions.length : 0;
    }

    calculateProfitFactor(trades: Trade[]): number {
        const closedPositions = this.groupTradesByPosition(trades);
        const totalWins = closedPositions
            .filter(p => p.realizedPnL > 0)
            .reduce((sum, p) => sum + p.realizedPnL, 0);
        const totalLosses = Math.abs(
            closedPositions
                .filter(p => p.realizedPnL < 0)
                .reduce((sum, p) => sum + p.realizedPnL, 0)
        );

        // If no losses, return Infinity for all-winning strategies (or a large number)
        if (totalLosses === 0) {
            return totalWins > 0 ? Infinity : 0;
        }
        return totalWins / totalLosses;
    }

    calculateTradeStatistics(trades: Trade[]): {
        totalTrades: number;
        winningTrades: number;
        losingTrades: number;
        avgWin: number;
        avgLoss: number;
        largestWin: number;
        largestLoss: number;
    } {
        const closedPositions = this.groupTradesByPosition(trades);
        const wins = closedPositions.filter(p => p.realizedPnL > 0);
        const losses = closedPositions.filter(p => p.realizedPnL < 0);

        return {
            totalTrades: closedPositions.length,
            winningTrades: wins.length,
            losingTrades: losses.length,
            avgWin: wins.length > 0 ? wins.reduce((sum, p) => sum + p.realizedPnL, 0) / wins.length : 0,
            avgLoss: losses.length > 0 ? losses.reduce((sum, p) => sum + p.realizedPnL, 0) / losses.length : 0,
            largestWin: wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnL)) : 0,
            largestLoss: losses.length > 0 ? Math.min(...losses.map(p => p.realizedPnL)) : 0
        };
    }

    private calculateStdDev(values: number[]): number {
        if (values.length === 0) return 0;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(variance);
    }

    groupTradesByPosition(trades: Trade[]): ClosedPosition[] {
        // Group buys and sells by ticker using FIFO
        const positions = new Map<string, { buys: Trade[], sells: Trade[] }>();

        for (const trade of trades) {
            if (!positions.has(trade.ticker)) {
                positions.set(trade.ticker, { buys: [], sells: [] });
            }
            const pos = positions.get(trade.ticker)!;
            if (trade.type === 'BUY') {
                pos.buys.push({ ...trade }); // Clone to avoid mutation
            } else {
                pos.sells.push({ ...trade }); // Clone to avoid mutation
            }
        }

        const closedPositions: ClosedPosition[] = [];

        for (const [ticker, { buys, sells }] of positions) {
            // Clone buys array to track remaining shares
            const remainingBuys = buys.map(b => ({ ...b }));

            for (const sell of sells) {
                let sharesToMatch = sell.shares;
                let costBasis = 0;
                const openTrades: Trade[] = [];

                // Safety limit to prevent infinite loops from corrupted data
                let iterations = 0;
                const maxIterations = 10000;

                while (sharesToMatch > 0 && remainingBuys.length > 0 && iterations < maxIterations) {
                    iterations++;
                    const buy = remainingBuys[0];

                    // Guard against invalid buy shares
                    if (buy.shares <= 0) {
                        remainingBuys.shift();
                        continue;
                    }

                    const matchShares = Math.min(sharesToMatch, buy.shares);

                    costBasis += matchShares * buy.price;
                    sharesToMatch -= matchShares;
                    openTrades.push({ ...buy, shares: matchShares });

                    buy.shares -= matchShares;
                    if (buy.shares <= 0) {
                        remainingBuys.shift();
                    }
                }

                if (iterations >= maxIterations) {
                    console.warn('Max iterations reached in groupTradesByPosition - possible data corruption');
                }

                // Only create closed position if we matched some shares
                if (openTrades.length > 0) {
                    const matchedShares = sell.shares - sharesToMatch;
                    const proceeds = matchedShares * sell.price;
                    const realizedPnL = proceeds - costBasis;
                    // Guard against negative holding period from corrupted data
                    const holdingPeriodMs = sell.timestamp - openTrades[0].timestamp;
                    const holdingPeriodDays = Math.max(0, Math.floor(holdingPeriodMs / (1000 * 60 * 60 * 24)));

                    // Create a modified sell trade that reflects actual matched shares
                    const matchedSellTrade: Trade = {
                        ...sell,
                        shares: matchedShares
                    };

                    closedPositions.push({
                        ticker,
                        shares: matchedShares,
                        costBasis,
                        proceeds,
                        realizedPnL,
                        realizedPnLPercent: costBasis > 0 ? (realizedPnL / costBasis) : 0,
                        openDate: openTrades[0].timestamp,
                        closeDate: sell.timestamp,
                        holdingPeriodDays,
                        openTrades,
                        closeTrades: [matchedSellTrade]
                    });
                }
            }
        }

        return closedPositions;
    }
}

export const performanceCalculator = new PerformanceCalculator();
