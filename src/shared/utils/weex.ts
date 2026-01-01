/**
 * WEEX API Utility Functions
 * Ensures compliance with WEEX trading specifications
 */

import type { WeexContract } from '../types/weex';
import { logger } from '../../utils/logger';
import { APPROVED_SYMBOLS } from '../constants/symbols';

/**
 * Contract specifications cache with TTL
 * Maps symbol to contract specifications
 * 
 * CONCURRENCY NOTE: This cache is accessed from multiple async operations.
 * JavaScript's single-threaded event loop ensures Map operations are atomic.
 * However, async gaps between read-modify-write operations can cause race conditions.
 * The updateContractSpecs() function uses timestamp-based validation to detect stale updates.
 */
interface CachedContractSpecs {
    specs: ContractSpecs;
    cachedAt: number;
}

const contractSpecsCache = new Map<string, CachedContractSpecs>();
const warnedSymbols = new Set<string>(); // Track which symbols have been warned about age
const CACHE_TTL_MS = 3600000; // 1 hour TTL for contract specs
const CACHE_REFRESH_THRESHOLD_MS = 3300000; // 55 minutes (warn before expiry)
const MAX_CACHE_SIZE = 100; // FIXED: Prevent unbounded cache growth

// Reasonable upper bounds for sanity checks
const MAX_REASONABLE_PRICE = 10_000_000; // 10 million per coin
const MAX_REASONABLE_SIZE = 1_000_000; // 1 million coins

interface ContractSpecs {
    symbol: string;
    tickSize: number; // Actual tick size (e.g., 0.1 for BTC)
    priceDecimals: number; // Number of decimal places for price
    sizeStepSize: number; // Actual step size for quantity (e.g., 0.0001)
    sizeDecimals: number; // Number of decimal places for size
    minOrderSize: number;
    maxOrderSize: number;
    maxPositionSize: number;
    minLeverage: number;
    maxLeverage: number;
}

/**
 * Clear expired entries from contract specs cache
 * Prevents memory leaks from stale data
 * Also clears corresponding warning flags for expired symbols
 * FIXED: Also enforces max cache size with LRU eviction
 */
function cleanupExpiredSpecs(): void {
    const now = Date.now();
    let removedCount = 0;

    // Remove expired entries
    for (const [symbol, cached] of contractSpecsCache.entries()) {
        if (now - cached.cachedAt > CACHE_TTL_MS) {
            contractSpecsCache.delete(symbol);
            warnedSymbols.delete(symbol); // Clear warning flag for expired symbol
            removedCount++;
        }
    }

    // FIXED: Enforce max cache size with LRU eviction
    if (contractSpecsCache.size > MAX_CACHE_SIZE) {
        // Sort by age (oldest first) and remove oldest entries
        const entries = Array.from(contractSpecsCache.entries())
            .sort((a, b) => a[1].cachedAt - b[1].cachedAt);

        const toRemove = contractSpecsCache.size - MAX_CACHE_SIZE;
        for (let i = 0; i < toRemove; i++) {
            const [symbol] = entries[i];
            contractSpecsCache.delete(symbol);
            warnedSymbols.delete(symbol);
            removedCount++;
        }

        logger.warn(`Contract specs cache exceeded ${MAX_CACHE_SIZE} entries, removed ${toRemove} oldest entries`);
    }

    if (removedCount > 0) {
        logger.info(`Cleaned up ${removedCount} expired contract specs from cache (${contractSpecsCache.size} remaining)`);
    }
}

/**
 * Clear all contract specifications from cache
 * Use when forcing a refresh of all specs
 */
export function clearContractSpecs(): void {
    const count = contractSpecsCache.size;
    contractSpecsCache.clear();
    warnedSymbols.clear(); // Reset warning flags
    logger.info(`Cleared ${count} contract specs from cache`);
}

/**
 * Parse and validate a positive float from a string
 * Ensures no trailing garbage and valid numeric format
 * 
 * @param value - String value to parse
 * @param fieldName - Name of field (for error messages)
 * @param symbol - Symbol (for error messages)
 * @returns Parsed positive float
 * @throws Error if value is invalid
 */
