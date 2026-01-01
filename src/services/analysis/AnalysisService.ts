/**
 * Analysis Service
 * 
 * NOTE: This service is a placeholder. The 'analyses' table doesn't exist in the Prisma schema.
 * The getRecentAnalyses method returns an empty array for API compatibility.
 * 
 * If analysis history is needed in the future:
 * 1. Add an 'Analysis' model to prisma/schema.prisma
 * 2. Run prisma migrate dev
 * 3. Implement actual database queries here
 */

import { logger } from '../../utils/logger';

export interface Analysis {
    id: string;
    symbol: string;
    agentId: string;
    agentName: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;
    thesis: string;
    reasoning: string[];
    targetPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    timeHorizon: string;
    riskLevel: 'low' | 'medium' | 'high';
    createdAt: number;
    expiresAt: number;
}

class AnalysisService {
    /**
     * Get recent analyses - returns empty array (table doesn't exist)
     * Kept for backward compatibility with /api/analysis/history endpoint
     */
    async getRecentAnalyses(_symbol?: string, _limit: number = 20): Promise<Analysis[]> {
        logger.debug('getRecentAnalyses: analyses table not implemented');
        return [];
    }
}

export const analysisService = new AnalysisService();
