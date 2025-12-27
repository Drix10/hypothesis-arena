/**
 * TypeScript interfaces for prompt builder functions
 * Replaces 'any' types with proper type safety
 */

/**
 * Analysis result for use in prompts
 */
export interface PromptAnalysisResult {
    analystId: string;
    analystName: string;
    analystEmoji: string;
    analystTitle: string;
    recommendation: string;
    confidence: number;
    positionSize: number;
    thesis: string;
    bullCase?: string[];
    bearCase?: string[];
    priceTarget: {
        bull: number;
        base: number;
        bear: number;
    };
    catalysts?: string[];
    keyMetrics?: Record<string, any> | string[];
}

/**
 * Market data for use in prompts
 */
export interface PromptMarketData {
    currentPrice?: number;
    change24h: number;
    fundingRate?: number;
    price?: number; // Alias for currentPrice (used in some contexts)
    volume24h?: number;
}

/**
 * Specialist data for single-judge fallback
 */
export interface PromptSpecialist {
    analystId: string;
    analystName: string;
    analystTitle: string;
    recommendation: string;
    confidence: number;
    positionSize: number;
    thesis: string;
    bullCase?: string[];
    bearCase?: string[];
    priceTarget: {
        bull: number;
        base: number;
        bear: number;
    };
}
