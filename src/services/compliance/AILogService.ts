import { v4 as uuid } from 'uuid';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { getWeexClient } from '../weex/WeexClient';

export interface AILogEntry {
    id: string;
    orderId?: string;
    stage: 'analysis' | 'decision' | 'execution' | 'review' | 'manual_close' | 'position_management';
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
    private lastRetryAttempt = 0;
    private readonly RETRY_INTERVAL_MS = 3600000; // 1 hour
    private retryInProgress = false; // FIXED: Prevent concurrent retries
    private lastLogCleanup = 0;
    private readonly LOG_CLEANUP_INTERVAL_MS = 86400000; // 24 hours

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

    /**
     * FIXED: Retry failed uploads periodically
     * Called automatically during createLog, or can be called manually
     * FIXED: Prevents concurrent retry operations
     */
    async retryFailedUploads(): Promise<void> {
        const now = Date.now();

        // FIXED: Check if retry is already in progress
        if (this.retryInProgress) {
            return;
        }

        if (now - this.lastRetryAttempt < this.RETRY_INTERVAL_MS) {
            return;
        }

        this.retryInProgress = true;
        this.lastRetryAttempt = now;

        try {
            // Get up to 10 failed logs from database
            const failedLogs = await prisma.aILog.findMany({
                where: { uploadedToWeex: false },
                take: 10,
                orderBy: { timestamp: 'asc' }
            });

            if (failedLogs.length === 0) {
                // Clear in-memory tracking if database shows no failures
                this.failedUploads.clear();
                return;
            }

            logger.info(`🔄 Retrying ${failedLogs.length} failed AI log uploads...`);

            for (const dbLog of failedLogs) {
                try {
                    // FIXED: Wrap JSON.parse in try-catch
                    let input: any;
                    let output: any;

                    try {
                        input = JSON.parse(dbLog.input);
                    } catch (parseError) {
                        logger.error(`Failed to parse input for log ${dbLog.id}, marking as uploaded to stop retries`);
                        await prisma.aILog.update({
                            where: { id: dbLog.id },
                            data: { uploadedToWeex: true }
                        });
                        continue;
                    }

                    try {
                        output = JSON.parse(dbLog.output);
                    } catch (parseError) {
                        logger.error(`Failed to parse output for log ${dbLog.id}, marking as uploaded to stop retries`);
                        await prisma.aILog.update({
                            where: { id: dbLog.id },
                            data: { uploadedToWeex: true }
                        });
                        continue;
                    }

                    // Reconstruct AILogEntry from database record
                    const log: AILogEntry = {
                        id: dbLog.id,
                        orderId: dbLog.orderId || undefined,
                        stage: this.mapPrismaStageToLogStage(dbLog.stage),
                        model: dbLog.model,
                        input,
                        output,
                        explanation: dbLog.explanation,
                        timestamp: dbLog.timestamp.getTime(),
                        uploadedToWeex: false
                    };

                    await this.uploadToWeex(log);
                    this.failedUploads.delete(dbLog.id);
                    logger.info(`✅ Retry successful for log ${dbLog.id}`);
                } catch (error) {
                    logger.warn(`Retry failed for log ${dbLog.id}:`, error instanceof Error ? error.message : String(error));
                }
            }
        } catch (error) {
            logger.error('Failed to retry uploads:', error);
        } finally {
            this.retryInProgress = false;
        }
    }

    /**
     * FIXED: Cleanup old AI logs to prevent database bloat
     * Keeps logs for 30 days, only deletes successfully uploaded logs
     */
    async cleanupOldLogs(): Promise<void> {
        const now = Date.now();
        if (now - this.lastLogCleanup < this.LOG_CLEANUP_INTERVAL_MS) {
            return;
        }

        try {
            // Keep logs for 30 days
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
            const deleted = await prisma.aILog.deleteMany({
                where: {
                    timestamp: { lt: thirtyDaysAgo },
                    uploadedToWeex: true // Only delete successfully uploaded logs
                }
            });

            this.lastLogCleanup = now;
            if (deleted.count > 0) {
                logger.info(`🧹 Cleaned up ${deleted.count} old AI logs`);
            }
        } catch (error) {
            logger.error('Failed to cleanup old AI logs:', error);
        }
    }

