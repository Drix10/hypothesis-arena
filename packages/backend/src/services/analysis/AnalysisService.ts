import { v4 as uuid } from 'uuid';
import { pool } from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { aiLogService } from '../compliance/AILogService';

export interface Analysis {
    id: string;
    userId: string;
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

export interface DebateResult {
    id: string;
    analysisIds: string[];
    winner: 'bull' | 'bear' | 'draw';
    bullScore: number;
    bearScore: number;
    summary: string;
    createdAt: number;
}

export class AnalysisService {
    private readonly CACHE_TTL = 300; // 5 minutes

    async createAnalysis(
        userId: string,
        symbol: string,
        agentId: string,
        agentName: string,
        analysisData: Partial<Analysis>
    ): Promise<Analysis> {
        const analysis: Analysis = {
            id: uuid(),
            userId,
            symbol,
            agentId,
            agentName,
            recommendation: analysisData.recommendation || 'hold',
            confidence: analysisData.confidence || 50,
            thesis: analysisData.thesis || '',
            reasoning: analysisData.reasoning || [],
            targetPrice: analysisData.targetPrice,
            stopLoss: analysisData.stopLoss,
            takeProfit: analysisData.takeProfit,
            timeHorizon: analysisData.timeHorizon || '1-3 months',
            riskLevel: analysisData.riskLevel || 'medium',
            createdAt: Date.now(),
            expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
        };

        // Save to database
        await pool.query(
            `INSERT INTO analyses (
                id, user_id, symbol, agent_id, agent_name, recommendation,
                confidence, thesis, reasoning, target_price, stop_loss,
                take_profit, time_horizon, risk_level, created_at, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
                analysis.id, analysis.userId, analysis.symbol, analysis.agentId,
                analysis.agentName, analysis.recommendation, analysis.confidence,
                analysis.thesis, JSON.stringify(analysis.reasoning), analysis.targetPrice,
                analysis.stopLoss, analysis.takeProfit, analysis.timeHorizon,
                analysis.riskLevel, new Date(analysis.createdAt), new Date(analysis.expiresAt)
            ]
        );

        // Log for compliance
        await aiLogService.createLog(
            userId,
            'analysis',
            agentId,
            { symbol, agentId },
            analysis,
            `${agentName} analysis: ${analysis.recommendation} with ${analysis.confidence}% confidence`
        );

        // Cache
        const redis = await getRedisClient();
        await redis.setEx(
            `analysis:${analysis.id}`,
            this.CACHE_TTL,
            JSON.stringify(analysis)
        );

        logger.info(`Analysis created: ${analysis.id}`, { symbol, agentId, recommendation: analysis.recommendation });
        return analysis;
    }

    async getAnalysis(analysisId: string): Promise<Analysis | null> {
        // Check cache
        const redis = await getRedisClient();
        const cached = await redis.get(`analysis:${analysisId}`);
        if (cached) {
            return JSON.parse(cached);
        }

        // Query database
        const result = await pool.query(
            `SELECT * FROM analyses WHERE id = $1`,
            [analysisId]
        );

        if (result.rows.length === 0) return null;

        const analysis = this.mapRowToAnalysis(result.rows[0]);

        // Cache for future requests
        await redis.setEx(
            `analysis:${analysisId}`,
            this.CACHE_TTL,
            JSON.stringify(analysis)
        );

        return analysis;
    }

    async getRecentAnalyses(userId: string, symbol?: string, limit: number = 20): Promise<Analysis[]> {
        let query = `SELECT * FROM analyses WHERE user_id = $1`;
        const params: any[] = [userId];

        if (symbol) {
            query += ` AND symbol = $2`;
            params.push(symbol);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await pool.query(query, params);
        return result.rows.map(this.mapRowToAnalysis);
    }

    async saveDebateResult(
        userId: string,
        analysisIds: string[],
        winner: 'bull' | 'bear' | 'draw',
        bullScore: number,
        bearScore: number,
        summary: string
    ): Promise<DebateResult> {
        const debate: DebateResult = {
            id: uuid(),
            analysisIds,
            winner,
            bullScore,
            bearScore,
            summary,
            createdAt: Date.now(),
        };

        await pool.query(
            `INSERT INTO debates (
                id, user_id, analysis_ids, winner, bull_score, bear_score,
                summary, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                debate.id, userId, JSON.stringify(analysisIds), winner,
                bullScore, bearScore, summary, new Date(debate.createdAt)
            ]
        );

        // Log for compliance
        await aiLogService.createLog(
            userId,
            'decision',
            'debate-system',
            { analysisIds, bullScore, bearScore },
            debate,
            `Debate result: ${winner} wins (${bullScore} vs ${bearScore})`
        );

        logger.info(`Debate saved: ${debate.id}`, { winner, bullScore, bearScore });
        return debate;
    }

    private mapRowToAnalysis(row: any): Analysis {
        return {
            id: row.id,
            userId: row.user_id,
            symbol: row.symbol,
            agentId: row.agent_id,
            agentName: row.agent_name,
            recommendation: row.recommendation,
            confidence: parseFloat(row.confidence),
            thesis: row.thesis,
            reasoning: typeof row.reasoning === 'string' ? JSON.parse(row.reasoning) : row.reasoning,
            targetPrice: row.target_price ? parseFloat(row.target_price) : undefined,
            stopLoss: row.stop_loss ? parseFloat(row.stop_loss) : undefined,
            takeProfit: row.take_profit ? parseFloat(row.take_profit) : undefined,
            timeHorizon: row.time_horizon,
            riskLevel: row.risk_level,
            createdAt: new Date(row.created_at).getTime(),
            expiresAt: new Date(row.expires_at).getTime(),
        };
    }
}

export const analysisService = new AnalysisService();
