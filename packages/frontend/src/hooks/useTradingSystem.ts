/**
 * Trading System Hook
 * 
 * React hook for managing trading system state and operations
 */

import { useState, useEffect, useCallback } from 'react';
import { TradingSystemState, TradeDecision, AgentPortfolio } from '../types/trading';
import { InvestmentThesis, StockDebate } from '../types/stock';
import { tradingService } from '../services/trading';

export const useTradingSystem = () => {
    const [tradingState, setTradingState] = useState<TradingSystemState | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Initialize trading system
    useEffect(() => {
        try {
            let state = tradingService.loadTradingState();
            if (!state) {
                state = tradingService.initializeTradingSystem();
            }
            setTradingState(state);
            setIsLoading(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to initialize trading system');
            setIsLoading(false);
        }
    }, []);

    // Reload trading state
    const reloadState = useCallback(() => {
        try {
            const state = tradingService.loadTradingState();
            if (state) {
                setTradingState(state);
                setError(null); // Clear error on successful reload
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to reload trading state');
        }
    }, []);

    // Generate trade decisions
    const generateTradeDecisions = useCallback(async (
        _ticker: string,
        currentPrice: number,
        priceTimestamp: number,
        theses: InvestmentThesis[],
        debates: StockDebate[]
    ): Promise<Map<string, TradeDecision>> => {
        // Always fetch fresh state to avoid stale closures
        const freshState = tradingService.loadTradingState();
        if (!freshState) {
            throw new Error('Trading system not initialized');
        }

        const decisions = new Map<string, TradeDecision>();

        for (const thesis of theses) {
            const portfolio = freshState.portfolios[thesis.agentId];
            if (!portfolio) continue;

            // Find the debate where this agent participated (as bull or bear)
            const debate = debates.find(d =>
                d.bullThesis.agentId === thesis.agentId || d.bearThesis.agentId === thesis.agentId
            );

            if (!debate) continue;

            try {
                const decision = await tradingService.determineTradeDecision(
                    thesis,
                    debate,
                    portfolio,
                    currentPrice,
                    priceTimestamp
                );

                decisions.set(thesis.agentId, decision);
            } catch (err) {
                console.error(`Failed to generate decision for ${thesis.agentId}:`, err);
                // Continue with other agents even if one fails
            }
        }

        return decisions;
    }, []); // Empty deps - always fetch fresh state

    // Execute trades
    const executeTrades = useCallback(async (
        decisions: Map<string, TradeDecision>
    ): Promise<{ success: number; failed: number; errors: string[] }> => {
        // Always fetch fresh state to avoid stale closures
        const freshState = tradingService.loadTradingState();
        if (!freshState) {
            throw new Error('Trading system not initialized');
        }

        let success = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const [agentId, decision] of decisions) {
            if (decision.action === 'HOLD' || !decision.isValid) continue;

            const portfolio = freshState.portfolios[agentId];
            if (!portfolio) {
                errors.push(`Portfolio not found for agent ${agentId}`);
                failed++;
                continue;
            }

            try {
                const trade = await tradingService.executeTrade(portfolio, decision, freshState);
                if (trade) {
                    success++;
                } else {
                    errors.push(`Trade returned null for ${agentId}`);
                    failed++;
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : 'Unknown error';
                console.error(`Failed to execute trade for ${agentId}:`, err);
                errors.push(`${agentId}: ${errorMsg}`);
                failed++;
            }
        }

        // Reload state after trades
        reloadState();

        return { success, failed, errors };
    }, [reloadState]); // Only depend on reloadState

    // Reset all portfolios
    const resetPortfolios = useCallback(() => {
        const state = tradingService.initializeTradingSystem();
        setTradingState(state);
    }, []);

    // Export data
    const exportData = useCallback(() => {
        if (!tradingState) return null;
        return tradingService.exportTradingData(tradingState);
    }, [tradingState]);

    // Import data
    const importData = useCallback(async (jsonData: string) => {
        try {
            const state = await tradingService.importTradingData(jsonData);
            if (state) {
                setTradingState(state);
                setError(null); // Clear error on successful import
                return true;
            }
            return false;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to import data');
            return false;
        }
    }, []);

    // Get portfolio by agent ID
    const getPortfolio = useCallback((agentId: string): AgentPortfolio | null => {
        if (!tradingState) return null;
        return tradingState.portfolios[agentId] || null;
    }, [tradingState]);

    // Get all portfolios
    const getAllPortfolios = useCallback((): AgentPortfolio[] => {
        if (!tradingState) return [];
        return Object.values(tradingState.portfolios);
    }, [tradingState]);

    return {
        tradingState,
        isLoading,
        error,
        reloadState,
        generateTradeDecisions,
        executeTrades,
        resetPortfolios,
        exportData,
        importData,
        getPortfolio,
        getAllPortfolios
    };
};
