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
 

/**
 * Sanitize a trading symbol to lowercase and trimmed format
 * @param symbol - The symbol to sanitize (e.g., "BTC-USDT", " eth_usdt ")
 * @returns Sanitized symbol in lowercase (e.g., "btc-usdt", "eth_usdt")
 * @throws Error if symbol is null, undefined, not a string, or contains only whitespace
 */
 

/**
 * Format a price number to a string with specified decimal places
 * @param price - The price to format
 * @param decimals - Number of decimal places (default: 2, must be 0-20)
 * @returns Formatted price string (e.g., "123.45" for price=123.45, decimals=2)
 *          Returns "0.00" (or "0" if decimals=0) for non-finite inputs
 * @throws Error if decimals is not an integer or out of range [0, 20]
 */
 

/**
 * Format a decimal value as a percentage string
 * @param value - The value to format (e.g., 0.1234 for 12.34%)
 * @param decimals - Number of decimal places (default: 2, must be 0-20)
 * @returns Formatted percentage string (e.g., "12.34%" for value=0.1234)
 *          Returns "-" for non-finite inputs
 * @throws Error if decimals is not an integer or out of range [0, 20]
 */
 

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
