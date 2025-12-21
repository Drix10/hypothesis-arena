/**
 * API Key Manager - BYOK (Bring Your Own Key) System
 * 
 * SECURITY MODEL:
 * - API keys can optionally be persisted to localStorage (user opt-in)
 * - Keys are encrypted with a simple obfuscation (not cryptographically secure, but prevents casual viewing)
 * - Users can choose to save keys for convenience or keep them session-only
 * - Keys go directly from user's browser to respective APIs
 * 
 * PRIVACY COMPLIANCE:
 * - No API keys are sent to our servers
 * - No API keys are logged (except sanitized validation errors)
 * - Persistence is opt-in only
 */

import { logger } from "./utils/logger";

// Storage keys
const STORAGE_KEY_GEMINI = 'hypothesis_arena_gemini_key';
const STORAGE_KEY_FMP = 'hypothesis_arena_fmp_key';
const STORAGE_KEY_PERSIST = 'hypothesis_arena_persist_keys';

// In-memory storage
let currentGeminiApiKey: string | null = null;
let currentFmpApiKey: string | null = null;

/**
 * Simple obfuscation for localStorage (not cryptographically secure)
 * Just prevents casual viewing of keys in dev tools
 */
const obfuscate = (str: string): string => {
    return btoa(str.split('').reverse().join(''));
};

const deobfuscate = (str: string): string => {
    try {
        return atob(str).split('').reverse().join('');
    } catch {
        return '';
    }
};

/**
 * Check if localStorage is available
 * Returns false in private browsing mode or when storage is disabled
 */
const isLocalStorageAvailable = (): boolean => {
    try {
        const testKey = '__storage_test__';
        localStorage.setItem(testKey, testKey);
        localStorage.removeItem(testKey);
        return true;
    } catch {
        return false;
    }
};

/**
 * Check if key persistence is enabled
 */
export const isPersistenceEnabled = (): boolean => {
    if (!isLocalStorageAvailable()) {
        return false;
    }
    try {
        return localStorage.getItem(STORAGE_KEY_PERSIST) === 'true';
    } catch {
        return false;
    }
};

/**
 * Enable or disable key persistence
 * Silently fails if localStorage is not available
 */
export const setPersistenceEnabled = (enabled: boolean): void => {
    if (!isLocalStorageAvailable()) {
        logger.warn("localStorage not available, persistence disabled");
        return;
    }

    try {
        if (enabled) {
            localStorage.setItem(STORAGE_KEY_PERSIST, 'true');
            // Save current keys if they exist
            if (currentGeminiApiKey) {
                localStorage.setItem(STORAGE_KEY_GEMINI, obfuscate(currentGeminiApiKey));
            }
            if (currentFmpApiKey) {
                localStorage.setItem(STORAGE_KEY_FMP, obfuscate(currentFmpApiKey));
            }
        } else {
            localStorage.removeItem(STORAGE_KEY_PERSIST);
            localStorage.removeItem(STORAGE_KEY_GEMINI);
            localStorage.removeItem(STORAGE_KEY_FMP);
        }
    } catch (e) {
        logger.error("Failed to update persistence setting");
    }
};

/**
 * Load saved keys from localStorage into memory
 * Only loads if persistence is enabled and localStorage is available
 */
export const loadSavedKeys = (): { geminiKey: string | null; fmpKey: string | null } => {
    let geminiKey: string | null = null;
    let fmpKey: string | null = null;

    // Only load saved keys if persistence is enabled and storage is available
    if (!isLocalStorageAvailable() || !isPersistenceEnabled()) {
        return { geminiKey, fmpKey };
    }

    try {
        const savedGemini = localStorage.getItem(STORAGE_KEY_GEMINI);
        const savedFmp = localStorage.getItem(STORAGE_KEY_FMP);

        if (savedGemini) {
            const decoded = deobfuscate(savedGemini);
            // Use same validation as setApiKey: length >= 20
            if (decoded && decoded.length >= 20) {
                geminiKey = decoded;
                currentGeminiApiKey = decoded;
            } else if (decoded) {
                // Invalid key in storage - clear it
                logger.warn("Invalid Gemini key in storage (too short), clearing");
                localStorage.removeItem(STORAGE_KEY_GEMINI);
            }
        }

        if (savedFmp) {
            const decoded = deobfuscate(savedFmp);
            // Use same validation as setFmpApiKey: length >= 20
            if (decoded && decoded.length >= 20) {
                fmpKey = decoded;
                currentFmpApiKey = decoded;
            } else if (decoded) {
                // Invalid key in storage - clear it
                logger.warn("Invalid FMP key in storage (too short), clearing");
                localStorage.removeItem(STORAGE_KEY_FMP);
            }
        }
    } catch (e) {
        logger.error("Failed to load saved keys");
    }

    return { geminiKey, fmpKey };
};

/**
 * Set the Gemini API key for the current session
 * Optionally persists to localStorage if persistence is enabled
 */
export const setApiKey = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        logger.error("Invalid Gemini API key format");
        return false;
    }

    const trimmedKey = key.trim();

    if (trimmedKey.length < 20) {
        logger.error("Gemini API key too short");
        return false;
    }

    currentGeminiApiKey = trimmedKey;

    // Persist if enabled
    if (isPersistenceEnabled()) {
        try {
            localStorage.setItem(STORAGE_KEY_GEMINI, obfuscate(trimmedKey));
        } catch (e) {
            logger.error("Failed to persist Gemini key");
        }
    }

    return true;
};

