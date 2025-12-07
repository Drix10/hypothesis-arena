/**
 * Local Storage Persistence Utilities
 * Handles saving and loading tournament data with compression and error handling
 */

import { TournamentData } from "../../types";
import { logger } from "./logger";

const STORAGE_KEY = "hypothesis_arena_tournament";
const STORAGE_VERSION = "1.1"; // Incremented for migration support
const MAX_STORAGE_SIZE = 5 * 1024 * 1024; // 5MB limit for localStorage
// const USE_COMPRESSION = false; // Set to true to enable LZ-string compression (requires npm install lz-string)

interface StoredData {
    version: string;
    timestamp: number;
    data: TournamentData;
}

/**
 * Save tournament data to localStorage
 * Includes compression and size validation
 */
export const saveTournament = (data: TournamentData): boolean => {
    try {
        // Check if localStorage is available (fails in private browsing)
        if (typeof localStorage === 'undefined') {
            logger.warn("localStorage not available (private browsing?)");
            return false;
        }

        // Test if localStorage is actually writable
        try {
            localStorage.setItem('__test__', 'test');
            localStorage.removeItem('__test__');
        } catch (e) {
            logger.warn("localStorage not writable (private browsing or disabled)");
            return false;
        }

        const stored: StoredData = {
            version: STORAGE_VERSION,
            timestamp: Date.now(),
            data,
        };

        const serialized = JSON.stringify(stored);

        // Check size before saving
        const sizeInBytes = new Blob([serialized]).size;
        if (sizeInBytes > MAX_STORAGE_SIZE) {
            logger.warn(
                `Tournament data too large to save (${(sizeInBytes / 1024 / 1024).toFixed(2)}MB). ` +
                `Maximum is ${MAX_STORAGE_SIZE / 1024 / 1024}MB.`
            );
            return false;
        }

        localStorage.setItem(STORAGE_KEY, serialized);
        logger.info(`Tournament saved successfully (${(sizeInBytes / 1024).toFixed(1)}KB)`);
        return true;
    } catch (error: any) {
        // Handle QuotaExceededError
        if (error.name === 'QuotaExceededError') {
            logger.error("localStorage quota exceeded. Cannot save tournament.");
        } else {
            logger.error("Failed to save tournament:", error);
        }
        return false;
    }
};

/**
 * Load tournament data from localStorage
 * Includes version checking and comprehensive validation
 */
export const loadTournament = (): TournamentData | null => {
    try {
        const serialized = localStorage.getItem(STORAGE_KEY);
        if (!serialized) {
            return null;
        }

        const stored: StoredData = JSON.parse(serialized);

        // Version check and migration
        if (stored.version !== STORAGE_VERSION) {
            logger.warn(
                `Stored tournament version (${stored.version}) doesn't match current version (${STORAGE_VERSION}). ` +
                `Attempting migration...`
            );
            stored.data = migrateTournamentData(stored.data, stored.version, STORAGE_VERSION);
            stored.version = STORAGE_VERSION;
        }

        // Age check (optional: warn if data is old)
        const ageInDays = (Date.now() - stored.timestamp) / (1000 * 60 * 60 * 24);
        if (ageInDays > 7) {
            logger.warn(`Loaded tournament is ${ageInDays.toFixed(1)} days old`);
        }

        // Basic validation
        if (!stored.data || !stored.data.tournamentId || !Array.isArray(stored.data.agents)) {
            logger.error("Stored tournament data is malformed");
            return null;
        }

        // CRITICAL: Deep validation using validationUtils
        // This prevents corrupted or malicious data from crashing the app
        try {
            const { validateAndRepairTournament } = require("./validationUtils");
            const validated = validateAndRepairTournament(stored.data);
            logger.info(`Tournament loaded and validated successfully (ID: ${validated.tournamentId})`);
            return validated;
        } catch (validationError: any) {
            logger.error("Tournament data failed validation:", validationError.message);
            // Clear corrupted data
            clearTournament();
            return null;
        }
    } catch (error) {
        logger.error("Failed to load tournament:", error);
        return null;
    }
};

/**
 * Clear tournament data from localStorage
 */
export const clearTournament = (): void => {
    try {
        localStorage.removeItem(STORAGE_KEY);
        logger.info("Tournament data cleared from storage");
    } catch (error) {
        logger.error("Failed to clear tournament:", error);
    }
};

/**
 * Export tournament data as JSON file for download
 */
export const exportTournament = (data: TournamentData): void => {
    try {
        const exported: StoredData = {
            version: STORAGE_VERSION,
            timestamp: Date.now(),
            data,
        };

        const json = JSON.stringify(exported, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `tournament_${data.tournamentId}_${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Clean up blob URL
        setTimeout(() => URL.revokeObjectURL(url), 100);

        logger.info("Tournament exported successfully");
    } catch (error) {
        logger.error("Failed to export tournament:", error);
    }
};

/**
 * Import tournament data from JSON file
 */
export const importTournament = (file: File): Promise<TournamentData | null> => {
    return new Promise((resolve) => {
        try {
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const json = e.target?.result as string;
                    const stored: StoredData = JSON.parse(json);

                    // Validate structure
                    if (!stored.data || !stored.data.tournamentId) {
                        logger.error("Invalid tournament file format");
                        resolve(null);
                        return;
                    }

                    logger.info(`Tournament imported successfully (ID: ${stored.data.tournamentId})`);
                    resolve(stored.data);
                } catch (error) {
                    logger.error("Failed to parse tournament file:", error);
                    resolve(null);
                }
            };

            reader.onerror = () => {
                logger.error("Failed to read tournament file");
                resolve(null);
            };

            reader.readAsText(file);
        } catch (error) {
            logger.error("Failed to import tournament:", error);
            resolve(null);
        }
    });
};

/**
 * Migrate tournament data between versions
 * Handles backward compatibility when data structure changes
 */
const migrateTournamentData = (
    data: TournamentData,
    fromVersion: string,
    toVersion: string
): TournamentData => {
    logger.info(`Migrating tournament data from ${fromVersion} to ${toVersion}`);

    let migrated = { ...data };

    // Migration path: 1.0 -> 1.1
    if (fromVersion === "1.0" && toVersion === "1.1") {
        // Example migration: Add new fields with defaults
        // migrated.matches = migrated.matches.map(m => ({
        //     ...m,
        //     newField: "default value"
        // }));
        logger.info("Migration 1.0 -> 1.1: No schema changes required");
    }

    // Future migrations can be chained here
    // if (fromVersion === "1.1" && toVersion === "1.2") { ... }

    return migrated;
};

/**
 * Get storage usage information
 */
export const getStorageInfo = (): { used: number; available: number; percentage: number } => {
    try {
        let used = 0;
        for (const key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                used += localStorage[key].length + key.length;
            }
        }

        // localStorage typically has 5-10MB limit
        const available = MAX_STORAGE_SIZE;
        const percentage = (used / available) * 100;

        return { used, available, percentage };
    } catch (error) {
        logger.error("Failed to get storage info:", error);
        return { used: 0, available: MAX_STORAGE_SIZE, percentage: 0 };
    }
};