    /**
     * FIXED: Map Prisma enum back to AILogEntry stage
     */
    private mapPrismaStageToLogStage(prismaStage: string): AILogEntry['stage'] {
        const reverseMapping: Record<string, AILogEntry['stage']> = {
            'STRATEGY_GENERATION': 'analysis',
            'DECISION_MAKING': 'decision',
            'COLLABORATIVE_TRADE': 'execution',
            'RISK_ASSESSMENT': 'review',
            'MANUAL_CLOSE': 'manual_close',
            'POSITION_MANAGEMENT': 'position_management'
        };
        return reverseMapping[prismaStage] || 'decision';
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

        // CRITICAL FIX: Validate timestamp before use
        if (!Number.isFinite(log.timestamp) || log.timestamp < 0) {
            logger.error(`Invalid timestamp for AI log: ${log.timestamp}, using current time`);
            log.timestamp = Date.now();
        }

        // FIXED: Validate and sanitize model field
        if (!model || typeof model !== 'string' || model.trim().length === 0) {
            logger.warn(`Invalid model field: "${model}", using default`);
            model = 'unknown';
        }
        const MAX_MODEL_LENGTH = 100;
        if (model.length > MAX_MODEL_LENGTH) {
            model = model.substring(0, MAX_MODEL_LENGTH);
        }
        log.model = model;

        // FIXED: Validate and truncate explanation
        const MAX_EXPLANATION_LENGTH = 10000; // 10KB
        if (log.explanation && log.explanation.length > MAX_EXPLANATION_LENGTH) {
            logger.warn(`Explanation too long (${log.explanation.length} chars), truncating`);
            log.explanation = log.explanation.substring(0, MAX_EXPLANATION_LENGTH) + '... [truncated]';
        }

        // CRITICAL FIX: Map stage to Prisma enum values safely
        // Prisma schema uses: DECISION_MAKING, STRATEGY_GENERATION, RISK_ASSESSMENT, 
        // COLLABORATIVE_TRADE, POSITION_MANAGEMENT, MANUAL_CLOSE
        const stageMapping: Record<string, 'DECISION_MAKING' | 'STRATEGY_GENERATION' | 'RISK_ASSESSMENT' | 'COLLABORATIVE_TRADE' | 'POSITION_MANAGEMENT' | 'MANUAL_CLOSE'> = {
            'analysis': 'STRATEGY_GENERATION',
            'decision': 'DECISION_MAKING',
            'execution': 'COLLABORATIVE_TRADE',
            'review': 'RISK_ASSESSMENT',
            'manual_close': 'MANUAL_CLOSE',
            'position_management': 'POSITION_MANAGEMENT'
        };

        const prismaStage = stageMapping[log.stage] || 'DECISION_MAKING';

        try {
            // Safely serialize input/output with error handling for circular references
            let inputStr: string;
            let outputStr: string;

            try {
                inputStr = JSON.stringify(log.input);
                // FIXED: Check for very large JSON (>1MB)
                if (inputStr.length > 1048576) {
                    logger.warn(`AI log input too large (${inputStr.length} bytes), truncating`);
                    inputStr = JSON.stringify({
                        error: 'Input too large',
                        size: inputStr.length,
                        truncated: inputStr.substring(0, 1000) + '...'
                    });
                }
            } catch (error) {
                logger.warn('Failed to serialize AI log input, using fallback:', error);
                inputStr = JSON.stringify({ error: 'Serialization failed', type: typeof log.input });
            }

            try {
                outputStr = JSON.stringify(log.output);
                // FIXED: Check for very large JSON (>1MB)
                if (outputStr.length > 1048576) {
                    logger.warn(`AI log output too large (${outputStr.length} bytes), truncating`);
                    outputStr = JSON.stringify({
                        error: 'Output too large',
                        size: outputStr.length,
                        truncated: outputStr.substring(0, 1000) + '...'
                    });
                }
            } catch (error) {
                logger.warn('Failed to serialize AI log output, using fallback:', error);
                outputStr = JSON.stringify({ error: 'Serialization failed', type: typeof log.output });
            }

            // Save to database
            await prisma.aILog.create({
                data: {
                    id: log.id,
                    orderId: log.orderId || null, // FIXED: Convert undefined to null
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

        // FIXED: Trigger retry and cleanup only if not already running
        const now = Date.now();
        if (!this.retryInProgress && now - this.lastRetryAttempt > this.RETRY_INTERVAL_MS) {
            this.retryFailedUploads().catch(err => {
                logger.warn('Background retry failed:', err);
            });
        }

        // FIXED: Trigger cleanup periodically
        if (now - this.lastLogCleanup > this.LOG_CLEANUP_INTERVAL_MS) {
            this.cleanupOldLogs().catch(err => {
                logger.warn('Log cleanup failed:', err);
            });
        }

        logger.info(`AI log created: ${log.id}`, { stage, model });
        return log;
    }

    async uploadToWeex(log: AILogEntry): Promise<void> {
        try {
            // FIXED: Upload with objects (no re-serialization needed)
            // Note: idempotencyKey would be ideal but may not be supported by WEEX API
            const response = await getWeexClient().uploadAILog({
                orderId: log.orderId,
                stage: log.stage,
                model: log.model,
                input: log.input, // Already an object, no re-parsing needed
                output: log.output, // Already an object, no re-parsing needed
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
            // CRITICAL FIX: Log DB errors but don't rethrow - WEEX upload succeeded
            // Rethrowing would cause outer catch to mark upload as failed and retry
            try {
                await prisma.aILog.update({
                    where: { id: log.id },
                    data: {
                        uploadedToWeex: true,
                        weexLogId: weexLogId || null // Store logId if available, null otherwise
                    }
                });
            } catch (updateError: any) {
                // P2025: Record not found - already updated or deleted (ignore silently)
                if (updateError.code === 'P2025') {
                    // This is fine - log was already updated or deleted
                } else {
                    // Other DB errors: Log but DON'T rethrow
                    // WEEX upload succeeded, so we don't want to retry
                    logger.error(`Failed to update AI log ${log.id} in database after successful WEEX upload:`, {
                        error: updateError.message,
                        code: updateError.code,
                        logId: log.id,
                        weexLogId: weexLogId
                    });
                    // Continue execution - don't let DB error cause retry of successful upload
                }
            }

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
            } catch (updateError: any) {
                // Ignore "record not found" errors (P2025) - already updated or deleted
                if (updateError.code !== 'P2025') {
                    logger.error(`Failed to update AI log upload status in database: ${log.id}`, updateError);
                }
            }

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

            // Don't throw - log upload failure shouldn't block trading
            // But the error is logged and database reflects failed state for potential retry
        }
    }
}

export const aiLogService = new AILogService();