function parsePositiveFloat(value: string, fieldName: string, symbol: string): number {
    // Validate string format
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Invalid ${fieldName} for ${symbol}: must be non-empty string, got ${typeof value}`);
    }

    // Validate numeric format (no trailing garbage, only digits and optional decimal point)
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(`Invalid ${fieldName} for ${symbol}: must be numeric string, got "${value}"`);
    }

    const parsed = parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid ${fieldName} for ${symbol}: must be > 0, got ${value}`);
    }

    return parsed;
}

/**
 * Parse WEEX contract information into usable specifications
 * 
 * @param contract - WEEX contract data from API
 * @returns Parsed contract specifications
 * @throws Error if contract data is invalid or malformed
 */
export function parseContractSpecs(contract: WeexContract): ContractSpecs {
    // Validate symbol format
    if (!contract.symbol || typeof contract.symbol !== 'string') {
        throw new Error(`Invalid contract: missing or invalid symbol`);
    }

    // Validate symbol format: must be "cmt_xxxusdt"
    if (!contract.symbol.startsWith('cmt_') || !contract.symbol.endsWith('usdt')) {
        throw new Error(`Invalid contract symbol format: ${contract.symbol} (must be cmt_xxxusdt)`);
    }

    // Validate symbol is not empty after prefix/suffix
    const coinPart = contract.symbol.slice(4, -4); // Remove "cmt_" and "usdt"
    if (coinPart.length === 0) {
        throw new Error(`Invalid contract symbol: ${contract.symbol} (empty coin name)`);
    }

    if (!contract.tick_size || typeof contract.tick_size !== 'string') {
        throw new Error(`Invalid contract ${contract.symbol}: missing or invalid tick_size`);
    }

    if (typeof contract.priceEndStep !== 'number') {
        throw new Error(`Invalid contract ${contract.symbol}: missing or invalid priceEndStep`);
    }

    if (!contract.size_increment || typeof contract.size_increment !== 'string') {
        throw new Error(`Invalid contract ${contract.symbol}: missing or invalid size_increment`);
    }

    if (!contract.minOrderSize || typeof contract.minOrderSize !== 'string') {
        throw new Error(`Invalid contract ${contract.symbol}: missing or invalid minOrderSize`);
    }

    // Parse tick_size: "1" means 1 decimal place
    // priceEndStep: 1 means step of 0.1, 0.1 means step of 0.01
    const priceDecimals = parseInt(contract.tick_size, 10);

    // FIXED: Allow up to 18 decimals for meme coins with very small prices
    // JavaScript can safely handle up to 15-16 significant digits
    if (!Number.isFinite(priceDecimals) || priceDecimals < 0 || priceDecimals > 18) {
        throw new Error(`Invalid contract ${contract.symbol}: tick_size must be 0-18, got ${contract.tick_size}`);
    }

    // Warn if decimals are very high (potential precision issues)
    if (priceDecimals > 12) {
        logger.warn(`High precision for ${contract.symbol}: ${priceDecimals} decimals (may have floating point precision issues)`);
    }

    let tickSize = contract.priceEndStep;
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
        throw new Error(`Invalid contract ${contract.symbol}: priceEndStep must be > 0, got ${tickSize}`);
    }

    // WEEX API NOTE: priceEndStep often returns 1 for all contracts, which is inconsistent
    // with priceDecimals. We trust priceDecimals to calculate the actual tick size.
    // Only log if the discrepancy is severe (not just the common "1" value)
    const expectedTickSize = Math.pow(10, -priceDecimals);
    if (tickSize !== 1 && Math.abs(tickSize - expectedTickSize) > expectedTickSize * 0.5) {
        logger.warn(
            `Unusual tick size for ${contract.symbol}: ` +
            `priceDecimals=${priceDecimals} suggests ${expectedTickSize}, ` +
            `but API returned ${tickSize}. Using ${expectedTickSize} based on priceDecimals.`
        );
        // Override with calculated value if severely inconsistent
        tickSize = expectedTickSize;
    } else if (tickSize === 1 && expectedTickSize !== 1) {
        // Common case: API returns 1 for all contracts, use calculated value
        tickSize = expectedTickSize;
    }

    // Parse size_increment: "5" means 5 decimal places
    // minOrderSize: "0.0001" is the minimum step
    const sizeDecimals = parseInt(contract.size_increment, 10);

    // FIXED: Allow up to 18 decimals for size as well
    if (!Number.isFinite(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 18) {
        throw new Error(`Invalid contract ${contract.symbol}: size_increment must be 0-18, got ${contract.size_increment}`);
    }

    // Warn if decimals are very high
    if (sizeDecimals > 12) {
        logger.warn(`High size precision for ${contract.symbol}: ${sizeDecimals} decimals (may have floating point precision issues)`);
    }

    // Use helper function to parse and validate numeric strings
    const sizeStepSize = parsePositiveFloat(contract.minOrderSize, 'minOrderSize', contract.symbol);
    const minOrderSize = sizeStepSize; // Same value, no duplicate parsing
    const maxOrderSize = parsePositiveFloat(contract.maxOrderSize, 'maxOrderSize', contract.symbol);
    const maxPositionSize = parsePositiveFloat(contract.maxPositionSize, 'maxPositionSize', contract.symbol);

    // Validate order size range
    if (maxOrderSize < minOrderSize) {
        throw new Error(`Invalid contract ${contract.symbol}: maxOrderSize (${maxOrderSize}) < minOrderSize (${minOrderSize})`);
    }

    // Validate and sanitize leverage limits
    const minLeverageRaw = typeof contract.minLeverage === 'number' ? contract.minLeverage : parseFloat(String(contract.minLeverage || '1'));
    const maxLeverageRaw = typeof contract.maxLeverage === 'number' ? contract.maxLeverage : parseFloat(String(contract.maxLeverage || '500'));

    // Validate minLeverage
    let minLeverage = 1; // Safe default
    if (Number.isFinite(minLeverageRaw) && minLeverageRaw >= 1) {
        minLeverage = Math.floor(minLeverageRaw);
    } else {
        logger.warn(`Invalid minLeverage for ${contract.symbol}: ${contract.minLeverage}, using default 1`);
    }

    // Validate maxLeverage
    let maxLeverage = 500; // Safe default
    if (Number.isFinite(maxLeverageRaw) && maxLeverageRaw >= 1) {
        maxLeverage = Math.floor(maxLeverageRaw);
    } else {
        logger.warn(`Invalid maxLeverage for ${contract.symbol}: ${contract.maxLeverage}, using default 500`);
    }

    // Ensure maxLeverage >= minLeverage (fix inverted ranges)
    if (maxLeverage < minLeverage) {
        logger.warn(`Inverted leverage range for ${contract.symbol}: min=${minLeverage}, max=${maxLeverage}. Swapping values.`);
        [minLeverage, maxLeverage] = [maxLeverage, minLeverage];
    }

    return {
        symbol: contract.symbol,
        tickSize,
        priceDecimals,
        sizeStepSize,
        sizeDecimals,
        minOrderSize,
        maxOrderSize,
        maxPositionSize,
        minLeverage,
        maxLeverage,
    };
}

