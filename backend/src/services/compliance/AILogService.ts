import { v4 as uuid } from 'uuid';
import { pool } from '../../config/database';
import { logger } from '../../utils/logger';
import { getWeexClient, WeexClient } from '../weex/WeexClient';

export interface AILogEntry {
    id: string;
    userId: string;
    orderId?: string;
    stage: 'analysis' | 'decision' | 'execution' | 'review';
    model: string;
    input: any;
    output: any;
    explanation: string;
    timestamp: number;
    uploadedToWeex: boolean;
    weexLogId?: string;
}

export class AILogService {
    private weexClient: WeexClient | null = null;

    private getWeexClient(): WeexClient {
        if (!this.weexClient) {
            this.weexClient = getWeexClient();
        }
        return this.weexClient;
    }

    async createLog(
        userId: string,
        stage: AILogEntry['stage'],
        model: string,
        input: any,
        output: any,
        explanation: string,
        orderId?: string
    ): Promise<AILogEntry> {
        const log: AILogEntry = {
            id: uuid(),
            userId,
            orderId,
            stage,
            model,
            input,
            output,
            explanation,
            timestamp: Date.now(),
            uploadedToWeex: false,
        };

        // Save to database
        await pool.query(
            `INSERT INTO ai_logs (
                id, user_id, order_id, stage, model, input, output,
                explanation, timestamp, uploaded_to_weex
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                log.id, log.userId, log.orderId, log.stage, log.model,
                JSON.stringify(log.input), JSON.stringify(log.output),
                log.explanation, new Date(log.timestamp), log.uploadedToWeex
            ]
        );

        // Upload to WEEX if order-related
        if (orderId) {
            await this.uploadToWeex(log);
        }

        logger.info(`AI log created: ${log.id}`, { stage, model });
        return log;
    }

    async uploadToWeex(log: AILogEntry): Promise<void> {
        try {
            const response = await this.getWeexClient().uploadAILog({
                orderId: log.orderId,
                stage: log.stage,
                model: log.model,
                input: log.input,
                output: log.output,
                explanation: log.explanation,
            });

            // Update log with WEEX response
            await pool.query(
                `UPDATE ai_logs 
                 SET uploaded_to_weex = true, weex_log_id = $1 
                 WHERE id = $2`,
                [response?.logId, log.id]
            );

            log.uploadedToWeex = true;
            log.weexLogId = response?.logId;

            logger.info(`AI log uploaded to WEEX: ${log.id}`);
        } catch (error) {
            logger.error(`Failed to upload AI log to WEEX: ${log.id}`, error);
            // Don't throw - log upload failure shouldn't block trading
        }
    }
}

export const aiLogService = new AILogService();
