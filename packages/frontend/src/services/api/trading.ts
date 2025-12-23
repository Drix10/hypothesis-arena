import { apiClient, ApiError } from './client';
import type { TradeDecision, Trade, Portfolio, Position } from '@hypothesis-arena/shared';

const TRADING_MODE_KEY = 'trading_mode';

let cachedMode: 'paper' | 'live' | null = null;

const getTradingMode = (): 'paper' | 'live' => {
    if (cachedMode === null) {
        const stored = localStorage.getItem(TRADING_MODE_KEY);
        cachedMode = stored === 'live' ? 'live' : 'paper';
    }
    return cachedMode;
};

const isLiveTrading = (): boolean => getTradingMode() === 'live';

// Dynamic import for paper trading service (only load when needed)
let paperTradingService: any = null;

const getPaperTradingService = async () => {
    if (!paperTradingService) {
        const module = await import('../trading/tradingService');
        paperTradingService = module.tradingService;
    }
    return paperTradingService;
};

export const tradingAdapter = {
    async executeTrade(decision: TradeDecision): Promise<Trade | null> {
        const mode = getTradingMode();

        if (mode === 'live') {
            try {
                return await apiClient.post<Trade>('/trading/execute', decision);
            } catch (error) {
                if (error instanceof ApiError) {
                    console.error(`Trade execution failed: ${error.message}`, {
                        status: error.status,
                        code: error.code,
                    });
                }
                throw error;
            }
        }

        // Paper mode
        try {
            const service = await getPaperTradingService();
            const state = service.loadTradingState();
            const portfolio = state.portfolios[decision.thesisId];

            if (!portfolio) {
                throw new Error(`Portfolio not found for agent: ${decision.thesisId}`);
            }

            return await service.executeTrade(portfolio, decision, state);
        } catch (error) {
            console.error('Paper trade execution failed:', error);
            throw error;
        }
    },

    async getPortfolio(agentId: string): Promise<Portfolio> {
        if (isLiveTrading()) {
            return apiClient.get<Portfolio>(`/portfolio/${agentId}`);
        }

        const service = await getPaperTradingService();
        const state = service.loadTradingState();
        const portfolio = state.portfolios[agentId];

        if (!portfolio) {
            throw new Error(`Portfolio not found for agent: ${agentId}`);
        }

        return portfolio;
    },

    async getAllPortfolios(): Promise<Record<string, Portfolio>> {
        if (isLiveTrading()) {
            return apiClient.get<Record<string, Portfolio>>('/portfolio');
        }

        const service = await getPaperTradingService();
        const state = service.loadTradingState();
        return state.portfolios;
    },

    async getPositions(agentId: string): Promise<Position[]> {
        if (isLiveTrading()) {
            return apiClient.get<Position[]>(`/portfolio/${agentId}/positions`);
        }

        const service = await getPaperTradingService();
        const state = service.loadTradingState();
        const portfolio = state.portfolios[agentId];

        return portfolio?.positions || [];
    },

    async getTradeHistory(agentId: string, limit?: number): Promise<Trade[]> {
        if (isLiveTrading()) {
            const params = limit ? `?limit=${limit}` : '';
            return apiClient.get<Trade[]>(`/portfolio/${agentId}/trades${params}`);
        }

        const service = await getPaperTradingService();
        const state = service.loadTradingState();
        const portfolio = state.portfolios[agentId];
        const trades = portfolio?.trades || [];

        return limit ? trades.slice(-limit) : trades;
    },

    async getLeaderboard(): Promise<Portfolio[]> {
        if (isLiveTrading()) {
            return apiClient.get<Portfolio[]>('/leaderboard');
        }

        const service = await getPaperTradingService();
        const state = service.loadTradingState();
        return (Object.values(state.portfolios) as Portfolio[])
            .sort((a, b) => b.totalReturn - a.totalReturn);
    },

    setTradingMode(mode: 'paper' | 'live') {
        localStorage.setItem(TRADING_MODE_KEY, mode);
        cachedMode = mode;
    },

    getTradingMode,

    isLiveTrading,

    clearCache() {
        cachedMode = null;
    },
};

export { ApiError };
