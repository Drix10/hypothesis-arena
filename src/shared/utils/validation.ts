import { APPROVED_SYMBOLS, ApprovedSymbol } from '../types/weex';

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
    return APPROVED_SYMBOLS.includes(symbol.toLowerCase() as ApprovedSymbol);
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
