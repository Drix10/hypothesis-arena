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

// In-memory store for short-lived SSE tokens
// In production, use Redis for multi-instance support
const sseTokens = new Map<string, { userId: string; expiresAt: number }>();
const MAX_SSE_TOKENS = 10000; // Prevent unbounded growth

// Track cleanup interval for proper shutdown
let cleanupInterval: NodeJS.Timeout | null = null;

// Clean up expired tokens periodically
function startTokenCleanup(): void {
    if (cleanupInterval) return; // Already running
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [token, data] of sseTokens.entries()) {
            if (data.expiresAt < now) {
                sseTokens.delete(token);
            }
        }
    }, 60000); // Clean every minute
}

// Stop cleanup interval (call on server shutdown)
export function stopTokenCleanup(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
    sseTokens.clear();
}

// Start cleanup on module load
startTokenCleanup();

import { randomBytes } from 'crypto';

/**
 * Generate a short-lived SSE token for a user
 * Token expires in 60 seconds and is single-use
 * Uses cryptographically secure random generation
 */
export function generateSSEToken(userId: string): string {
    // Prevent unbounded growth - evict oldest tokens if at capacity
    if (sseTokens.size >= MAX_SSE_TOKENS) {
        // Delete oldest 10% of tokens to make room
        const toDelete = Math.ceil(MAX_SSE_TOKENS * 0.1);
        const iterator = sseTokens.keys();
        for (let i = 0; i < toDelete; i++) {
            const key = iterator.next().value;
            if (key) sseTokens.delete(key);
        }
    }

    const randomPart = randomBytes(16).toString('hex');
    const token = `sse_${Date.now()}_${randomPart}`;
    sseTokens.set(token, {
        userId,
        expiresAt: Date.now() + 60000, // 60 seconds
    });
    return token;
}

/**
 * Validate and consume an SSE token (single-use)
 */
function validateSSEToken(token: string): string | null {
    const data = sseTokens.get(token);
    if (!data) return null;

    // Delete immediately (single-use)
    sseTokens.delete(token);

    // Check expiration
    if (data.expiresAt < Date.now()) return null;

    return data.userId;
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
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

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
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

/**
 * Authentication middleware for SSE endpoints
 * 
 * Uses short-lived, single-use SSE tokens to avoid exposing long-lived
 * auth tokens in URLs. Tokens are obtained via POST /autonomous/sse-token.
 * 
 * SECURITY NOTES:
 * - SSE tokens expire in 60 seconds and are single-use
 * - Token is removed from query string after validation to prevent logging
 * - Use HTTPS in production to prevent token interception
 * - Falls back to header auth for compatibility
 */
export function authenticateSSE(req: Request, _res: Response, next: NextFunction) {
    try {
        // Try header first (for compatibility)
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const payload = authService.verifyToken(token);
            req.user = payload;
            req.userId = payload.userId;
            return next();
        }

        // Try short-lived SSE token from query parameter
        if (req.query.sseToken && typeof req.query.sseToken === 'string') {
            const sseToken = req.query.sseToken;

            // Remove token from query to prevent logging (but preserve originalUrl for routing)
            delete req.query.sseToken;
            // Store sanitized URL in a custom property instead of mutating originalUrl
            (req as any).sanitizedUrl = req.originalUrl
                .replace(/\?sseToken=[^&]+&/, '?')
                .replace(/\?sseToken=[^&]+$/, '')
                .replace(/&sseToken=[^&]+/, '');

            const userId = validateSSEToken(sseToken);
            if (!userId) {
                throw new AuthenticationError('Invalid or expired SSE token');
            }

            // Set user info with required JWTPayload fields
            req.userId = userId;
            req.user = {
                userId,
                email: '', // SSE tokens don't carry email
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 60
            };
            return next();
        }

        // Legacy: Try regular token from query (deprecated, for backward compatibility)
        if (req.query.token && typeof req.query.token === 'string') {
            const token = req.query.token;
            delete req.query.token;
            // Store sanitized URL in a custom property instead of mutating originalUrl
            (req as any).sanitizedUrl = req.originalUrl
                .replace(/\?token=[^&]+&/, '?')
                .replace(/\?token=[^&]+$/, '')
                .replace(/&token=[^&]+/, '');

            const payload = authService.verifyToken(token);
            req.user = payload;
            req.userId = payload.userId;
            return next();
        }

        throw new AuthenticationError('No token provided');
    } catch (error) {
        next(error);
    }
}
