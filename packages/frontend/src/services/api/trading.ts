/**
 * Trading API Service
 * 
 * All trading operations go through the backend API.
 */

import { apiClient, ApiError } from './client';
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

export { ApiError };
