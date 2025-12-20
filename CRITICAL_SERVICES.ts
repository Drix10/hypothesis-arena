/**
 * CRITICAL SERVICES - Must-Have Implementations
 * 
 * These services address the critical edge cases and issues
 * identified in the design critique.
 */

import {
    AgentPortfolio,
    Position,
    Trade,
    PendingOrder,
    MarketStatus,
    PriceValidation,
    TradeDecision,
    TradingErrorCode,
    ClosedPosition
} from './FIXED_DATA_MODELS';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MARKET HOURS SERVICE (CRITICAL)
// ═══════════════════════════════════════════════════════════════════════════════

export class MarketHoursService {
    private readonly NYSE_HOLIDAYS_2024_2025 = [
        '2024-12-25', // Christmas
        '2025-01-01', // New Year's Day
        '2025-01-20', // MLK Day
        '2025-02-17', // Presidents Day
        '2025-04-18', // Good Friday
        '2025-05-26', // Memorial Day
        '2025-07-04', // Independence Day
        '2025-09-01', // Labor Day
        '2025-11-27', // Thanksgiving
        '2025-12-25', // Christmas
    ];

    getMarketStatus(timestamp: number = Date.now()): MarketStatus {
        const date = new Date(timestamp);
        const dayOfWeek = date.getDay();
        const dateString = date.toISOString().split('T')[0];

        // Check if weekend
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return {
                isOpen: false,
                currentStatus: 'CLOSED',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'weekend'
            };
        }

        // Check if holiday
        if (this.NYSE_HOLIDAYS_2024_2025.includes(dateString)) {
            return {
                isOpen: false,
                currentStatus: 'CLOSED',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'holiday',
                holidayName: this.getHolidayName(dateString)
            };
        }

        // Check market hours (9:30 AM - 4:00 PM ET)
        const etTime = this.toEasternTime(date);
        const hours = etTime.getHours();
        const minutes = etTime.getMinutes();
        const timeInMinutes = hours * 60 + minutes;

        const marketOpen = 9 * 60 + 30; // 9:30 AM
        const marketClose = 16 * 60; // 4:00 PM

        if (timeInMinutes < marketOpen) {
            return {
                isOpen: false,
                currentStatus: 'PRE_MARKET',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'pre_market'
            };
        }

        if (timeInMinutes >= marketClose) {
            return {
                isOpen: false,
                currentStatus: 'AFTER_HOURS',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'after_hours'
            };
        }

