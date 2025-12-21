/**
 * Market Hours Service
 * 
 * Validates trading hours, handles market holidays, and manages pending orders
 * for after-hours trading attempts.
 */

import { MarketStatus } from '../../types/trading';

export class MarketHoursService {
    // Extended holiday list through 2027
    private readonly NYSE_HOLIDAYS: string[] = [
        // 2024
        '2024-12-25', // Christmas
        // 2025
        '2025-01-01', // New Year's Day
        '2025-01-20', // MLK Day
        '2025-02-17', // Presidents Day
        '2025-04-18', // Good Friday
        '2025-05-26', // Memorial Day
        '2025-07-04', // Independence Day
        '2025-09-01', // Labor Day
        '2025-11-27', // Thanksgiving
        '2025-12-25', // Christmas
        // 2026
        '2026-01-01', // New Year's Day
        '2026-01-19', // MLK Day
        '2026-02-16', // Presidents Day
        '2026-04-03', // Good Friday
        '2026-05-25', // Memorial Day
        '2026-07-03', // Independence Day (observed)
        '2026-09-07', // Labor Day
        '2026-11-26', // Thanksgiving
        '2026-12-25', // Christmas
        // 2027
        '2027-01-01', // New Year's Day
        '2027-01-18', // MLK Day
        '2027-02-15', // Presidents Day
        '2027-03-26', // Good Friday
        '2027-05-31', // Memorial Day
        '2027-07-05', // Independence Day (observed)
        '2027-09-06', // Labor Day
        '2027-11-25', // Thanksgiving
        '2027-12-24', // Christmas (observed)
    ];

    getMarketStatus(timestamp: number = Date.now()): MarketStatus {
        const etDate = this.toEasternTime(new Date(timestamp));
        const dayOfWeek = etDate.getDay();
        const dateString = this.formatDateString(etDate);

        // Check if weekend
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return {
                isOpen: false,
                currentStatus: 'CLOSED',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'weekend'
            };
        }

        // Check if holiday
        if (this.NYSE_HOLIDAYS.includes(dateString)) {
            return {
                isOpen: false,
                currentStatus: 'CLOSED',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'holiday',
                holidayName: this.getHolidayName(dateString)
            };
        }

        // Check market hours (9:30 AM - 4:00 PM ET)
        const hours = etDate.getHours();
        const minutes = etDate.getMinutes();
        const timeInMinutes = hours * 60 + minutes;

        const marketOpen = 9 * 60 + 30; // 9:30 AM
        const marketClose = 16 * 60; // 4:00 PM

        if (timeInMinutes < marketOpen) {
            return {
                isOpen: false,
                currentStatus: 'PRE_MARKET',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'pre_market'
            };
        }

        if (timeInMinutes >= marketClose) {
            return {
                isOpen: false,
                currentStatus: 'AFTER_HOURS',
                nextOpen: this.getNextMarketOpen(timestamp),
                nextClose: this.getNextMarketClose(timestamp),
                reason: 'after_hours'
            };
        }

