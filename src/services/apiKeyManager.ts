/**
 * API Key Manager - BYOK (Bring Your Own Key) System
 * 
 * This module manages user-provided API keys in memory only.
 * Keys are NEVER stored in localStorage or any persistent storage.
 * Keys are cleared when the page is refreshed or closed.
 */

import { logger } from "./utils/logger";

// In-memory storage only - cleared on page refresh
let currentApiKey: string | null = null;

/**
 * Set the API key for the current session
 * Key is stored in memory only and cleared on page refresh
 * 
 * @param key - Gemini API key
 * @returns true if key is valid format, false otherwise
 */
export const setApiKey = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        logger.error("Invalid API key format");
        return false;
    }

    const trimmedKey = key.trim();

    // Basic validation - Gemini keys typically start with "AI" and are 39 characters
    if (trimmedKey.length < 20) {
        logger.error("API key too short");
        return false;
    }

    currentApiKey = trimmedKey;
    logger.info("API key set successfully (stored in memory only)");
    return true;
};

/**
 * Get the current API key
 * 
 * @returns API key or null if not set
 */
export const getApiKey = (): string | null => {
    return currentApiKey;
};

/**
 * Check if an API key is currently set
 * 
 * @returns true if key is set, false otherwise
 */
export const hasApiKey = (): boolean => {
    return currentApiKey !== null && currentApiKey.length > 0;
};

/**
 * Clear the current API key from memory
 */
export const clearApiKey = (): void => {
    currentApiKey = null;
    logger.info("API key cleared from memory");
};

/**
 * Validate API key format (basic check)
 * 
 * @param key - API key to validate
 * @returns true if format looks valid, false otherwise
 */
export const validateApiKeyFormat = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        return false;
    }

    const trimmedKey = key.trim();

    // Basic format validation
    // Gemini keys are typically 39 characters and start with "AI"
    if (trimmedKey.length < 20) {
        return false;
    }

    // Check for common mistakes
    if (trimmedKey.includes(' ')) {
        return false;
    }

    return true;
};

/**
 * Get masked version of API key for display
 * Shows first 4 and last 4 characters only
 * 
 * @returns Masked key like "AIza...xyz" or null
 */
export const getMaskedApiKey = (): string | null => {
    if (!currentApiKey) {
        return null;
    }

    if (currentApiKey.length < 12) {
        return "****";
    }

    const first = currentApiKey.substring(0, 4);
    const last = currentApiKey.substring(currentApiKey.length - 4);
    return `${first}...${last}`;
};
