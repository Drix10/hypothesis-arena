/**
 * Storage Service
 * Handles localStorage operations for saving/loading analyses, watchlist, and history
 */

import { StockAnalysisData, FinalRecommendation, InvestmentThesis } from '../types/stock';
import { TournamentResult } from './stock/stockTournamentService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SavedAnalysis {
    id: string;
    ticker: string;
    companyName: string;
    savedAt: number;
    stockData: StockAnalysisData;
    theses: InvestmentThesis[];
    tournamentResult: TournamentResult;
    recommendation: FinalRecommendation;
}

export interface WatchlistItem {
    ticker: string;
    name: string;
    addedAt: number;
    lastPrice?: number;
    lastUpdated?: number;
    notes?: string;
}

export interface HistoricalAccuracy {
    id: string;
    ticker: string;
    analysisDate: number;
    recommendation: FinalRecommendation['recommendation'];
    priceAtAnalysis: number;
    targetPrice: number;
    checkDate?: number;
    priceAtCheck?: number;
    wasAccurate?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ═══════════════════════════════════════════════════════════════════════════════

const STORAGE_KEYS = {
    SAVED_ANALYSES: 'hypothesis_arena_analyses',
    WATCHLIST: 'hypothesis_arena_watchlist',
    ACCURACY_HISTORY: 'hypothesis_arena_accuracy',
    SETTINGS: 'hypothesis_arena_settings'
};

const MAX_SAVED_ANALYSES = 50;
const MAX_WATCHLIST_ITEMS = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function safeGetItem<T>(key: string, defaultValue: T): T {
    try {
        const item = localStorage.getItem(key);
        if (!item) return defaultValue;
        const parsed = JSON.parse(item);
        // Basic validation: ensure parsed data is an array if default is array
        if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
            console.warn(`Invalid data structure in localStorage for key: ${key}`);
            return defaultValue;
        }
        return parsed as T;
    } catch {
        return defaultValue;
    }
}

function safeSetItem(key: string, value: unknown): boolean {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.error('Failed to save to localStorage:', e);
        return false;
    }
}

function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVED ANALYSES
// ═══════════════════════════════════════════════════════════════════════════════

export function saveAnalysis(
    stockData: StockAnalysisData,
    theses: InvestmentThesis[],
    tournamentResult: TournamentResult,
    recommendation: FinalRecommendation
): SavedAnalysis | null {
    const analyses = getSavedAnalyses();

    const newAnalysis: SavedAnalysis = {
        id: generateId(),
        ticker: stockData.ticker,
        companyName: stockData.profile.name,
        savedAt: Date.now(),
        stockData,
        theses,
        tournamentResult,
        recommendation
    };

    // Remove oldest if at capacity
    if (analyses.length >= MAX_SAVED_ANALYSES) {
        analyses.sort((a, b) => b.savedAt - a.savedAt);
        analyses.pop();
    }

    analyses.unshift(newAnalysis);

    if (safeSetItem(STORAGE_KEYS.SAVED_ANALYSES, analyses)) {
        return newAnalysis;
    }
    return null;
}

export function getSavedAnalyses(): SavedAnalysis[] {
    return safeGetItem<SavedAnalysis[]>(STORAGE_KEYS.SAVED_ANALYSES, []);
}

export function getSavedAnalysis(id: string): SavedAnalysis | null {
    const analyses = getSavedAnalyses();
    return analyses.find(a => a.id === id) || null;
}

export function getSavedAnalysisByTicker(ticker: string): SavedAnalysis | null {
    const analyses = getSavedAnalyses();
    return analyses.find(a => a.ticker.toUpperCase() === ticker.toUpperCase()) || null;
}

export function deleteSavedAnalysis(id: string): boolean {
    const analyses = getSavedAnalyses();
    const filtered = analyses.filter(a => a.id !== id);
    return safeSetItem(STORAGE_KEYS.SAVED_ANALYSES, filtered);
}