        return {
            isOpen: true,
            currentStatus: 'OPEN',
            nextOpen: this.getNextMarketOpen(timestamp),
            nextClose: this.getNextMarketClose(timestamp)
        };
    }

    /**
     * Convert a date to Eastern Time using Intl API
     * Returns a Date object with hours/minutes in ET
     */
    private toEasternTime(date: Date): Date {
        try {
            // Get the time components in Eastern timezone
            const options: Intl.DateTimeFormatOptions = {
                timeZone: 'America/New_York',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            };

            const formatter = new Intl.DateTimeFormat('en-US', options);
            const parts = formatter.formatToParts(date);

            const getPart = (type: string): number => {
                const part = parts.find(p => p.type === type);
                return part ? parseInt(part.value, 10) : 0;
            };

            // Create a new date with ET components
            // Note: This date object's internal timestamp won't be accurate,
            // but the getHours(), getMinutes(), etc. will return ET values
            return new Date(
                getPart('year'),
                getPart('month') - 1,
                getPart('day'),
                getPart('hour'),
                getPart('minute'),
                getPart('second')
            );
        } catch (error) {
            console.warn('Failed to convert to ET using Intl API, using fallback');
            // Fallback: assume EST (UTC-5) - not DST aware
            const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
            return new Date(utcTime - (5 * 60 * 60 * 1000));
        }
    }

    /**
     * Format date as YYYY-MM-DD string in Eastern Time
     */
    private formatDateString(etDate: Date): string {
        const year = etDate.getFullYear();
        const month = String(etDate.getMonth() + 1).padStart(2, '0');
        const day = String(etDate.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private getNextMarketOpen(timestamp: number): number {
        const etDate = this.toEasternTime(new Date(timestamp));
        const hours = etDate.getHours();
        const minutes = etDate.getMinutes();
        const timeInMinutes = hours * 60 + minutes;
        const marketOpen = 9 * 60 + 30;

        // If before 9:30 AM today and it's a weekday
        if (timeInMinutes < marketOpen && etDate.getDay() >= 1 && etDate.getDay() <= 5) {
            const todayString = this.formatDateString(etDate);
            if (!this.NYSE_HOLIDAYS.includes(todayString)) {
                etDate.setHours(9, 30, 0, 0);
                return etDate.getTime();
            }
        }

        // Otherwise, find next trading day at 9:30 AM
        let nextDay = new Date(etDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(9, 30, 0, 0);

        // Skip weekends and holidays
        while (nextDay.getDay() === 0 || nextDay.getDay() === 6 ||
            this.NYSE_HOLIDAYS.includes(this.formatDateString(nextDay))) {
            nextDay.setDate(nextDay.getDate() + 1);
        }

        return nextDay.getTime();
    }

    private getNextMarketClose(timestamp: number): number {
        const etDate = this.toEasternTime(new Date(timestamp));
        const hours = etDate.getHours();
        const minutes = etDate.getMinutes();
        const timeInMinutes = hours * 60 + minutes;
        const marketClose = 16 * 60;

        // If before 4:00 PM today and it's a weekday
        if (timeInMinutes < marketClose && etDate.getDay() >= 1 && etDate.getDay() <= 5) {
            const todayString = this.formatDateString(etDate);
            if (!this.NYSE_HOLIDAYS.includes(todayString)) {
                etDate.setHours(16, 0, 0, 0);
                return etDate.getTime();
            }
        }

        // Otherwise, find next trading day at 4:00 PM
        let nextDay = new Date(etDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(16, 0, 0, 0);

        // Skip weekends and holidays
        while (nextDay.getDay() === 0 || nextDay.getDay() === 6 ||
            this.NYSE_HOLIDAYS.includes(this.formatDateString(nextDay))) {
            nextDay.setDate(nextDay.getDate() + 1);
        }

        return nextDay.getTime();
    }

    private getHolidayName(dateString: string): string {
        const holidays: Record<string, string> = {
            '2024-12-25': 'Christmas',
            '2025-01-01': 'New Year\'s Day',
            '2025-01-20': 'Martin Luther King Jr. Day',
            '2025-02-17': 'Presidents Day',
            '2025-04-18': 'Good Friday',
            '2025-05-26': 'Memorial Day',
            '2025-07-04': 'Independence Day',
            '2025-09-01': 'Labor Day',
            '2025-11-27': 'Thanksgiving',
            '2025-12-25': 'Christmas',
            '2026-01-01': 'New Year\'s Day',
            '2026-01-19': 'Martin Luther King Jr. Day',
            '2026-02-16': 'Presidents Day',
            '2026-04-03': 'Good Friday',
            '2026-05-25': 'Memorial Day',
            '2026-07-03': 'Independence Day (observed)',
            '2026-09-07': 'Labor Day',
            '2026-11-26': 'Thanksgiving',
            '2026-12-25': 'Christmas',
            '2027-01-01': 'New Year\'s Day',
            '2027-01-18': 'Martin Luther King Jr. Day',
            '2027-02-15': 'Presidents Day',
            '2027-03-26': 'Good Friday',
            '2027-05-31': 'Memorial Day',
            '2027-07-05': 'Independence Day (observed)',
            '2027-09-06': 'Labor Day',
            '2027-11-25': 'Thanksgiving',
            '2027-12-24': 'Christmas (observed)'
        };
        return holidays[dateString] || 'Market Holiday';
    }

    isMarketOpen(timestamp: number = Date.now()): boolean {
        return this.getMarketStatus(timestamp).isOpen;
    }

    getMarketStatusMessage(status: MarketStatus): string {
        if (status.isOpen) {
            return 'Market is open';
        }

        const nextOpenDate = new Date(status.nextOpen);
        const nextOpenStr = nextOpenDate.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short'
        });

        if (status.reason === 'weekend') {
            return `Market closed for the weekend. Opens ${nextOpenStr}`;
        } else if (status.reason === 'holiday') {
            return `Market closed for ${status.holidayName}. Opens ${nextOpenStr}`;
        } else if (status.reason === 'after_hours') {
            return `Market closed (after hours). Opens ${nextOpenStr}`;
        } else if (status.reason === 'pre_market') {
            return `Market closed (pre-market). Opens ${nextOpenStr}`;
        }

        return `Market closed. Opens ${nextOpenStr}`;
    }
}

export const marketHoursService = new MarketHoursService();
