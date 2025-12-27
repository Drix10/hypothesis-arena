import { APPROVED_SYMBOLS, ApprovedSymbol } from '../types/weex';

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
    return APPROVED_SYMBOLS.includes(symbol.toLowerCase() as ApprovedSymbol);
}

/**
 * Validate an email address format
 * @param email - The email address to validate
 * @returns true if email is valid, false otherwise
 * 
 * Validation rules:
 * - Must be a non-empty string
 * - Maximum length: 254 characters (RFC 5321)
 * - Must match standard email format (local@domain.tld)
 * - Local part: alphanumeric + special chars (.!#$%&'*+/=?^_`{|}~-)
 * - Domain: alphanumeric + hyphens, with valid TLD
 */
export function validateEmail(email: string): boolean {
    // Check type and length
    if (!email || typeof email !== 'string' || email.length > 254) {
        return false;
    }

    // RFC 5322 compliant email regex (simplified but robust)
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
}

/**
 * Validate a password meets security requirements
 * @param password - The password to validate
 * @returns Object with valid flag and array of error messages
 * 
 * Requirements:
 * - Must be a string
 * - Length: 8-128 characters
 * - Must contain at least one uppercase letter
 * - Must contain at least one lowercase letter
 * - Must contain at least one number
 */
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Type check
    if (!password || typeof password !== 'string') {
        errors.push('Password must be a string');
        return { valid: false, errors };
    }

    // Length validation
    if (password.length < 8) {
        errors.push('Password must be at least 8 characters');
    }
    if (password.length > 128) {
        errors.push('Password must be at most 128 characters');
    }

    // Complexity validation
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

/**
 * Validate a position size against portfolio value and risk limits
 * @param size - The position size in dollars
 * @param portfolioValue - Total portfolio value in dollars
 * @param maxPositionPercent - Maximum position size as decimal (default: 0.2 = 20%)
 * @returns Object with valid flag and optional error message
 * 
 * Validation rules:
 * - All inputs must be finite positive numbers
 * - maxPositionPercent must be in range (0, 1]
 * - Position size must not exceed maxPositionPercent of portfolio
 */
