import { v4 as uuid } from 'uuid';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { getWeexClient } from '../weex/WeexClient';

export interface AILogEntry {
    id: string;
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
    // Use singleton getter instead of storing reference
    // This ensures we always use the same instance and don't create memory leaks

    // FIXED: Track failed uploads for potential retry mechanism
    // This prevents silent failures and allows monitoring of upload health
    private failedUploads: Set<string> = new Set();
    private readonly MAX_FAILED_UPLOADS = 100; // Prevent unbounded growth

    /**
     * Get count of failed uploads (for monitoring)
     */
    getFailedUploadCount(): number {
        return this.failedUploads.size;
    }

    /**
     * Clear failed uploads tracking (for testing or manual retry)
     */
    clearFailedUploads(): void {
        this.failedUploads.clear();
    }

    async createLog(
        stage: AILogEntry['stage'],
        model: string,
        input: any,
        output: any,
        explanation: string,
        orderId?: string
    ): Promise<AILogEntry> {
        const log: AILogEntry = {
            id: uuid(),
            orderId,
            stage,
            model,
            input,
            output,
            explanation,
            timestamp: Date.now(),
            uploadedToWeex: false,
        };

        // CRITICAL FIX: Map stage to Prisma enum values safely
        // Prisma schema uses: DECISION_MAKING, STRATEGY_GENERATION, RISK_ASSESSMENT, 
        // COLLABORATIVE_TRADE, POSITION_MANAGEMENT, MANUAL_CLOSE
        const stageMapping: Record<string, 'DECISION_MAKING' | 'STRATEGY_GENERATION' | 'RISK_ASSESSMENT' | 'COLLABORATIVE_TRADE' | 'POSITION_MANAGEMENT' | 'MANUAL_CLOSE'> = {
            'analysis': 'STRATEGY_GENERATION',
            'decision': 'DECISION_MAKING',
            'execution': 'COLLABORATIVE_TRADE',
            'review': 'RISK_ASSESSMENT'
        };

        const prismaStage = stageMapping[log.stage] || 'DECISION_MAKING';

        try {
            // Safely serialize input/output with error handling for circular references
            let inputStr: string;
            let outputStr: string;

            try {
                inputStr = JSON.stringify(log.input);
            } catch (error) {
                logger.warn('Failed to serialize AI log input, using fallback:', error);
                inputStr = JSON.stringify({ error: 'Serialization failed', type: typeof log.input });
            }

            try {
                outputStr = JSON.stringify(log.output);
            } catch (error) {
                logger.warn('Failed to serialize AI log output, using fallback:', error);
                outputStr = JSON.stringify({ error: 'Serialization failed', type: typeof log.output });
            }

            // Save to database
            await prisma.aILog.create({
                data: {
                    id: log.id,
                    orderId: log.orderId,
                    stage: prismaStage,
                    model: log.model,
                    input: inputStr,
                    output: outputStr,
                    explanation: log.explanation,
                    timestamp: new Date(log.timestamp),
                    uploadedToWeex: log.uploadedToWeex
                }
            });
        } catch (error) {
            logger.error('Failed to save AI log to database:', error);
            // Don't throw - log creation failure shouldn't block trading
            // But we should still return the log object for in-memory tracking
        }

        // Upload to WEEX if order-related
        if (orderId) {
            await this.uploadToWeex(log);
        }

        logger.info(`AI log created: ${log.id}`, { stage, model });
        return log;
    }

    async uploadToWeex(log: AILogEntry): Promise<void> {
        try {
            // Use singleton getter - no need to store reference
            const response = await getWeexClient().uploadAILog({
                orderId: log.orderId,
                stage: log.stage,
                model: log.model,
                input: log.input,
                output: log.output,
                explanation: log.explanation,
            });

            // CRITICAL: Validate response before marking as uploaded
            // WEEX API should return a response with logId or success indicator
            if (!response || typeof response !== 'object') {
                const errorMsg = `WEEX upload returned invalid response for log ${log.id}: ${JSON.stringify(response)}`;
                logger.error(errorMsg);
                throw new Error(errorMsg);
            }

            // Check for success indicators in response
            // WEEX API may return: { logId: string } or { success: boolean, logId: string } or { code: string, data: { logId: string } }
            let weexLogId: string | undefined;
            let uploadSuccess = false;

            // Try to extract logId from various response formats
            if (typeof response === 'object') {
                // Direct logId field
                if (response.logId && typeof response.logId === 'string') {
                    weexLogId = response.logId;
                    uploadSuccess = true;
                }
                // Nested in data field
                else if (response.data && typeof response.data === 'object' && response.data.logId) {
                    weexLogId = response.data.logId;
                    uploadSuccess = true;
                }
                // Check explicit success field
                else if (response.success === true) {
                    uploadSuccess = true;
                    weexLogId = response.logId; // May be undefined, but upload succeeded
                }
                // Check for error code
                else if (response.code && response.code !== '0' && response.code !== '200') {
                    const errorMsg = `WEEX upload failed for log ${log.id}: code=${response.code}, msg=${response.msg || 'unknown'}`;
                    logger.error(errorMsg);
                    throw new Error(errorMsg);
                }
            }

            // If we couldn't determine success, fail safely
            if (!uploadSuccess && !weexLogId) {
                const errorMsg = `WEEX upload response missing success indicator or logId for log ${log.id}: ${JSON.stringify(response)}`;
                logger.error(errorMsg);
                throw new Error(errorMsg);
            }

            // Only update database if upload was successful
            await prisma.aILog.update({
                where: { id: log.id },
                data: {
                    uploadedToWeex: true,
                    weexLogId: weexLogId || null // Store logId if available, null otherwise
                }
            });

            // Update in-memory log object
            log.uploadedToWeex = true;
            log.weexLogId = weexLogId;

            logger.info(`AI log uploaded to WEEX: ${log.id}${weexLogId ? ` (logId: ${weexLogId})` : ''}`);
        } catch (error) {
            logger.error(`Failed to upload AI log to WEEX: ${log.id}`, error);

            // CRITICAL: Mark upload as failed in database for retry tracking
            try {
                await prisma.aILog.update({
                    where: { id: log.id },
                    data: {
                        uploadedToWeex: false,
                        weexLogId: null
                    }
                });

                // FIXED: Track failed upload for monitoring
                // Prevent unbounded growth by removing oldest if limit exceeded
                if (this.failedUploads.size >= this.MAX_FAILED_UPLOADS) {
                    // Remove oldest entry (first in Set)
                    const firstEntry = this.failedUploads.values().next().value;
                    if (firstEntry) {
                        this.failedUploads.delete(firstEntry);
                    }
                }
                this.failedUploads.add(log.id);
            } catch (dbError) {
                logger.error(`Failed to update AI log upload status in database: ${log.id}`, dbError);
            }

            // Don't throw - log upload failure shouldn't block trading
            // But the error is logged and database reflects failed state for potential retry
        }
    }
}

export const aiLogService = new AILogService();
