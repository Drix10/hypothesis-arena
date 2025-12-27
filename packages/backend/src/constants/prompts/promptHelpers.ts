/**
 * Prompt Helper Functions
 * 
 * Utility functions for safe prompt building with proper validation and formatting.
 */

/**
 * Safely format a number for display in prompts
 * Handles NaN, Infinity, and undefined values
 */
export function safeNumber(value: number | undefined | null, decimals: number = 2, fallback: string = 'N/A'): string {
    if (value === null || value === undefined) return fallback;
    if (!Number.isFinite(value)) return fallback;
    return value.toFixed(decimals);
}

/**
 * Safely format a price with $ prefix
 */
export function safePrice(value: number | undefined | null, decimals: number = 2): string {
    const formatted = safeNumber(value, decimals, 'N/A');
    return formatted === 'N/A' ? formatted : `$${formatted}`;
}

/**
 * Safely format a percentage
 */
export function safePercent(value: number | undefined | null, decimals: number = 2, includeSign: boolean = false): string {
    if (value === null || value === undefined) return 'N/A';
    if (!Number.isFinite(value)) return 'N/A';

    const sign = includeSign && value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Sanitize string for safe inclusion in prompts
 * Removes control characters and limits length
 */
export function sanitizeString(value: string | undefined | null, maxLength: number = 1000): string {
    if (!value) return '';

    // Remove control characters except newlines and tabs
    let sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Trim and limit length
    sanitized = sanitized.trim();
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength - 3) + '...';
    }

    return sanitized;
}

/**
 * Safely format an array of strings for display
 */
export function safeArrayJoin(
    arr: string[] | undefined | null,
    separator: string = ', ',
    maxItems: number = 10,
    fallback: string = 'N/A'
): string {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return fallback;

    const sanitized = arr
        .filter(item => typeof item === 'string' && item.trim().length > 0)
        .slice(0, maxItems)
        .map(item => sanitizeString(item, 200));

    return sanitized.length > 0 ? sanitized.join(separator) : fallback;
}

/**
 * Validate required string field
 */
export function validateRequired(value: string | undefined | null, fieldName: string): string {
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Required field '${fieldName}' is missing or empty`);
    }
    return value.trim();
}

/**
 * Validate required number field
 */
export function validateNumber(value: number | undefined | null, fieldName: string): number {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        throw new Error(`Required numeric field '${fieldName}' is invalid: ${value}`);
    }
    return value;
}

/**
 * Safely access nested object property with fallback
 */
export function safeGet<T>(obj: any, path: string, fallback: T): T {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return fallback;
        }
        current = current[key];
    }

    return current !== undefined ? current : fallback;
}

/**
 * Format price targets safely
 */
export function formatPriceTargets(
    priceTarget: { bull?: number; base?: number; bear?: number } | undefined | null
): { bull: string; base: string; bear: string } {
    if (!priceTarget) {
        return { bull: 'N/A', base: 'N/A', bear: 'N/A' };
    }

    return {
        bull: safePrice(priceTarget.bull),
        base: safePrice(priceTarget.base),
        bear: safePrice(priceTarget.bear)
    };
}
