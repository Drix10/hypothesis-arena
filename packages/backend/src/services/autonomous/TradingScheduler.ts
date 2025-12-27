/**
 * Trading Scheduler
 * 
 * Intelligently schedules trading based on:
 * - Time zones (US, Europe, Asia trading hours)
 * - Market activity patterns
 * - Crypto market volatility cycles
 */

import { logger } from '../../utils/logger';

export interface MarketActivity {
    region: 'US' | 'EUROPE' | 'ASIA' | 'TRANSITION';
    activityLevel: 'low' | 'medium' | 'high' | 'peak';
    tradingMultiplier: number; // 0.5 - 2.0
}

export class TradingScheduler {
    /**
     * Get current market activity based on UTC time
     * 
     * Trading hours by region (UTC times are constant, no DST):
     * - US (Eastern): Typically 14:30 - 21:00 UTC (9:30 AM - 4:00 PM ET)
     * - Europe (London): Typically 8:00 - 16:30 UTC (8:00 AM - 4:30 PM GMT/BST)
     * - Asia (Tokyo): Typically 0:00 - 6:00 UTC (9:00 AM - 3:00 PM JST)
     * 
     * Note: These are approximate. Actual market activity varies.
     * Crypto markets are 24/7 but activity peaks during these hours.
     * 
     * EDGE CASES HANDLED:
     * - Floating point precision at hour boundaries
     * - Invalid date objects
     */
    getCurrentMarketActivity(): MarketActivity {
        const now = new Date();

        // Validate date
        if (isNaN(now.getTime())) {
            logger.error('Invalid date in getCurrentMarketActivity, using current time');
            return {
                region: 'US',
                activityLevel: 'medium',
                tradingMultiplier: 1.0,
            };
        }

        const utcHour = now.getUTCHours();
        const utcMinutes = now.getUTCMinutes();

        // Asia trading hours (0:00 - 6:00 UTC)
        // Use >= 0 and < 6 to avoid floating point issues
        if (utcHour >= 0 && utcHour < 6) {
            const activityLevel = (utcHour >= 1 && utcHour < 5) ? 'high' : 'medium';
            return {
                region: 'ASIA',
                activityLevel,
                tradingMultiplier: activityLevel === 'high' ? 1.5 : 1.2,
            };
        }

        // TRANSITION period (6:00 - 8:00 UTC) - Asia closing, pre-Europe open
        // Low-activity window between major trading sessions
        if (utcHour >= 6 && utcHour < 8) {
            return {
                region: 'TRANSITION',
                activityLevel: 'low',
                tradingMultiplier: 0.7,
            };
        }

        // Europe trading hours (8:00 - 16:30 UTC)
        if (utcHour >= 8 && (utcHour < 16 || (utcHour === 16 && utcMinutes < 30))) {
            const activityLevel = (utcHour >= 9 && utcHour < 15) ? 'high' : 'medium';
            return {
                region: 'EUROPE',
                activityLevel,
                tradingMultiplier: activityLevel === 'high' ? 1.6 : 1.3,
            };
        }

        // US trading hours (14:30 - 21:00 UTC)
        if ((utcHour === 14 && utcMinutes >= 30) || (utcHour > 14 && utcHour < 21)) {
            // Peak overlap with Europe (14:30 - 16:30 UTC)
            const isPeakOverlap = (utcHour === 14 && utcMinutes >= 30) ||
                (utcHour === 15) ||
                (utcHour === 16 && utcMinutes < 30);
            const activityLevel = isPeakOverlap ? 'peak' : 'high';
            return {
                region: 'US',
                activityLevel,
                tradingMultiplier: isPeakOverlap ? 2.0 : 1.7,
            };
        }

        // Off-hours (low activity)
        return {
            region: 'US',
            activityLevel: 'low',
            tradingMultiplier: 0.5,
        };
    }

