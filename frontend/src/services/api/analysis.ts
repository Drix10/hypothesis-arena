/**
 * Analysis API Service
 * 
 * Frontend service for AI-powered market analysis.
 */

import { apiClient } from './client';

export interface Analyst {
    id: string;
    name: string;
    emoji: string;
    style: string;
    description: string;
}

export interface AnalysisResult {
    analystId: string;
    analystName: string;
    analystEmoji: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;
    thesis: string;
    reasoning: string[];
    targetPrice?: number;
    stopLoss?: number;
    riskLevel: 'low' | 'medium' | 'high';
}

export interface DebateTurn {
    speaker: 'bull' | 'bear';
    analystName: string;
    argument: string;
    strength: number;
}

export interface DebateResult {
    turns: DebateTurn[];
    winner: 'bull' | 'bear' | 'draw';
    bullScore: number;
    bearScore: number;
    summary: string;
}

export interface TradingSignal {
    action: 'buy' | 'sell' | 'hold';
    confidence: number;
    reasoning: string;
}

export const analysisApi = {
    /**
     * Get all analyst personas
     */
    async getAnalysts(): Promise<Analyst[]> {
        const response = await apiClient.get<{ analysts: Analyst[] }>('/analysis/analysts');
        return response.analysts;
    },

    /**
     * Check if AI service is configured
     */
    async getStatus(): Promise<{ configured: boolean; analystsAvailable: number }> {
        return apiClient.get('/analysis/status');
    },

    /**
     * Generate analysis from a specific analyst
     */
    async generateAnalysis(symbol: string, analystId?: string): Promise<AnalysisResult> {
        const response = await apiClient.post<{ analysis: AnalysisResult }>(
            '/analysis/generate',
            { symbol, analystId }
        );
        return response.analysis;
    },

    /**
     * Generate analyses from all 8 analysts
     */
    async generateAllAnalyses(symbol: string): Promise<{
        symbol: string;
        analyses: AnalysisResult[];
        count: number;
    }> {
        return apiClient.post('/analysis/generate-all', { symbol });
    },

    /**
     * Generate a debate between two analysts
     */
    async generateDebate(
        symbol: string,
        bullAnalystId?: string,
        bearAnalystId?: string
    ): Promise<{
        symbol: string;
        bullAnalysis: AnalysisResult;
        bearAnalysis: AnalysisResult;
        debate: DebateResult;
    }> {
        return apiClient.post('/analysis/debate', {
            symbol,
            bullAnalystId,
            bearAnalystId,
        });
    },

    /**
     * Generate trading signal from all analysts (requires auth)
     */
    async generateSignal(symbol: string): Promise<{
        symbol: string;
        signal: TradingSignal;
        analysisCount: number;
        analyses: { analyst: string; recommendation: string; confidence: number }[];
    }> {
        return apiClient.post('/analysis/signal', { symbol });
    },

    /**
     * Get analysis history (requires auth)
     */
    async getHistory(symbol?: string, limit?: number): Promise<{ analyses: any[] }> {
        const params = new URLSearchParams();
        if (symbol) params.set('symbol', symbol);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        return apiClient.get(`/analysis/history${query ? `?${query}` : ''}`);
    },
};
