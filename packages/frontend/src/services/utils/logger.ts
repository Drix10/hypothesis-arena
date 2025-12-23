/**
 * Simple logging utility with levels
 * In production, these could be sent to a logging service
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const isDevelopment = process.env.NODE_ENV !== 'production';

class Logger {
    private shouldLog(level: LogLevel): boolean {
        if (isDevelopment) return true;
        // In production, only log warnings and errors
        return level === 'warn' || level === 'error';
    }

    /**
     * Sanitize error objects to remove sensitive data in production
     */
    private sanitizeError(error: any): any {
        if (!error || typeof error !== 'object') return error;

        // Create shallow copy to avoid mutating original
        const sanitized = { ...error };

        // Remove sensitive fields
        const sensitiveFields = ['apiKey', 'token', 'password', 'secret', 'authorization', 'cookie'];
        sensitiveFields.forEach(field => {
            if (field in sanitized) {
                delete sanitized[field];
            }
        });

        // Sanitize nested objects
        if (sanitized.config && typeof sanitized.config === 'object') {
            const configCopy = { ...sanitized.config };
            sensitiveFields.forEach(field => delete configCopy[field]);
            sanitized.config = configCopy;
        }

        return sanitized;
    }

    debug(message: string, ...args: any[]): void {
        if (this.shouldLog('debug')) {
            console.debug(`[DEBUG] ${message}`, ...args);
        }
    }

    info(message: string, ...args: any[]): void {
        if (this.shouldLog('info')) {
            console.info(`[INFO] ${message}`, ...args);
        }
    }

    warn(message: string, ...args: any[]): void {
        if (this.shouldLog('warn')) {
            console.warn(`[WARN] ${message}`, ...args);
        }
    }

    error(message: string, error?: any, ...args: any[]): void {
        if (this.shouldLog('error')) {
            // Sanitize error objects in production
            const sanitizedError = isDevelopment ? error : this.sanitizeError(error);
            const sanitizedArgs = isDevelopment ? args : args.map(arg => this.sanitizeError(arg));

            console.error(`[ERROR] ${message}`, sanitizedError, ...sanitizedArgs);

            // In production, you could send to error tracking service
            // e.g., Sentry, LogRocket, etc.
        }
    }
}

export const logger = new Logger();