    /**
     * Calculate if it's a good time to trade based on market activity
     */
    shouldTradeNow(): { shouldTrade: boolean; reason: string; multiplier: number } {
        const activity = this.getCurrentMarketActivity();

        // Always allow trading but adjust frequency
        if (activity.activityLevel === 'low') {
            return {
                shouldTrade: true,
                reason: `Low activity (${activity.region} off-hours) - reduced trading frequency`,
                multiplier: activity.tradingMultiplier,
            };
        }

        if (activity.activityLevel === 'peak') {
            return {
                shouldTrade: true,
                reason: `Peak activity (${activity.region} + overlap) - maximum trading frequency`,
                multiplier: activity.tradingMultiplier,
            };
        }

        return {
            shouldTrade: true,
            reason: `${activity.activityLevel} activity (${activity.region} hours)`,
            multiplier: activity.tradingMultiplier,
        };
    }

    /**
     * Calculate dynamic cycle interval based on market activity
     * 
     * EDGE CASES HANDLED:
     * - Zero or negative baseIntervalMs
     * - NaN or Infinity values
     * - Bounds checking on result
     * 
     * @param baseIntervalMs - Base cycle interval (e.g., 5 minutes)
     * @returns Adjusted interval in milliseconds (always >= 1000ms)
     */
    getDynamicCycleInterval(baseIntervalMs: number): number {
        // Validate input
        if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
            logger.warn(`Invalid baseIntervalMs: ${baseIntervalMs}, using default 300000`);
            baseIntervalMs = 300000; // 5 minutes default
        }

        const activity = this.getCurrentMarketActivity();

        // Adjust cycle frequency based on market activity
        let multiplier: number;
        switch (activity.activityLevel) {
            case 'peak':
                multiplier = 0.5; // 2x faster (2.5 min)
                break;
            case 'high':
                multiplier = 0.75; // 1.33x faster (3.75 min)
                break;
            case 'medium':
                multiplier = 1.0; // Normal speed (5 min)
                break;
            case 'low':
                multiplier = 2.0; // 2x slower (10 min)
                break;
            default:
                multiplier = 1.0;
        }

        const result = baseIntervalMs * multiplier;

        // Ensure result is valid and has minimum of 1 second
        return Math.max(1000, Math.min(3600000, result)); // Min 1s, Max 1 hour
    }

    /**
     * Get time until next peak trading period
     * 
     * EDGE CASES HANDLED:
     * - Negative time calculations
     * - Minutes exceeding 59
     * - NaN values
     */
    getTimeUntilPeakTrading(): { hours: number; minutes: number; nextRegion: string } {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMinutes = now.getUTCMinutes();
        const currentTimeDecimal = utcHour + (utcMinutes / 60);

        // Peak times: US-Europe overlap (14:30 - 16:30 UTC)
        const peakStart = 14.5;
        const peakEnd = 16.5;

        let hoursUntilPeak: number;
        let nextRegion: string;

        if (currentTimeDecimal < peakStart) {
            // Before peak today
            hoursUntilPeak = peakStart - currentTimeDecimal;
            nextRegion = 'US-Europe overlap';
        } else if (currentTimeDecimal >= peakStart && currentTimeDecimal < peakEnd) {
            // Currently in peak
            hoursUntilPeak = 0;
            nextRegion = 'US-Europe overlap (NOW)';
        } else {
            // After peak, wait until tomorrow
            hoursUntilPeak = (24 - currentTimeDecimal) + peakStart;
            nextRegion = 'US-Europe overlap (tomorrow)';
        }

        // Validate and clamp values
        if (!Number.isFinite(hoursUntilPeak) || hoursUntilPeak < 0) {
            hoursUntilPeak = 0;
        }

        const hours = Math.floor(hoursUntilPeak);
        const minutesDecimal = (hoursUntilPeak - hours) * 60;
        const minutes = Math.min(59, Math.max(0, Math.round(minutesDecimal))); // Clamp 0-59

        return { hours, minutes, nextRegion };
    }

    /**
     * Log current market conditions
     */
    logMarketConditions(): void {
        const activity = this.getCurrentMarketActivity();
        const tradingStatus = this.shouldTradeNow();
        const nextPeak = this.getTimeUntilPeakTrading();

        logger.info('📊 Market Conditions:', {
            region: activity.region,
            activityLevel: activity.activityLevel,
            tradingMultiplier: activity.tradingMultiplier,
            shouldTrade: tradingStatus.shouldTrade,
            reason: tradingStatus.reason,
            nextPeakIn: `${nextPeak.hours}h ${nextPeak.minutes}m (${nextPeak.nextRegion})`,
        });
    }
}

export const tradingScheduler = new TradingScheduler();
