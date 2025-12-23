import { Request, Response, NextFunction } from 'express';
import { authService } from '../../services/auth/AuthService';
import { AuthenticationError } from '../../utils/errors';
import { JWTPayload } from '@hypothesis-arena/shared';

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            user?: JWTPayload;
            userId?: string;
        }
    }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new AuthenticationError('No token provided');
        }

        const token = authHeader.substring(7);
        const payload = authService.verifyToken(token);

        req.user = payload;
        req.userId = payload.userId;

        next();
    } catch (error) {
        next(error);
    }
}

export function optionalAuth(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const payload = authService.verifyToken(token);
            req.user = payload;
            req.userId = payload.userId;
        }

        next();
    } catch {
        // Ignore auth errors for optional auth
        next();
    }
}
