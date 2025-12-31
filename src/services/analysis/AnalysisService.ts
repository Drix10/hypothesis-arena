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

export class AnalysisService {
    /**
     * Get recent analyses with optional symbol filter
     * 
     * NOTE: The 'analyses' table doesn't exist in the Prisma schema.
     * This method returns an empty array until the analyses table is added to the schema.
     * Kept for backward compatibility with existing API routes.
     */
    async getRecentAnalyses(_symbol?: string, _limit: number = 20): Promise<Analysis[]> {
        logger.debug('getRecentAnalyses called but analyses table does not exist in schema');
        return [];
    }
}

export const analysisService = new AnalysisService();
