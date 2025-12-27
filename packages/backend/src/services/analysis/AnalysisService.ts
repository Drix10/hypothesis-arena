import { pool } from '../../config/database';

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

export class AnalysisService {
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