/**
 * Update contract specifications cache
 * Should be called when fetching contract information from WEEX API
 * 
 * FIXED: Memory leak - ensures warnedSymbols is cleared even on error
 * 
 * @param contracts - Array of WEEX contracts
 * @throws Error if contracts array is empty or contains invalid data
 */
export function updateContractSpecs(contracts: WeexContract[]): void {
    if (!Array.isArray(contracts)) {
        throw new Error('updateContractSpecs: contracts must be an array');
    }

    if (contracts.length === 0) {
        throw new Error('updateContractSpecs: contracts array is empty - cannot proceed without specifications');
    }

    // Clean up expired entries before adding new ones
    cleanupExpiredSpecs();

    // Use consistent timestamp for all updates in this batch to detect concurrent modifications
    const updateTimestamp = Date.now();
    let successCount = 0;
    let errorCount = 0;

    // CRITICAL: Wrap in try-finally to ensure warnedSymbols is cleared even on error
    try {
        for (const contract of contracts) {
            try {
                const specs = parseContractSpecs(contract);

                // Check for concurrent modification: if cache entry exists with newer timestamp, skip update
                const existing = contractSpecsCache.get(contract.symbol);
                if (existing && existing.cachedAt > updateTimestamp) {
                    logger.warn(`Skipping stale update for ${contract.symbol} (concurrent modification detected)`);
                    continue;
                }

                contractSpecsCache.set(contract.symbol, {
                    specs,
                    cachedAt: updateTimestamp,
                });
                successCount++;
            } catch (error) {
                errorCount++;
                // Log error message only (stack trace will be added by winston errors() format)
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to parse contract specs for ${contract.symbol}: ${errorMessage}`);
            }
        }

        if (successCount === 0) {
            throw new Error(`Failed to parse any contract specifications (${errorCount} errors)`);
        }

        if (errorCount > 0) {
            logger.warn(`Parsed ${successCount} contracts successfully, ${errorCount} failed`);
        }

        // CRITICAL: Validate all approved symbols are present in CURRENT payload
        // Build parsedSymbols from the current update only (symbols successfully parsed in this function call)
        const parsedSymbols = new Set<string>();
        for (const contract of contracts) {
            try {
                // Check if this contract was successfully parsed (exists in cache with current timestamp)
                const cached = contractSpecsCache.get(contract.symbol);
                if (cached && cached.cachedAt === updateTimestamp) {
                    parsedSymbols.add(contract.symbol);
                }
            } catch {
                // Skip invalid contracts
            }
        }

        // Use parsedSymbols for CRITICAL presence check (not contractSpecsCache which may contain stale entries)
        const missingSymbols = APPROVED_SYMBOLS.filter(s => !parsedSymbols.has(s));
        if (missingSymbols.length > 0) {
            throw new Error(`❌ CRITICAL: Missing contract specs for approved symbols in current payload: ${missingSymbols.join(', ')}. Incomplete API response detected!`);
        }

        logger.info(`✅ Cached specifications for ${successCount} contracts (all ${APPROVED_SYMBOLS.length} approved symbols present)`);
    } finally {
        // CRITICAL: Always reset warning flags when specs are refreshed (success or error)
        // This prevents memory leak from accumulating stale warning flags
        warnedSymbols.clear();
    }
}

/**
 * Get contract specifications for a symbol
 * 
 * @param symbol - Trading pair symbol
 * @returns Contract specifications or undefined if not cached or expired
 */
export function getContractSpecs(symbol: string): ContractSpecs | undefined {
    const cached = contractSpecsCache.get(symbol);
    if (!cached) {
        return undefined;
    }

    const now = Date.now();
    const age = now - cached.cachedAt;

    // Warn ONCE if specs are old (but not expired yet)
    if (age > CACHE_REFRESH_THRESHOLD_MS && age <= CACHE_TTL_MS) {
        if (!warnedSymbols.has(symbol)) {
            logger.warn(`⚠️ Contract specs for ${symbol} are ${Math.floor(age / 60000)} minutes old - consider refreshing soon`);
            warnedSymbols.add(symbol);
        }
    }

    // Check if cache entry is expired
    if (age > CACHE_TTL_MS) {
        contractSpecsCache.delete(symbol);
        warnedSymbols.delete(symbol); // Reset warning flag
        logger.error(`❌ CRITICAL: Contract specs for ${symbol} EXPIRED (age: ${Math.floor(age / 60000)} minutes) - orders will fail! Refresh specs immediately.`);
        return undefined;
    }

    return cached.specs;
}

/**
 * Round order size to WEEX stepSize
 * Uses floor rounding to ensure we don't exceed available balance
 * 
 * @param size - Raw order size
 * @param symbol - Trading pair symbol (REQUIRED for accurate rounding)
 * @param stepSize - Manual override for stepSize (optional, for testing)
 * @returns Rounded size as string
 * @throws Error if size is invalid or too small
 */
export function roundToStepSize(size: number, symbol?: string, stepSize?: number): string {
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid size: ${size}`);
    }

    // Sanity check: size should be reasonable
    if (size > MAX_REASONABLE_SIZE) {
        throw new Error(`Size ${size} exceeds reasonable maximum ${MAX_REASONABLE_SIZE}`);
    }

    // Get contract specs if symbol provided
    let actualStepSize = stepSize;
    let decimals = 4; // Default to 4 decimals

    if (!actualStepSize && symbol) {
        const specs = getContractSpecs(symbol);
        if (specs) {
            actualStepSize = specs.sizeStepSize;
            decimals = specs.sizeDecimals;
        } else {
            // CRITICAL: Use symbol-aware fallback step sizes
            // BTC has smaller position sizes (higher price), so uses smaller step (0.0001)
            // Other coins may use larger steps
            const symbolLower = symbol.toLowerCase();
            if (symbolLower.includes('btc')) {
                actualStepSize = 0.0001;
                decimals = 4;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using BTC fallback stepSize 0.0001 - may cause order rejection!`);
            } else if (symbolLower.includes('eth')) {
                actualStepSize = 0.001;
                decimals = 3;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using ETH fallback stepSize 0.001 - may cause order rejection!`);
            } else {
                // For other coins, use 0.01 as default (most common for altcoins)
                actualStepSize = 0.01;
                decimals = 2;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using fallback stepSize 0.01 - may cause order rejection!`);
            }
        }
    } else if (!actualStepSize && !symbol) {
        logger.warn(`⚠️ roundToStepSize called without symbol or stepSize - using fallback 0.0001 - may cause order rejection!`);
    }

    // Fallback to default 0.0001 if no specs available (no symbol provided)
    if (!actualStepSize) {
        actualStepSize = 0.0001;
        decimals = 4;
    }

    if (!Number.isFinite(actualStepSize) || actualStepSize <= 0) {
        throw new Error(`Invalid stepSize: ${actualStepSize}`);
    }

    // CRITICAL: Validate decimals are safe for integer arithmetic
    if (decimals > 8) {
        throw new Error(`Decimals ${decimals} too large for safe integer arithmetic (max 8 to prevent overflow)`);
    }

    // Use integer arithmetic to avoid floating point errors
    // Convert to smallest unit, round, then convert back
    const multiplier = Math.pow(10, decimals);

    // Validate multiplier is exact and finite
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new Error(`Invalid multiplier ${multiplier} for decimals ${decimals}`);
    }

    const sizeInSmallestUnit = Math.round(size * multiplier);
    const stepInSmallestUnit = Math.round(actualStepSize * multiplier);

    // CRITICAL: Validate no division by zero
    if (stepInSmallestUnit === 0) {
        throw new Error(`stepInSmallestUnit is zero (stepSize: ${actualStepSize}, decimals: ${decimals}) - cannot round`);
    }

    // CRITICAL: Validate results are safe integers (prevent overflow)
    if (!Number.isSafeInteger(sizeInSmallestUnit)) {
        throw new Error(`Integer overflow: sizeInSmallestUnit ${sizeInSmallestUnit} exceeds MAX_SAFE_INTEGER (size: ${size}, decimals: ${decimals})`);
    }
    if (!Number.isSafeInteger(stepInSmallestUnit)) {
        throw new Error(`Integer overflow: stepInSmallestUnit ${stepInSmallestUnit} exceeds MAX_SAFE_INTEGER (stepSize: ${actualStepSize}, decimals: ${decimals})`);
    }

    const roundedInSmallestUnit = Math.floor(sizeInSmallestUnit / stepInSmallestUnit) * stepInSmallestUnit;
    const rounded = roundedInSmallestUnit / multiplier;

    // Validate result is finite and positive
    if (!Number.isFinite(rounded) || rounded <= 0) {
        throw new Error(`Invalid rounded result: ${rounded} (size: ${size}, stepSize: ${actualStepSize})`);
    }

    if (rounded < actualStepSize) {
        throw new Error(`Size ${size} too small after rounding to stepSize ${actualStepSize} (result: ${rounded})`);
    }

    const result = rounded.toFixed(decimals);

    // CRITICAL: Final validation - ensure result is valid
    if (result === 'NaN' || result === 'Infinity' || result === '-Infinity') {
        throw new Error(`Invalid final result: ${result} (size: ${size}, stepSize: ${actualStepSize}, decimals: ${decimals})`);
    }

    // Validate result is not zero
    if (parseFloat(result) === 0) {
        throw new Error(`Final result is zero (size: ${size}, stepSize: ${actualStepSize}, decimals: ${decimals})`);
    }

    return result;
}

/**
 * Round price to WEEX tick_size
 * 
 * WEEX tick_size is defined per contract in the API response:
 * - tick_size: Number of decimal places (e.g., "1" = 1 decimal)
 * - priceEndStep: Step size of last digit (e.g., 1 = 0.1, 0.1 = 0.01)
 * 
 * Example for BTC:
 * - tick_size: "1" (1 decimal place)
 * - priceEndStep: 1 (step of 0.1)
 * - Valid prices: 86400.0, 86400.1, 86400.2, etc.
 * - Invalid: 86400.42 (too many decimals)
 * 
 * @param price - Raw price
 * @param symbol - Trading pair symbol (REQUIRED for accurate rounding)
 * @param tickSize - Manual override for tickSize (optional, for testing)
 * @returns Rounded price as string
 * @throws Error if price is invalid
 */
export function roundToTickSize(price: number, symbol?: string, tickSize?: number): string {
    // Input validation - all checks are necessary for safety
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price: ${price}`);
    }

    if (price > MAX_REASONABLE_PRICE) {
        throw new Error(`Price ${price} exceeds reasonable maximum ${MAX_REASONABLE_PRICE}`);
    }

    // Get contract specs if symbol provided
    let actualTickSize = tickSize;
    let decimals = 2; // Default to 2 decimals

    if (!actualTickSize && symbol) {
        const specs = getContractSpecs(symbol);
        if (specs) {
            actualTickSize = specs.tickSize;
            decimals = specs.priceDecimals;
        } else {
            // CRITICAL: Use symbol-aware fallback tick sizes
            // BTC has higher prices, so uses larger tick size (0.1)
            // Other coins typically use 0.01
            // This prevents order rejection when specs are missing
            const symbolLower = symbol.toLowerCase();
            if (symbolLower.includes('btc')) {
                actualTickSize = 0.1;
                decimals = 1;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using BTC fallback tickSize 0.1 - may cause order rejection!`);
            } else if (symbolLower.includes('eth')) {
                actualTickSize = 0.01;
                decimals = 2;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using ETH fallback tickSize 0.01 - may cause order rejection!`);
            } else {
                // For other coins, use 0.01 as default (most common)
                actualTickSize = 0.01;
                decimals = 2;
                logger.warn(`⚠️ No contract specs cached for ${symbol}, using fallback tickSize 0.01 - may cause order rejection!`);
            }
        }
    } else if (!actualTickSize && !symbol) {
        logger.warn(`⚠️ roundToTickSize called without symbol or tickSize - using fallback 0.01 - may cause order rejection!`);
    }

    // Fallback to 0.01 if no specs available (no symbol provided)
    if (!actualTickSize) {
        actualTickSize = 0.01;
        decimals = 2;
    }

    if (!Number.isFinite(actualTickSize) || actualTickSize <= 0) {
        throw new Error(`Invalid tickSize: ${actualTickSize}`);
    }

    // FIXED: Allow up to 18 decimals to match contract validation
    // For high decimals (>8), we use string-based arithmetic instead of integer arithmetic
    // to avoid overflow while maintaining precision
    if (decimals > 18) {
        throw new Error(`Decimals ${decimals} exceeds maximum 18`);
    }

    // For decimals > 8, use direct decimal rounding to avoid integer overflow
    if (decimals > 8) {
        // Calculate how many tick sizes fit in the price
        const tickCount = Math.round(price / actualTickSize);
        const rounded = tickCount * actualTickSize;

        if (!Number.isFinite(rounded) || rounded <= 0) {
            throw new Error(`Invalid rounded result: ${rounded} (price: ${price}, tickSize: ${actualTickSize})`);
        }

        const result = rounded.toFixed(decimals);

        // Final validation
        if (result === 'NaN' || result === 'Infinity' || result === '-Infinity') {
            throw new Error(`Invalid final result: ${result} (price: ${price}, tickSize: ${actualTickSize}, decimals: ${decimals})`);
        }

        if (parseFloat(result) === 0) {
            throw new Error(`Final result is zero (price: ${price}, tickSize: ${actualTickSize}, decimals: ${decimals})`);
        }

        return result;
    }

    // Use integer arithmetic for decimals <= 8 (safe and precise)
    const multiplier = Math.pow(10, decimals);

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new Error(`Invalid multiplier ${multiplier} for decimals ${decimals}`);
    }

    const priceInSmallestUnit = Math.round(price * multiplier);
    const tickInSmallestUnit = Math.round(actualTickSize * multiplier);

    if (tickInSmallestUnit === 0) {
        throw new Error(`tickInSmallestUnit is zero (tickSize: ${actualTickSize}, decimals: ${decimals}) - cannot round`);
    }

    if (!Number.isSafeInteger(priceInSmallestUnit)) {
        throw new Error(`Integer overflow: priceInSmallestUnit ${priceInSmallestUnit} exceeds MAX_SAFE_INTEGER (price: ${price}, decimals: ${decimals})`);
    }
    if (!Number.isSafeInteger(tickInSmallestUnit)) {
        throw new Error(`Integer overflow: tickInSmallestUnit ${tickInSmallestUnit} exceeds MAX_SAFE_INTEGER (tickSize: ${actualTickSize}, decimals: ${decimals})`);
    }

    const roundedInSmallestUnit = Math.round(priceInSmallestUnit / tickInSmallestUnit) * tickInSmallestUnit;
    const rounded = roundedInSmallestUnit / multiplier;

    if (!Number.isFinite(rounded) || rounded <= 0) {
        throw new Error(`Invalid rounded result: ${rounded} (price: ${price}, tickSize: ${actualTickSize})`);
    }

    const result = rounded.toFixed(decimals);

    // Final validation - all checks are necessary to prevent invalid API calls
    if (result === 'NaN' || result === 'Infinity' || result === '-Infinity') {
        throw new Error(`Invalid final result: ${result} (price: ${price}, tickSize: ${actualTickSize}, decimals: ${decimals})`);
    }

    if (parseFloat(result) === 0) {
        throw new Error(`Final result is zero (price: ${price}, tickSize: ${actualTickSize}, decimals: ${decimals})`);
    }

    return result;
}