export function clearAllAnalyses(): boolean {
    return safeSetItem(STORAGE_KEYS.SAVED_ANALYSES, []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════════════════════════════════════════════

export function getWatchlist(): WatchlistItem[] {
    return safeGetItem<WatchlistItem[]>(STORAGE_KEYS.WATCHLIST, []);
}

export function addToWatchlist(ticker: string, name: string, notes?: string): WatchlistItem | null {
    const watchlist = getWatchlist();

    // Check if already exists
    if (watchlist.some(w => w.ticker.toUpperCase() === ticker.toUpperCase())) {
        return null;
    }

    if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
        return null;
    }

    const newItem: WatchlistItem = {
        ticker: ticker.toUpperCase(),
        name,
        addedAt: Date.now(),
        notes
    };

    watchlist.unshift(newItem);

    if (safeSetItem(STORAGE_KEYS.WATCHLIST, watchlist)) {
        return newItem;
    }
    return null;
}

export function removeFromWatchlist(ticker: string): boolean {
    const watchlist = getWatchlist();
    const filtered = watchlist.filter(w => w.ticker.toUpperCase() !== ticker.toUpperCase());
    return safeSetItem(STORAGE_KEYS.WATCHLIST, filtered);
}

export function isInWatchlist(ticker: string): boolean {
    const watchlist = getWatchlist();
    return watchlist.some(w => w.ticker.toUpperCase() === ticker.toUpperCase());
}

export function updateWatchlistItem(ticker: string, updates: Partial<WatchlistItem>): boolean {
    const watchlist = getWatchlist();
    const index = watchlist.findIndex(w => w.ticker.toUpperCase() === ticker.toUpperCase());

    if (index === -1) return false;

    watchlist[index] = { ...watchlist[index], ...updates };
    return safeSetItem(STORAGE_KEYS.WATCHLIST, watchlist);
}

export function clearWatchlist(): boolean {
    return safeSetItem(STORAGE_KEYS.WATCHLIST, []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL ACCURACY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

export function getAccuracyHistory(): HistoricalAccuracy[] {
    return safeGetItem<HistoricalAccuracy[]>(STORAGE_KEYS.ACCURACY_HISTORY, []);
}

export function trackAnalysis(recommendation: FinalRecommendation): HistoricalAccuracy | null {
    const history = getAccuracyHistory();

    const record: HistoricalAccuracy = {
        id: generateId(),
        ticker: recommendation.ticker,
        analysisDate: recommendation.generatedAt,
        recommendation: recommendation.recommendation,
        priceAtAnalysis: recommendation.currentPrice,
        targetPrice: recommendation.priceTarget.base
    };

    history.unshift(record);

    // Keep last 200 records
    if (history.length > 200) {
        history.pop();
    }

    if (safeSetItem(STORAGE_KEYS.ACCURACY_HISTORY, history)) {
        return record;
    }
    return null;
}

export function updateAccuracyCheck(id: string, currentPrice: number): boolean {
    const history = getAccuracyHistory();
    const index = history.findIndex(h => h.id === id);

    if (index === -1) return false;

    const record = history[index];
    // Guard against division by zero
    if (record.priceAtAnalysis <= 0) return false;

    const priceChange = (currentPrice - record.priceAtAnalysis) / record.priceAtAnalysis;

    // Determine if prediction was accurate
    let wasAccurate = false;
    if (record.recommendation === 'strong_buy' || record.recommendation === 'buy') {
        wasAccurate = priceChange > 0.05; // 5% gain
    } else if (record.recommendation === 'strong_sell' || record.recommendation === 'sell') {
        wasAccurate = priceChange < -0.05; // 5% loss (correct to sell)
    } else {
        wasAccurate = Math.abs(priceChange) < 0.1; // Hold = stayed within 10%
    }

    history[index] = {
        ...record,
        checkDate: Date.now(),
        priceAtCheck: currentPrice,
        wasAccurate
    };

    return safeSetItem(STORAGE_KEYS.ACCURACY_HISTORY, history);
}

export function getAccuracyStats(): { total: number; accurate: number; rate: number } {
    const history = getAccuracyHistory().filter(h => h.wasAccurate !== undefined);
    const accurate = history.filter(h => h.wasAccurate).length;

    return {
        total: history.length,
        accurate,
        rate: history.length > 0 ? (accurate / history.length) * 100 : 0
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export function exportAnalysisAsJSON(analysis: SavedAnalysis): string {
    return JSON.stringify(analysis, null, 2);
}

export function downloadAnalysisJSON(analysis: SavedAnalysis): void {
    const json = exportAnalysisAsJSON(analysis);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analysis.ticker}_analysis_${new Date(analysis.savedAt).toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