        return {
            isOpen: true,
            currentStatus: 'OPEN',
            nextOpen: this.getNextMarketOpen(timestamp),
            nextClose: this.getNextMarketClose(timestamp)
        };
    }

    private toEasternTime(date: Date): Date {
        // Convert to ET (simplified - doesn't handle DST perfectly)
        const utcOffset = date.getTimezoneOffset();
        const etOffset = -5 * 60; // ET is UTC-5 (or UTC-4 during DST)
        const offsetDiff = etOffset - utcOffset;
        return new Date(date.getTime() + offsetDiff * 60 * 1000);
    }

    private getNextMarketOpen(timestamp: number): number {
        // Simplified - returns next 9:30 AM ET on a weekday
        const date = new Date(timestamp);
        const etTime = this.toEasternTime(date);

        // If before 9:30 AM today and it's a weekday, return today's open
        if (etTime.getHours() < 9 || (etTime.getHours() === 9 && etTime.getMinutes() < 30)) {
            if (etTime.getDay() >= 1 && etTime.getDay() <= 5) {
                etTime.setHours(9, 30, 0, 0);
                return etTime.getTime();
            }
        }

        // Otherwise, return next weekday at 9:30 AM
        let nextDay = new Date(etTime);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(9, 30, 0, 0);

        while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
            nextDay.setDate(nextDay.getDate() + 1);
        }

        return nextDay.getTime();
    }

    private getNextMarketClose(timestamp: number): number {
        // Simplified - returns next 4:00 PM ET on a weekday
        const date = new Date(timestamp);
        const etTime = this.toEasternTime(date);

        // If before 4:00 PM today and it's a weekday, return today's close
        if (etTime.getHours() < 16) {
            if (etTime.getDay() >= 1 && etTime.getDay() <= 5) {
                etTime.setHours(16, 0, 0, 0);
                return etTime.getTime();
            }
        }

        // Otherwise, return next weekday at 4:00 PM
        let nextDay = new Date(etTime);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(16, 0, 0, 0);

        while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
            nextDay.setDate(nextDay.getDate() + 1);
        }

        return nextDay.getTime();
    }

    private getHolidayName(dateString: string): string {
        const holidays: Record<string, string> = {
            '2024-12-25': 'Christmas',
            '2025-01-01': 'New Year\'s Day',
            '2025-01-20': 'Martin Luther King Jr. Day',
            '2025-02-17': 'Presidents Day',
            '2025-04-18': 'Good Friday',
            '2025-05-26': 'Memorial Day',
            '2025-07-04': 'Independence Day',
            '2025-09-01': 'Labor Day',
            '2025-11-27': 'Thanksgiving',
            '2025-12-25': 'Christmas'
        };
        return holidays[dateString] || 'Market Holiday';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PRICE VALIDATION SERVICE (CRITICAL)
// ═══════════════════════════════════════════════════════════════════════════════

export class PriceValidationService {
    private readonly STALE_THRESHOLD_SECONDS = 30 * 60; // 30 minutes
    private readonly SUSPICIOUS_MOVE_THRESHOLD = 0.2; // 20% move

    validatePrice(
        ticker: string,
        price: number,
        timestamp: number,
        previousPrice?: number
    ): PriceValidation {
        const now = Date.now();
        const ageSeconds = Math.floor((now - timestamp) / 1000);
        const isStale = ageSeconds > this.STALE_THRESHOLD_SECONDS;

        let isSuspicious = false;
        let warning: string | undefined;

        // Check for suspicious price movements
        if (previousPrice && previousPrice > 0) {
            const priceChange = Math.abs((price - previousPrice) / previousPrice);
            if (priceChange > this.SUSPICIOUS_MOVE_THRESHOLD) {
                isSuspicious = true;
                warning = `Unusual price movement: ${(priceChange * 100).toFixed(1)}% change`;
            }
        }

        // Check for invalid prices
        if (price <= 0) {
            isSuspicious = true;
            warning = 'Invalid price: must be greater than 0';
        }

        // Check for staleness
        if (isStale) {
            warning = `Price is ${Math.floor(ageSeconds / 60)} minutes old`;
        }

        return {
            ticker,
            price,
            timestamp,
            ageSeconds,
            isStale,
            isSuspicious,
            warning,
            source: 'FMP' // Would be dynamic in real implementation
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. POSITION SIZING SERVICE (CRITICAL)
// ═══════════════════════════════════════════════════════════════════════════════

export class PositionSizingService {
    calculatePositionSize(
        portfolio: AgentPortfolio,
        ticker: string,
        confidence: number,
        currentPrice: number
    ): { shares: number; value: number; warnings: string[] } {
        const warnings: string[] = [];

        // Check existing position
        const existingPosition = portfolio.positions.find(p => p.ticker === ticker);
        if (existingPosition) {
            const existingPercent = existingPosition.marketValue / portfolio.totalValue;
            if (existingPercent >= 0.2) {
                return { shares: 0, value: 0, warnings: ['Already at max position size (20%)'] };
            }
        }

        // Calculate available cash (excluding reserved)
        const availableCash = portfolio.currentCash - portfolio.reservedCash;
        if (availableCash < 100) {
            return { shares: 0, value: 0, warnings: ['Insufficient cash (min $100)'] };
        }

        // Calculate target position size based on confidence
        const maxPositionPercent = 0.2; // 20% max
        const targetPercent = (confidence / 100) * maxPositionPercent;
        const targetValue = portfolio.totalValue * targetPercent;

        // Limit to available cash (keep 5% buffer)
        const maxValue = Math.min(targetValue, availableCash * 0.95);

        // Calculate whole shares (no fractional shares)
        const shares = Math.floor(maxValue / currentPrice);
        const actualValue = shares * currentPrice;

        // Validate minimum trade size
        if (actualValue < 100) {
            return { shares: 0, value: 0, warnings: ['Trade size too small (min $100)'] };
        }

        // Check total invested limit (80% max)
        const totalInvested = portfolio.positions.reduce((sum, p) => sum + p.marketValue, 0);
        const newTotalInvested = totalInvested + actualValue;
        if (newTotalInvested > portfolio.totalValue * 0.8) {
            warnings.push('Approaching max invested limit (80%)');
        }

        // Check position count limit
        if (portfolio.positions.length >= 10 && !existingPosition) {
            return { shares: 0, value: 0, warnings: ['Max positions reached (10)'] };
        }

        return { shares, value: actualValue, warnings };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PERFORMANCE CALCULATOR (CRITICAL)
// ═══════════════════════════════════════════════════════════════════════════════

export class PerformanceCalculator {
    calculateSharpeRatio(returns: number[], riskFreeRate: number = 0.04): number {
        if (returns.length < 30) return 0; // Need 30+ data points

        const annualizedRiskFreeRate = riskFreeRate / 252; // Daily risk-free rate
        const excessReturns = returns.map(r => r - annualizedRiskFreeRate);

        const avgExcessReturn = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
        const stdDev = this.calculateStdDev(excessReturns);

        if (stdDev === 0) return 0;

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
            const drawdown = (peak - value) / peak;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }

        return maxDrawdown;
    }

    calculateWinRate(trades: Trade[]): number {
        const closedPositions = this.groupTradesByPosition(trades);
        const profitable = closedPositions.filter(p => p.realizedPnL > 0).length;
        return closedPositions.length > 0 ? profitable / closedPositions.length : 0;
    }

    private calculateStdDev(values: number[]): number {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(variance);
    }

    private groupTradesByPosition(trades: Trade[]): ClosedPosition[] {
        // Group buys and sells by ticker using FIFO
        const positions = new Map<string, { buys: Trade[], sells: Trade[] }>();

        for (const trade of trades) {
            if (!positions.has(trade.ticker)) {
                positions.set(trade.ticker, { buys: [], sells: [] });
            }
            const pos = positions.get(trade.ticker)!;
            if (trade.type === 'BUY') {
                pos.buys.push(trade);
            } else {
                pos.sells.push(trade);
            }
        }

        const closedPositions: ClosedPosition[] = [];

        for (const [ticker, { buys, sells }] of positions) {
            let remainingBuys = [...buys];

            for (const sell of sells) {
                let sharesToMatch = sell.shares;
                let costBasis = 0;
                const openTrades: Trade[] = [];

                while (sharesToMatch > 0 && remainingBuys.length > 0) {
                    const buy = remainingBuys[0];
                    const matchShares = Math.min(sharesToMatch, buy.shares);

                    costBasis += matchShares * buy.price;
                    sharesToMatch -= matchShares;
                    openTrades.push(buy);

                    buy.shares -= matchShares;
                    if (buy.shares === 0) {
                        remainingBuys.shift();
                    }
                }

                const proceeds = sell.shares * sell.price;
                const realizedPnL = proceeds - costBasis;
                const holdingPeriodDays = Math.floor((sell.timestamp - openTrades[0].timestamp) / (1000 * 60 * 60 * 24));

                closedPositions.push({
                    ticker,
                    shares: sell.shares,
                    costBasis,
                    proceeds,
                    realizedPnL,
                    realizedPnLPercent: costBasis > 0 ? (realizedPnL / costBasis) : 0,
                    openDate: openTrades[0].timestamp,
                    closeDate: sell.timestamp,
                    holdingPeriodDays,
                    openTrades,
                    closeTrades: [sell]
                });
            }
        }

        return closedPositions;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TRADING SYSTEM LOCK (CRITICAL)
// ═══════════════════════════════════════════════════════════════════════════════

export class TradingSystemLock {
    private locked = false;
    private queue: (() => void)[] = [];

    async acquireLock(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }

    releaseLock(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
        } else {
            this.locked = false;
        }
    }

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquireLock();
        try {
            return await fn();
        } finally {
            this.releaseLock();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CORPORATE ACTIONS SERVICE (IMPORTANT)
// ═══════════════════════════════════════════════════════════════════════════════

export class CorporateActionsService {
    processSplit(portfolio: AgentPortfolio, ticker: string, ratio: number): void {
        const position = portfolio.positions.find(p => p.ticker === ticker);
        if (!position) return;

        const oldShares = position.shares;
        const oldCostBasis = position.avgCostBasis;

        // Adjust shares and cost basis
        position.shares = Math.floor(oldShares * ratio);
        position.avgCostBasis = oldCostBasis / ratio;
        position.totalCostBasis = position.shares * position.avgCostBasis;

        // Update current price (also splits)
        position.currentPrice = position.currentPrice / ratio;
        position.marketValue = position.shares * position.currentPrice;

        // Recalculate P&L
        position.unrealizedPnL = (position.currentPrice - position.avgCostBasis) * position.shares;
        position.unrealizedPnLPercent = position.avgCostBasis > 0
            ? (position.unrealizedPnL / position.totalCostBasis)
            : 0;

        console.log(`Processed ${ratio}:1 split for ${ticker}: ${oldShares} → ${position.shares} shares`);
    }

    processDividend(portfolio: AgentPortfolio, ticker: string, amountPerShare: number): void {
        const position = portfolio.positions.find(p => p.ticker === ticker);
        if (!position) return;

        const totalDividend = position.shares * amountPerShare;
        portfolio.currentCash += totalDividend;

        console.log(`Processed dividend for ${ticker}: $${totalDividend.toFixed(2)} (${position.shares} shares × $${amountPerShare})`);
    }
}
