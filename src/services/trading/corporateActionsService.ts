/**
 * Corporate Actions Service
 * 
 * Handles stock splits, dividends, ticker changes, and other corporate actions
 * that affect portfolio positions.
 */

import { AgentPortfolio, CorporateAction, SplitDetails, DividendDetails } from '../../types/trading';

export class CorporateActionsService {
    processSplit(portfolio: AgentPortfolio, ticker: string, ratio: number): CorporateAction | null {
        // Input validation
        if (!ticker || typeof ticker !== 'string') {
            console.error('Invalid ticker for split');
            return null;
        }
        if (!ratio || ratio <= 0 || !Number.isFinite(ratio)) {
            console.error('Invalid split ratio: must be positive number');
            return null;
        }

        const position = portfolio.positions.find(p => p.ticker === ticker);
        if (!position) return null;

        const oldShares = position.shares;
        const oldCostBasis = position.avgCostBasis;

        // Adjust shares and cost basis
        const newShares = Math.floor(oldShares * ratio);

        // Guard against reverse splits resulting in 0 shares
        if (newShares <= 0) {
            console.error('Split would result in 0 shares, skipping');
            return null;
        }

        position.shares = newShares;
        position.avgCostBasis = ratio > 0 ? oldCostBasis / ratio : oldCostBasis;
        position.totalCostBasis = position.shares * position.avgCostBasis;

        // Update current price (also splits)
        position.currentPrice = ratio > 0 ? position.currentPrice / ratio : position.currentPrice;
        position.marketValue = position.shares * position.currentPrice;

        // Recalculate P&L with division by zero guard
        position.unrealizedPnL = (position.currentPrice - position.avgCostBasis) * position.shares;
        position.unrealizedPnLPercent = position.totalCostBasis > 0
            ? (position.unrealizedPnL / position.totalCostBasis)
            : 0;

        position.lastUpdated = Date.now();

        // Update historical trades for this ticker
        portfolio.trades.forEach(trade => {
            if (trade.ticker === ticker) {
                trade.shares = Math.floor(trade.shares * ratio);
                trade.price = ratio > 0 ? trade.price / ratio : trade.price;
                // totalValue stays the same
            }
        });

        const splitDetails: SplitDetails = {
            ratio,
            oldShares,
            newShares: position.shares,
            oldCostBasis,
            newCostBasis: position.avgCostBasis
        };

        const action: CorporateAction = {
            id: this.generateId(),
            ticker,
            type: 'SPLIT',
            effectiveDate: Date.now(),
            announcedDate: Date.now(),
            details: splitDetails,
            processed: true,
            processedAt: Date.now(),
            affectedPositions: [ticker]
        };

        portfolio.corporateActions.push(action);

        console.log(`Processed ${ratio}:1 split for ${ticker}: ${oldShares} → ${position.shares} shares`);

        return action;
    }

    processDividend(portfolio: AgentPortfolio, ticker: string, amountPerShare: number): CorporateAction | null {
        // Input validation
        if (!ticker || typeof ticker !== 'string') {
            console.error('Invalid ticker for dividend');
            return null;
        }
        if (!amountPerShare || amountPerShare <= 0 || !Number.isFinite(amountPerShare)) {
            console.error('Invalid dividend amount: must be positive number');
            return null;
        }

        const position = portfolio.positions.find(p => p.ticker === ticker);
        if (!position) return null;

        const totalDividend = position.shares * amountPerShare;
        portfolio.currentCash += totalDividend;
        // Note: Don't add to totalValue here - it will be recalculated from cash + positions

        const dividendDetails: DividendDetails = {
            amountPerShare,
            totalAmount: totalDividend,
            exDate: Date.now(),
            payDate: Date.now(),
            dividendType: 'CASH'
        };

        const action: CorporateAction = {
            id: this.generateId(),
            ticker,
            type: 'DIVIDEND',
            effectiveDate: Date.now(),
            announcedDate: Date.now(),
            details: dividendDetails,
            processed: true,
            processedAt: Date.now(),
            affectedPositions: [ticker]
        };

        portfolio.corporateActions.push(action);

        console.log(`Processed dividend for ${ticker}: ${totalDividend.toFixed(2)} (${position.shares} shares × ${amountPerShare})`);

        return action;
    }

    processTickerChange(portfolio: AgentPortfolio, oldTicker: string, newTicker: string): CorporateAction | null {
        // Input validation
        if (!oldTicker || typeof oldTicker !== 'string') {
            console.error('Invalid old ticker for ticker change');
            return null;
        }
        if (!newTicker || typeof newTicker !== 'string') {
            console.error('Invalid new ticker for ticker change');
            return null;
        }
        if (oldTicker === newTicker) {
            console.error('Old and new ticker are the same');
            return null;
        }

        const position = portfolio.positions.find(p => p.ticker === oldTicker);
        if (!position) return null;

        position.ticker = newTicker;
        position.lastUpdated = Date.now();

        // Update all trades
        portfolio.trades.forEach(trade => {
            if (trade.ticker === oldTicker) {
                trade.ticker = newTicker;
            }
        });

        const action: CorporateAction = {
            id: this.generateId(),
            ticker: oldTicker,
            type: 'TICKER_CHANGE',
            effectiveDate: Date.now(),
            announcedDate: Date.now(),
            details: {
                oldTicker,
                newTicker,
                reason: 'Corporate action'
            },
            processed: true,
            processedAt: Date.now(),
            affectedPositions: [oldTicker]
        };

        portfolio.corporateActions.push(action);

        console.log(`Processed ticker change: ${oldTicker} → ${newTicker}`);

        return action;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }
}

export const corporateActionsService = new CorporateActionsService();
