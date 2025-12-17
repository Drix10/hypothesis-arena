/**
 * Retry utility with exponential backoff
 */
import { logger } from './logger';

interface RetryOptions {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
    shouldRetry?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    shouldRetry: (error: any) => {
        // Retry on network errors or 5xx server errors
        if (error.name === 'AbortError') return false;
        if (error.message?.includes('API key')) return false;
        return true;
    },
};

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: any;
    let delay = opts.initialDelay;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // Don't retry if we shouldn't or if it's the last attempt
            if (!opts.shouldRetry(error) || attempt === opts.maxRetries) {
                throw error;
            }

            // Add random jitter to prevent thundering herd problem
            // Jitter is ±25% of the delay, clamped to minimum of 100ms
            const jitter = delay * 0.25 * (Math.random() * 2 - 1);
            const delayWithJitter = Math.max(100, delay + jitter);

            // Wait before retrying
            logger.warn(
                `Attempt ${attempt + 1} failed, retrying in ${Math.round(delayWithJitter)}ms...`,
                error.message
            );
            await sleep(delayWithJitter);

            // Exponential backoff with max delay cap
            delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
        }
    }

    throw lastError;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: any): boolean {
    // Network errors
    if (error.message?.includes('fetch')) return true;
    if (error.message?.includes('network')) return true;

    // Rate limiting
    if (error.status === 429) return true;

    // Server errors
    if (error.status >= 500) return true;

    return false;
}
