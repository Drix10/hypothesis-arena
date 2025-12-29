export class AppError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        public code?: string,
        public isOperational: boolean = true
    ) {
        super(message);
        this.name = 'AppError';
        Error.captureStackTrace(this, this.constructor);
    }
}

export class ValidationError extends AppError {
    constructor(message: string, public errors?: Record<string, string>) {
        super(400, message, 'VALIDATION_ERROR');
        this.name = 'ValidationError';
    }
}

export class AuthenticationError extends AppError {
    constructor(message: string = 'Authentication required') {
        super(401, message, 'AUTHENTICATION_ERROR');
        this.name = 'AuthenticationError';
    }
}

export class AuthorizationError extends AppError {
    constructor(message: string = 'Access denied') {
        super(403, message, 'AUTHORIZATION_ERROR');
        this.name = 'AuthorizationError';
    }
}

export class NotFoundError extends AppError {
    constructor(resource: string = 'Resource') {
        super(404, `${resource} not found`, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super(409, message, 'CONFLICT');
        this.name = 'ConflictError';
    }
}

export class RateLimitError extends AppError {
    constructor(message: string = 'Too many requests') {
        super(429, message, 'RATE_LIMIT');
        this.name = 'RateLimitError';
    }
}

export class WeexApiError extends AppError {
    constructor(
        public weexCode: string,
        message: string
    ) {
        super(502, message, `WEEX_${weexCode}`);
        this.name = 'WeexApiError';
    }
}

export class TradingError extends AppError {
    constructor(message: string, code: string) {
        super(400, message, code);
        this.name = 'TradingError';
    }
}