/**
 * Set the FMP API key for the current session
 * Optionally persists to localStorage if persistence is enabled
 */
export const setFmpApiKey = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        logger.error("Invalid FMP API key format");
        return false;
    }

    const trimmedKey = key.trim();

    if (trimmedKey.length < 20) {
        logger.error("FMP API key too short");
        return false;
    }

    currentFmpApiKey = trimmedKey;

    // Persist if enabled
    if (isPersistenceEnabled()) {
        try {
            localStorage.setItem(STORAGE_KEY_FMP, obfuscate(trimmedKey));
        } catch (e) {
            logger.error("Failed to persist FMP key");
        }
    }

    return true;
};

/**
 * Get the current Gemini API key
 */
export const getApiKey = (): string | null => {
    if (currentGeminiApiKey) {
        return currentGeminiApiKey;
    }

    // Check environment variable
    const envKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (envKey && typeof envKey === 'string' && envKey.trim().length > 0) {
        return envKey.trim();
    }

    return null;
};

/**
 * Get the current FMP API key
 */
export const getFmpApiKey = (): string | null => {
    if (currentFmpApiKey) {
        return currentFmpApiKey;
    }

    // Check environment variable
    const envKey = import.meta.env.VITE_FMP_API_KEY;
    if (envKey && typeof envKey === 'string' && envKey.trim().length > 0) {
        return envKey.trim();
    }

    return null;
};

/**
 * Check if Gemini API key is currently set (in-memory only, not env var)
 * Consistent with hasApiKey - checks in-memory key only
 */
export const hasApiKey = (): boolean => {
    return currentGeminiApiKey !== null && currentGeminiApiKey.length > 0;
};

/**
 * Check if FMP API key is currently set (in-memory only, not env var)
 * Consistent with hasApiKey - checks in-memory key only
 */
export const hasFmpApiKey = (): boolean => {
    return currentFmpApiKey !== null && currentFmpApiKey.length > 0;
};

/**
 * Clear the current API keys from memory and storage
 */
export const clearApiKey = (): void => {
    // Overwrite with random data before nulling
    if (currentGeminiApiKey) {
        currentGeminiApiKey = Array(currentGeminiApiKey.length).fill('X').join('');
    }
    if (currentFmpApiKey) {
        currentFmpApiKey = Array(currentFmpApiKey.length).fill('X').join('');
    }
    currentGeminiApiKey = null;
    currentFmpApiKey = null;

    // Clear from storage
    try {
        localStorage.removeItem(STORAGE_KEY_GEMINI);
        localStorage.removeItem(STORAGE_KEY_FMP);
    } catch (e) {
        // Ignore storage errors
    }
};

/**
 * Clear only the Gemini key
 */
export const clearGeminiKey = (): void => {
    if (currentGeminiApiKey) {
        currentGeminiApiKey = Array(currentGeminiApiKey.length).fill('X').join('');
    }
    currentGeminiApiKey = null;
    try {
        localStorage.removeItem(STORAGE_KEY_GEMINI);
    } catch (e) {
        // Ignore
    }
};

/**
 * Clear only the FMP key
 */
export const clearFmpKey = (): void => {
    if (currentFmpApiKey) {
        currentFmpApiKey = Array(currentFmpApiKey.length).fill('X').join('');
    }
    currentFmpApiKey = null;
    try {
        localStorage.removeItem(STORAGE_KEY_FMP);
    } catch (e) {
        // Ignore
    }
};

/**
 * Validate API key format
 */
export const validateApiKeyFormat = (key: string): boolean => {
    if (!key || typeof key !== 'string') {
        return false;
    }

    const trimmedKey = key.trim();

    if (trimmedKey.length < 20) {
        return false;
    }

    if (trimmedKey.includes(' ')) {
        return false;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(trimmedKey)) {
        return false;
    }

    return true;
};

/**
 * Test API key by making a simple API call
 */
export const testApiKey = async (key: string): Promise<boolean> => {
    try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey: key });

        await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: { parts: [{ text: "test" }] },
            config: {
                maxOutputTokens: 1,
                temperature: 0
            }
        });

        return true;
    } catch (error: any) {
        if (error.message?.includes("API key") || error.message?.includes("401") || error.message?.includes("403")) {
            throw new Error("Invalid API key. Please check your key and try again.");
        }

        if (error.message?.includes("quota") || error.message?.includes("429")) {
            logger.warn("API key valid but quota exceeded");
            return true;
        }

        logger.error("API key test failed with unexpected error");
        throw new Error("Unable to validate API key. Please check your key and try again.");
    }
};

/**
 * Get masked version of Gemini API key for display
 * Uses in-memory key only (not env var) for security
 */
export const getMaskedApiKey = (): string | null => {
    if (!currentGeminiApiKey) {
        return null;
    }

    if (currentGeminiApiKey.length < 4) {
        return "••••••••••••";
    }

    const first = currentGeminiApiKey.substring(0, 4);
    return `${first}••••••••`;
};

/**
 * Get masked version of FMP API key for display
 * Uses in-memory key only (not env var) for security
 */
export const getMaskedFmpApiKey = (): string | null => {
    if (!currentFmpApiKey) {
        return null;
    }

    if (currentFmpApiKey.length < 4) {
        return "••••••••••••";
    }

    const first = currentFmpApiKey.substring(0, 4);
    return `${first}••••••••`;
};
