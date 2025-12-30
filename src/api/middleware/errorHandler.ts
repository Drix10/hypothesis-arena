import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { AppError, ValidationError } from '../../utils/errors';
import { config } from '../../config';

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    // Log error
    logger.error('Error:', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
    });

    // Handle known errors
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
            ...(err instanceof ValidationError && { errors: err.errors }),
        });
        return;
    }

    // Handle Zod validation errors
    if (err.name === 'ZodError') {
        res.status(400).json({
            error: 'Validation error',
            code: 'VALIDATION_ERROR',
            errors: (err as any).errors,
        });
        return;
    }

    // Handle JWT errors
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        res.status(401).json({
            error: 'Invalid or expired token',
            code: 'AUTHENTICATION_ERROR',
        });
        return;
    }

    // Handle unknown errors
    const statusCode = 500;
    const message = config.nodeEnv === 'production'
        ? 'Internal server error'
        : err.message;

    res.status(statusCode).json({
        error: message,
        code: 'INTERNAL_ERROR',
        ...(config.nodeEnv !== 'production' && { stack: err.stack }),
    });
}

export function notFoundHandler(req: Request, res: Response): void {
    res.status(404).json({
        error: 'Not found',
        code: 'NOT_FOUND',
        path: req.path,
    });
}
