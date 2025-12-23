import { APPROVED_SYMBOLS, ApprovedSymbol } from '../types/weex';

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
    return APPROVED_SYMBOLS.includes(symbol.toLowerCase() as ApprovedSymbol);
}

export function validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

export function validatePassword(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (password.length < 8) {
        errors.push('Password must be at least 8 characters');
    }
    if (!/[A-Z]/.test(password)) {
        errors.push('Password must contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
        errors.push('Password must contain at least one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
        errors.push('Password must contain at least one number');
    }

    return { valid: errors.length === 0, errors };
}

export function validatePositionSize(
    size: number,
    portfolioValue: number,
    maxPositionPercent: number = 0.2
): { valid: boolean; error?: string } {
    if (size <= 0) {
        return { valid: false, error: 'Position size must be positive' };
    }

    const positionPercent = size / portfolioValue;
    if (positionPercent > maxPositionPercent) {
        return {
            valid: false,
            error: `Position size exceeds ${maxPositionPercent * 100}% of portfolio`
        };
    }

    return { valid: true };
}

export function sanitizeSymbol(symbol: string): string {
    return symbol.toLowerCase().trim();
}

export function formatPrice(price: number, decimals: number = 2): string {
    return price.toFixed(decimals);
}

export function formatPercent(value: number, decimals: number = 2): string {
    return `${(value * 100).toFixed(decimals)}%`;
}