/**
 * Validate WEEX order parameters before submission
 * Throws error if any parameter is invalid
 * 
 * @param order - Order parameters to validate
 */
export function validateWeexOrder(order: {
    symbol: string;
    size: string;
    price: string;
    type: '1' | '2' | '3' | '4';
    order_type: '0' | '1' | '2' | '3';
    match_price: '0' | '1';
    client_oid?: string;
}): void {
    // Validate symbol format
    if (!order.symbol || !order.symbol.startsWith('cmt_') || !order.symbol.endsWith('usdt')) {
        throw new Error(`Invalid symbol format: ${order.symbol} (must be cmt_xxxusdt)`);
    }

    // Get contract specs for validation
    const specs = getContractSpecs(order.symbol);

    // Validate size
    const size = parseFloat(order.size);
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid size: ${order.size}`);
    }

    // Use contract-specific minimum or fallback to 0.0001
    const minSize = specs?.minOrderSize ?? 0.0001;
    if (size < minSize) {
        throw new Error(`Size ${order.size} below minimum ${minSize} for ${order.symbol}`);
    }

    // Validate against maximum size if specs available
    if (specs && size > specs.maxOrderSize) {
        throw new Error(`Size ${order.size} exceeds maximum ${specs.maxOrderSize} for ${order.symbol}`);
    }

    // Validate price
    const price = parseFloat(order.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price: ${order.price}`);
    }

    // Validate order type
    if (!['1', '2', '3', '4'].includes(order.type)) {
        throw new Error(`Invalid order type: ${order.type}`);
    }

    // Validate order execution type
    if (!['0', '1', '2', '3'].includes(order.order_type)) {
        throw new Error(`Invalid order_type: ${order.order_type}`);
    }

    // Validate match_price
    if (!['0', '1'].includes(order.match_price)) {
        throw new Error(`Invalid match_price: ${order.match_price}`);
    }

    // Validate client_oid length if provided
    if (order.client_oid && order.client_oid.length > 40) {
        throw new Error(`client_oid exceeds 40 characters: ${order.client_oid.length}`);
    }
}

/**
 * Validate leverage is within WEEX limits
 * 
 * @param leverage - Requested leverage
 * @param symbol - Trading pair symbol (optional, for contract-specific limits)
 * @param maxLeverage - Manual override for maximum leverage (optional)
 * @returns Clamped leverage value
 */
export function validateLeverage(leverage: number, symbol?: string, maxLeverage?: number): number {
    if (!Number.isFinite(leverage) || leverage < 1) {
        throw new Error(`Invalid leverage: ${leverage} (must be >= 1)`);
    }

    // Get contract-specific max leverage if symbol provided
    let actualMaxLeverage = maxLeverage;
    if (!actualMaxLeverage && symbol) {
        const specs = getContractSpecs(symbol);
        if (specs) {
            actualMaxLeverage = specs.maxLeverage;
        }
    }

    // Fallback to 500 (WEEX default)
    if (!actualMaxLeverage) {
        actualMaxLeverage = 500;
    }

    if (leverage > actualMaxLeverage) {
        return actualMaxLeverage;
    }

    return Math.floor(leverage);
}
