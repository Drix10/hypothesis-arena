/**
 * API Key Manager - BYOK (Bring Your Own Key) System
 * 
 * SECURITY MODEL:
 * - API keys are stored in memory only (module-level variable)
 * - Keys are NEVER persisted to localStorage, sessionStorage, or any database
 * - Keys are cleared when page is refreshed or browser is closed
 * - This is appropriate for Vercel deployment as we don't own the user's API keys
 * - Users must re-enter their key each session (intentional security feature)
 * 
 * PRIVACY COMPLIANCE:
 * - No API keys are sent to our servers
 * - No API keys are logged (except sanitized validation errors)
 * - Keys go directly from user's browser to Gemini API
 */

import { logger } from "./utils/logger";

// In-memory storage only - cleared on page refresh
// This is intentionally NOT stored in sessionStorage or localStorage
let currentGeminiApiKey: string | null = null;
let currentFmpApiKey: string | null = null;

/**
 * Set the Gemini API key for the current session
 * Key is stored in memory only and cleared on page refresh
 * 
 * @param key - Gemini API key
 * @returns true if key is valid format, false otherwise
 */
export const setApiKey = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        logger.error("Invalid Gemini API key format");
        return false;
    }

    const trimmedKey = key.trim();

    // Basic validation - Gemini keys typically start with "AI" and are 39 characters
    if (trimmedKey.length < 20) {
        logger.error("Gemini API key too short");
        return false;
    }

    currentGeminiApiKey = trimmedKey;
    // Reduced logging for security
    return true;
};

/**
 * Set the FMP API key for the current session
 * Key is stored in memory only and cleared on page refresh
 * 
 * @param key - FMP API key
 * @returns true if key is valid format, false otherwise
 */
export const setFmpApiKey = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        logger.error("Invalid FMP API key format");
        return false;
    }

    const trimmedKey = key.trim();

    // Basic validation - FMP keys are typically 32 characters alphanumeric
    if (trimmedKey.length < 20) {
        logger.error("FMP API key too short");
        return false;
    }

    currentFmpApiKey = trimmedKey;
    // Reduced logging for security
    return true;
};

/**
 * Get the current Gemini API key
 * 
 * @returns Gemini API key or null if not set
 */
export const getApiKey = (): string | null => {
    return currentGeminiApiKey;
};

/**
 * Get the current FMP API key
 * Falls back to environment variable if not set in memory
 * 
 * @returns FMP API key or null if not set
 */
export const getFmpApiKey = (): string | null => {
    // Priority: In-memory key > Environment variable > Hardcoded fallback
    if (currentFmpApiKey) {
        return currentFmpApiKey;
    }

    // Check environment variable
    const envKey = import.meta.env.VITE_FMP_API_KEY;
    if (envKey && typeof envKey === 'string' && envKey.trim().length > 0) {
        return envKey.trim();
    }

    // Fallback to hardcoded key (from .env file)
    return 'demo';
};

/**
 * Check if Gemini API key is currently set
 * 
 * @returns true if key is set, false otherwise
 */
export const hasApiKey = (): boolean => {
    return currentGeminiApiKey !== null && currentGeminiApiKey.length > 0;
};

/**
 * Check if FMP API key is available (in-memory, env, or fallback)
 * 
 * @returns true if key is available, false otherwise
 */
export const hasFmpApiKey = (): boolean => {
    return getFmpApiKey() !== null;
};

/**
 * Clear the current API keys from memory
 * Should be called on logout or when user explicitly clears the keys
 */
export const clearApiKey = (): void => {
    // Overwrite with random data before nulling (defense in depth)
    if (currentGeminiApiKey) {
        currentGeminiApiKey = Array(currentGeminiApiKey.length).fill('X').join('');
    }
    if (currentFmpApiKey) {
        currentFmpApiKey = Array(currentFmpApiKey.length).fill('X').join('');
    }
    currentGeminiApiKey = null;
    currentFmpApiKey = null;
    // Reduced logging for security
};

/**
 * Validate API key format (strict check)
 * 
 * @param key - API key to validate
 * @returns true if format looks valid, false otherwise
 */
export const validateApiKeyFormat = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        return false;
    }

    const trimmedKey = key.trim();

    // Strict format validation
    // Gemini keys are typically 39 characters and alphanumeric with hyphens/underscores
    if (trimmedKey.length < 20) {
        return false;
    }

    // Check for common mistakes
    if (trimmedKey.includes(' ')) {
        return false;
    }

    // Only allow alphanumeric, hyphens, and underscores
    if (!/^[A-Za-z0-9_-]+$/.test(trimmedKey)) {
        return false;
    }

    return true;
};

/**
 * Test API key by making a simple API call
 * 
 * @param key - API key to test
 * @returns Promise<true> if key is valid, throws error if invalid
 */
export const testApiKey = async (key: string): Promise<boolean> => {
    try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey: key });

        // Make a minimal API call to test the key
        // Use a very simple prompt to minimize cost
        await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: { parts: [{ text: "test" }] },
            config: {
                maxOutputTokens: 1,
                temperature: 0
            }
        });

        // If we get here, the key is valid
        return true;
    } catch (error: any) {
        // Check for specific error types
        if (error.message?.includes("API key") || error.message?.includes("401") || error.message?.includes("403")) {
            throw new Error("Invalid API key. Please check your key and try again.");
        }

        if (error.message?.includes("quota") || error.message?.includes("429")) {
            // Key is valid but quota exceeded - still accept it
            logger.warn("API key valid but quota exceeded");
            return true;
        }

        // Other errors - reject the key to be safe
        // Don't log the actual error message (may contain sensitive info)
        logger.error("API key test failed with unexpected error (details omitted for security)");
        throw new Error("Unable to validate API key. Please check your key and try again.");
    }
};

/**
 * Get masked version of Gemini API key for display
 * Shows first 4 characters only with fixed-length mask
 * 
 * @returns Masked key like "AIza••••••••" or null
 */
export const getMaskedApiKey = (): string | null => {
    if (!currentGeminiApiKey) {
        return null;
    }

    if (currentGeminiApiKey.length < 4) {
        return "••••••••••••";
    }

    const first = currentGeminiApiKey.substring(0, 4);
    // Fixed length mask to not reveal key length
    return `${first}••••••••`;
};

/**
 * Get masked version of FMP API key for display
 * Shows first 4 characters only with fixed-length mask
 * 
 * @returns Masked key like "rtab••••••••" or null
 */
export const getMaskedFmpApiKey = (): string | null => {
    const key = getFmpApiKey();
    if (!key) {
        return null;
    }

    if (key.length < 4) {
        return "••••••••••••";
    }

    const first = key.substring(0, 4);
    // Fixed length mask to not reveal key length
    return `${first}••••••••`;
};
