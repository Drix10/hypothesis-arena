/**
 * Price Validation Service
 * 
 * Validates price data for staleness, suspicious movements, and validity
 * before executing trades.
 */

import { PriceValidation } from '../../types/trading';

export class PriceValidationService {
    // Configurable thresholds
    private stalenessThresholdSeconds: number = 5 * 60; // 5 minutes default
    private readonly SUSPICIOUS_MOVE_THRESHOLD = 0.2; // 20% move

    /**
     * Set the staleness threshold in seconds
     * @returns true if threshold was set, false if invalid value
     */
    setStalenessThreshold(seconds: number): boolean {
        if (seconds > 0 && Number.isFinite(seconds)) {
            this.stalenessThresholdSeconds = seconds;
            return true;
        }
        console.warn(`Invalid staleness threshold: ${seconds}. Must be positive finite number.`);
        return false;
    }

    validatePrice(
        ticker: string,
        price: number,
        timestamp: number,
        previousPrice?: number,
        source: 'FMP' | 'YAHOO' | 'CACHE' = 'FMP'
    ): PriceValidation {
        const now = Date.now();

        // Validate timestamp - log if normalized
        let validTimestamp = timestamp;
        if (!timestamp || timestamp <= 0 || timestamp > now) {
            validTimestamp = now; // Use current time if invalid
            if (timestamp && timestamp > 0) {
                console.warn(`Price timestamp for ${ticker} is in the future (${new Date(timestamp).toISOString()}), using current time`);
            }
        }

        const ageSeconds = Math.floor((now - validTimestamp) / 1000);
        const isStale = ageSeconds > this.stalenessThresholdSeconds;

        let isSuspicious = false;
        let warning: string | undefined;

        // Check for invalid prices
        if (price <= 0 || !Number.isFinite(price)) {
            isSuspicious = true;
            warning = 'Invalid price: must be greater than 0';
        }
        // Check for suspicious price movements
        else if (previousPrice && previousPrice > 0) {
            const priceChange = Math.abs((price - previousPrice) / previousPrice);
            if (priceChange > this.SUSPICIOUS_MOVE_THRESHOLD) {
                isSuspicious = true;
                warning = `Unusual price movement: ${(priceChange * 100).toFixed(1)}% change`;
            }
        }

        // Check for staleness
        if (isStale && !warning) {
            warning = `Price is ${Math.floor(ageSeconds / 60)} minutes old`;
        }

        return {
            ticker,
            price,
            timestamp: validTimestamp,
            ageSeconds,
            isStale,
            isSuspicious,
            warning,
            source
        };
    }

    isPriceValid(validation: PriceValidation): boolean {
        return !validation.isSuspicious && validation.price > 0;
    }

    getPriceWarning(validation: PriceValidation): string | null {
        if (validation.isSuspicious) {
            return validation.warning || 'Price data appears suspicious';
        }
        if (validation.isStale) {
            return validation.warning || 'Price data is stale';
        }
        return null;
    }
}

export const priceValidationService = new PriceValidationService();