export function validatePositionSize(
    size: number,
    portfolioValue: number,
    maxPositionPercent: number = 0.2
): { valid: boolean; error?: string } {
    // Validate all inputs are finite numbers
    if (!Number.isFinite(size)) {
        return { valid: false, error: 'Position size must be a finite number' };
    }
    if (!Number.isFinite(portfolioValue)) {
        return { valid: false, error: 'Portfolio value must be a finite number' };
    }
    if (!Number.isFinite(maxPositionPercent)) {
        return { valid: false, error: 'Max position percent must be a finite number' };
    }

    // Validate maxPositionPercent is in valid range (0, 1]
    if (maxPositionPercent <= 0 || maxPositionPercent > 1) {
        return { valid: false, error: 'Max position percent must be between 0 and 1 (exclusive of 0, inclusive of 1)' };
    }

    if (size <= 0) {
        return { valid: false, error: 'Position size must be positive' };
    }

    // Guard against division by zero
    if (portfolioValue <= 0) {
        return { valid: false, error: 'Portfolio value must be positive' };
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

/**
 * Sanitize a trading symbol to lowercase and trimmed format
 * @param symbol - The symbol to sanitize (e.g., "BTC-USDT", " eth_usdt ")
 * @returns Sanitized symbol in lowercase (e.g., "btc-usdt", "eth_usdt")
 * @throws Error if symbol is null, undefined, not a string, or contains only whitespace
 */
export function sanitizeSymbol(symbol: string): string {
    // Validate input type
    if (symbol == null || typeof symbol !== 'string') {
        throw new Error('Invalid symbol: must be a non-null string');
    }

    const sanitized = symbol.toLowerCase().trim();

    // Validate non-empty after sanitization (contains only whitespace)
    if (sanitized.length === 0) {
        throw new Error('Invalid symbol: contains only whitespace');
    }

    return sanitized;
}

/**
 * Format a price number to a string with specified decimal places
 * @param price - The price to format
 * @param decimals - Number of decimal places (default: 2, must be 0-20)
 * @returns Formatted price string (e.g., "123.45" for price=123.45, decimals=2)
 *          Returns "0.00" (or "0" if decimals=0) for non-finite inputs
 * @throws Error if decimals is not an integer or out of range [0, 20]
 */
export function formatPrice(price: number, decimals: number = 2): string {
    // Validate decimals parameter
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) {
        throw new Error('decimals must be an integer between 0 and 20');
    }

    // Validate input is finite
    if (!Number.isFinite(price)) {
        // Return properly formatted zero with correct decimal places
        return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
    }
    return price.toFixed(decimals);
}

/**
 * Format a decimal value as a percentage string
 * @param value - The value to format (e.g., 0.1234 for 12.34%)
 * @param decimals - Number of decimal places (default: 2, must be 0-20)
 * @returns Formatted percentage string (e.g., "12.34%" for value=0.1234)
 *          Returns "-" for non-finite inputs
 * @throws Error if decimals is not an integer or out of range [0, 20]
 */
export function formatPercent(value: number, decimals: number = 2): string {
    // Validate decimals parameter
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) {
        throw new Error('decimals must be an integer between 0 and 20');
    }

    // Validate input is finite
    if (!Number.isFinite(value)) {
        return '-';
    }
    return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Validate a trade order before execution
 * @param trade - Partial trade object to validate
 * @returns Object with valid flag and optional error message
 * 
 * Validation rules:
 * - LIMIT orders MUST have a valid positive price
 * - MARKET orders should NOT have a price (to avoid confusion)
 * - Size must be a positive finite number
 */
export function validateTrade(trade: { type?: string; price?: number; size?: number }): { valid: boolean; error?: string } {
    if (!trade.type) {
        return { valid: false, error: 'Order type is required' };
    }

    // LIMIT orders MUST have a price
    if (trade.type === 'LIMIT' && (trade.price == null || !Number.isFinite(trade.price) || trade.price <= 0)) {
        return { valid: false, error: 'LIMIT orders require a valid positive price' };
    }

    // MARKET orders should NOT have a price (to avoid confusion)
    if (trade.type === 'MARKET' && trade.price != null) {
        return { valid: false, error: 'MARKET orders should not specify a price' };
    }

    if (trade.size == null || !Number.isFinite(trade.size) || trade.size <= 0) {
        return { valid: false, error: 'Order size must be a positive number' };
    }

    return { valid: true };
}

/**
 * Validate risk limits configuration
 * @param limits - Risk limits object to validate
 * @returns Object with valid flag and array of error messages
 * 
 * Validation rules:
 * - Percentages (position size, drawdowns) must be in (0, 1]
 * - Leverage must be between 1 and 100
 * - Daily trades must be a positive integer
 * - Liquidate threshold must be >= pause threshold (logical consistency)
 */
export function validateRiskLimits(limits: {
    maxPositionSize: number;
    maxTotalInvested: number;
    maxDailyTrades: number;
    maxLeverage: number;
    drawdownPauseThreshold: number;
    drawdownLiquidateThreshold: number;
    circuitBreakerThreshold: number;
}): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate percentages are in (0, 1]
    if (!Number.isFinite(limits.maxPositionSize) || limits.maxPositionSize <= 0 || limits.maxPositionSize > 1) {
        errors.push('maxPositionSize must be between 0 and 1');
    }
    if (!Number.isFinite(limits.maxTotalInvested) || limits.maxTotalInvested <= 0 || limits.maxTotalInvested > 1) {
        errors.push('maxTotalInvested must be between 0 and 1');
    }
    if (!Number.isFinite(limits.drawdownPauseThreshold) || limits.drawdownPauseThreshold <= 0 || limits.drawdownPauseThreshold > 1) {
        errors.push('drawdownPauseThreshold must be between 0 and 1');
    }
    if (!Number.isFinite(limits.drawdownLiquidateThreshold) || limits.drawdownLiquidateThreshold <= 0 || limits.drawdownLiquidateThreshold > 1) {
        errors.push('drawdownLiquidateThreshold must be between 0 and 1');
    }
    if (!Number.isFinite(limits.circuitBreakerThreshold) || limits.circuitBreakerThreshold <= 0 || limits.circuitBreakerThreshold > 1) {
        errors.push('circuitBreakerThreshold must be between 0 and 1');
    }

    // Validate leverage
    if (!Number.isFinite(limits.maxLeverage) || limits.maxLeverage < 1 || limits.maxLeverage > 100) {
        errors.push('maxLeverage must be between 1 and 100');
    }

    // Validate daily trades
    if (!Number.isInteger(limits.maxDailyTrades) || limits.maxDailyTrades < 1) {
        errors.push('maxDailyTrades must be a positive integer');
    }

    // Logical validation: liquidate threshold should be >= pause threshold
    if (limits.drawdownLiquidateThreshold < limits.drawdownPauseThreshold) {
        errors.push('drawdownLiquidateThreshold must be >= drawdownPauseThreshold');
    }

    return { valid: errors.length === 0, errors };
}
