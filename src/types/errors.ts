/**
 * Error Types for Better Error Tracking
 * 
 * Categorizes errors for improved debugging and user feedback
 */

export enum ErrorType {
    // API Errors
    API_KEY_MISSING = 'API_KEY_MISSING',
    API_RATE_LIMIT = 'API_RATE_LIMIT',
    API_NETWORK = 'API_NETWORK',
    API_TIMEOUT = 'API_TIMEOUT',
    API_INVALID_RESPONSE = 'API_INVALID_RESPONSE',

    // Validation Errors
    VALIDATION_FILE_TOO_LARGE = 'VALIDATION_FILE_TOO_LARGE',
    VALIDATION_INVALID_FILE_TYPE = 'VALIDATION_INVALID_FILE_TYPE',
    VALIDATION_MISSING_INPUT = 'VALIDATION_MISSING_INPUT',
    VALIDATION_INVALID_JSON = 'VALIDATION_INVALID_JSON',

    // Tournament Errors
    TOURNAMENT_AGENT_GENERATION_FAILED = 'TOURNAMENT_AGENT_GENERATION_FAILED',
    TOURNAMENT_MATCH_FAILED = 'TOURNAMENT_MATCH_FAILED',
    TOURNAMENT_BRIEF_GENERATION_FAILED = 'TOURNAMENT_BRIEF_GENERATION_FAILED',
    TOURNAMENT_INVALID_WINNER = 'TOURNAMENT_INVALID_WINNER',

    // Storage Errors
    STORAGE_QUOTA_EXCEEDED = 'STORAGE_QUOTA_EXCEEDED',
    STORAGE_DISABLED = 'STORAGE_DISABLED',
    STORAGE_CORRUPTED = 'STORAGE_CORRUPTED',

    // Component Errors
    COMPONENT_UNMOUNTED = 'COMPONENT_UNMOUNTED',
    COMPONENT_RENDER_ERROR = 'COMPONENT_RENDER_ERROR',

    // Generic
    UNKNOWN = 'UNKNOWN'
}

/**
 * Custom error class with type categorization
 */
export class TypedError extends Error {
    constructor(
        public type: ErrorType,
        message: string,
        public originalError?: Error
    ) {
        super(message);
        this.name = 'TypedError';

        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TypedError);
        }
    }

    /**
     * Get user-friendly error message
     */
    getUserMessage(): string {
        switch (this.type) {
            case ErrorType.API_KEY_MISSING:
                return 'API key not configured. Please add your Gemini API key to .env.local';

            case ErrorType.API_RATE_LIMIT:
                return 'API rate limit exceeded. Please wait a moment and try again.';

            case ErrorType.API_NETWORK:
                return 'Network error. Please check your internet connection.';

            case ErrorType.API_TIMEOUT:
                return 'Request timed out. Please try again.';

            case ErrorType.VALIDATION_FILE_TOO_LARGE:
                return 'File is too large. Maximum size is 20MB.';

            case ErrorType.VALIDATION_INVALID_FILE_TYPE:
                return 'Invalid file type. Supported: PDF, PNG, JPG, TXT.';

            case ErrorType.STORAGE_QUOTA_EXCEEDED:
                return 'Browser storage is full. Please clear some space or export your tournament.';

            case ErrorType.STORAGE_DISABLED:
                return 'Browser storage is disabled. Please enable cookies and local storage.';

            case ErrorType.TOURNAMENT_AGENT_GENERATION_FAILED:
                return 'Failed to generate research agents. Please try again.';

            case ErrorType.TOURNAMENT_MATCH_FAILED:
                return 'Match simulation failed. Please try again.';

            case ErrorType.TOURNAMENT_BRIEF_GENERATION_FAILED:
                return 'Failed to generate research brief. Please try again.';

            default:
                return this.message || 'An unexpected error occurred. Please try again.';
        }
    }

    /**
     * Check if error is retryable
     */
    isRetryable(): boolean {
        const retryableTypes = [
            ErrorType.API_NETWORK,
            ErrorType.API_TIMEOUT,
            ErrorType.API_RATE_LIMIT,
            ErrorType.API_INVALID_RESPONSE,
        ];

        return retryableTypes.includes(this.type);
    }
}

/**
 * Helper to create typed errors
 */
export function createError(type: ErrorType, message: string, originalError?: Error): TypedError {
    return new TypedError(type, message, originalError);
}

/**
 * Helper to wrap unknown errors
 */
export function wrapError(error: unknown, defaultType: ErrorType = ErrorType.UNKNOWN): TypedError {
    if (error instanceof TypedError) {
        return error;
    }

    if (error instanceof Error) {
        return new TypedError(defaultType, error.message, error);
    }

    return new TypedError(defaultType, String(error));
}
