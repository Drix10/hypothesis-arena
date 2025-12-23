// Auth Types

export interface User {
    id: string;
    email: string;
    username: string;
    createdAt: number;
    updatedAt: number;
    isActive: boolean;
    lastLogin?: number;
    subscriptionTier: 'free' | 'pro' | 'enterprise';
}

export interface UserWeexConnection {
    id: string;
    userId: string;
    accountId?: string;
    isActive: boolean;
    createdAt: number;
    lastSync?: number;
}

export interface AuthTokens {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface RegisterRequest {
    email: string;
    username: string;
    password: string;
}

export interface AuthResponse {
    user: User;
    tokens: AuthTokens;
}

export interface JWTPayload {
    userId: string;
    email: string;
    iat: number;
    exp: number;
}
