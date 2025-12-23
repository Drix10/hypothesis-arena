import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { config } from '../../config';
import { query, queryOne } from '../../config/database';
import { logger } from '../../utils/logger';
import {
    AuthenticationError,
    ValidationError,
    ConflictError,
    NotFoundError
} from '../../utils/errors';
import {
    User,
    AuthTokens,
    JWTPayload,
    LoginRequest,
    RegisterRequest,
    AuthResponse
} from '@hypothesis-arena/shared';
import { validateEmail, validatePassword } from '@hypothesis-arena/shared';

const SALT_ROUNDS = 12;

export class AuthService {
    async register(data: RegisterRequest): Promise<AuthResponse> {
        // Validate email
        if (!validateEmail(data.email)) {
            throw new ValidationError('Invalid email format');
        }

        // Validate password
        const passwordValidation = validatePassword(data.password);
        if (!passwordValidation.valid) {
            throw new ValidationError('Invalid password', {
                password: passwordValidation.errors.join(', ')
            });
        }

        // Check if email exists
        const existingEmail = await queryOne<User>(
            'SELECT id FROM users WHERE email = $1',
            [data.email.toLowerCase()]
        );
        if (existingEmail) {
            throw new ConflictError('Email already registered');
        }

        // Check if username exists
        const existingUsername = await queryOne<User>(
            'SELECT id FROM users WHERE username = $1',
            [data.username]
        );
        if (existingUsername) {
            throw new ConflictError('Username already taken');
        }

        // Hash password
        const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

        // Create user
        const id = uuid();
        const now = Date.now();

        await query(
            `INSERT INTO users (id, email, username, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
            [id, data.email.toLowerCase(), data.username, passwordHash, new Date(now)]
        );

        const user: User = {
            id,
            email: data.email.toLowerCase(),
            username: data.username,
            createdAt: now,
            updatedAt: now,
            isActive: true,
            subscriptionTier: 'free',
        };

        const tokens = this.generateTokens(user);

        logger.info(`User registered: ${user.email}`);

        return { user, tokens };
    }

    async login(data: LoginRequest): Promise<AuthResponse> {
        const row = await queryOne<any>(
            'SELECT * FROM users WHERE email = $1',
            [data.email.toLowerCase()]
        );

        // Always hash to prevent timing attacks
        const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attacks';
        const passwordToCompare = row?.password_hash || dummyHash;
        const validPassword = await bcrypt.compare(data.password, passwordToCompare);

        // Check both conditions together to prevent timing attacks
        if (!row || !validPassword) {
            throw new AuthenticationError('Invalid email or password');
        }

        if (!row.is_active) {
            throw new AuthenticationError('Account is disabled');
        }

        // Update last login
        await query(
            'UPDATE users SET last_login = $1 WHERE id = $2',
            [new Date(), row.id]
        );

        const user: User = {
            id: row.id,
            email: row.email,
            username: row.username,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
            isActive: row.is_active,
            lastLogin: Date.now(),
            subscriptionTier: row.subscription_tier || 'free',
        };

        const tokens = this.generateTokens(user);

        logger.info(`User logged in: ${user.email}`);

        return { user, tokens };
    }

    async getUserById(userId: string): Promise<User> {
        const row = await queryOne<any>(
            'SELECT * FROM users WHERE id = $1',
            [userId]
        );

        if (!row) {
            throw new NotFoundError('User');
        }

        return {
            id: row.id,
            email: row.email,
            username: row.username,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
            isActive: row.is_active,
            lastLogin: row.last_login ? new Date(row.last_login).getTime() : undefined,
            subscriptionTier: row.subscription_tier || 'free',
        };
    }

    async refreshToken(refreshToken: string): Promise<AuthTokens> {
        try {
            const payload = jwt.verify(refreshToken, config.jwtSecret) as JWTPayload & { type: string };

            if (payload.type !== 'refresh') {
                throw new AuthenticationError('Invalid refresh token');
            }

            const user = await this.getUserById(payload.userId);
            return this.generateTokens(user);
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                throw new AuthenticationError('Refresh token expired');
            }
            throw new AuthenticationError('Invalid refresh token');
        }
    }

    verifyToken(token: string): JWTPayload {
        try {
            const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;
            return payload;
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                throw new AuthenticationError('Token expired');
            }
            throw new AuthenticationError('Invalid token');
        }
    }

    private generateTokens(user: User): AuthTokens {
        const accessToken = jwt.sign(
            { userId: user.id, email: user.email },
            config.jwtSecret,
            { expiresIn: this.parseExpiry(config.jwtExpiry) }
        );

        const refreshToken = jwt.sign(
            { userId: user.id, email: user.email, type: 'refresh' },
            config.jwtSecret,
            { expiresIn: this.parseExpiry(config.jwtRefreshExpiry) }
        );

        // Parse expiry to seconds
        const expiresIn = this.parseExpiry(config.jwtExpiry);

        return { accessToken, refreshToken, expiresIn };
    }

    private parseExpiry(expiry: string): number {
        const match = expiry.match(/^(\d+)([smhd])$/);
        if (!match) return 3600;

        const value = parseInt(match[1], 10);
        const unit = match[2];

        switch (unit) {
            case 's': return value;
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            default: return 3600;
        }
    }
}

export const authService = new AuthService();
