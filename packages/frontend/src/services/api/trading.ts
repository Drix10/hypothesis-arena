/**
 * Trading API Service
 * 
 * All trading operations go through the backend API.
 */

import { apiClient, ApiError } from './client';
import { logger } from '../utils/logger';
import type { TradeDecision, Trade, Portfolio, Position } from '@hypothesis-arena/shared';

interface PortfolioSummaryResponse {
    portfolios: Portfolio[];
    summary: {
        totalValue: number;
        totalReturn: number;
        portfolioCount: number;
    };
}

interface PositionsResponse {
    positions: Position[];
}

interface ManualTradeRequest {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    amount: number;
    price?: number;
    leverage?: number;
}

interface ManualTradeResponse {
    orderId: string;
    symbol: string;
    side: string;
    amount: number;
    price: number;
    status: string;
}

export const tradingApi = {
    async executeTrade(decision: TradeDecision): Promise<Trade> {
        return apiClient.post<Trade>('/trading/execute', decision);
    },

    async getPortfolio(agentId: string): Promise<Portfolio> {
        return apiClient.get<Portfolio>(`/portfolio/${agentId}`);
    },

    async getPortfolioSummary(): Promise<PortfolioSummaryResponse> {
        return apiClient.get<PortfolioSummaryResponse>('/portfolio/summary');
    },

    async getPositions(agentId: string): Promise<Position[]> {
        const response = await apiClient.get<PositionsResponse>(`/portfolio/${agentId}/positions`);
        return response.positions;
    },

    async createPortfolio(agentName: string, initialBalance?: number): Promise<Portfolio> {
        return apiClient.post<Portfolio>('/portfolio/create', { agentName, initialBalance });
    },
};

/**
 * Execute a manual trade (for user trading, not AI)
 * 
 * CRITICAL FIX: Backend requires portfolioId but manual trades don't have one.
 * This function now fetches or creates a default portfolio for the user.
 */
export async function executeTrade(request: ManualTradeRequest): Promise<ManualTradeResponse> {
    // Get or create user's default portfolio
    let portfolioId: string;

    try {
        // Try to get existing portfolios
        const portfolioSummary = await tradingApi.getPortfolioSummary();

        if (portfolioSummary.portfolios.length > 0) {
            // FIXED: Prefer active portfolio, but validate it exists
            const activePortfolio = portfolioSummary.portfolios.find(p => p.status === 'active');
            if (activePortfolio) {
                portfolioId = activePortfolio.id;
            } else {
                // No active portfolio - create a new one instead of using inactive
                logger.warn('No active portfolio found, creating new one for manual trading');
                const newPortfolio = await tradingApi.createPortfolio('Manual Trading', 10000);
                portfolioId = newPortfolio.id;
            }
        } else {
            // Create default portfolio for manual trading
            const newPortfolio = await tradingApi.createPortfolio('Manual Trading', 10000);
            portfolioId = newPortfolio.id;
        }
    } catch (error: unknown) {
        // Preserve error context for debugging
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to get or create trading portfolio: ${errorMessage}`);
    }

    // Validate inputs
    if (!request.symbol || request.amount <= 0) {
        throw new Error('Invalid trade parameters');
    }

    if (request.type === 'LIMIT' && (!request.price || request.price <= 0)) {
        throw new Error('Limit orders require a valid price');
    }

    // Validate leverage - must be a positive finite number between 1 and 5
    const leverage = request.leverage ?? 1;
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 5) {
        throw new Error('Leverage must be between 1x and 5x');
    }

    // Execute trade with portfolioId and leverage
    // IMPORTANT: Leverage defaults to 1x (no leverage) for safety
    // Users should explicitly set leverage based on their risk tolerance
    // Higher leverage (2x-5x) increases both potential gains AND losses
    const trade = await apiClient.post<Trade>('/trading/execute', {
        portfolioId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        size: request.amount,
        price: request.price,
        leverage: leverage,
        confidence: 100,
        reason: 'Manual trade executed by user',
    });

    return {
        orderId: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        amount: trade.size,
        price: trade.price,
        status: trade.status,
    };
}

export { ApiError };
