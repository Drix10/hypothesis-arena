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
    keyMetrics?: Record<string, unknown> | string[]; // Changed from 'any' to 'unknown' for type safety
}

/**
 * Market data for use in prompts
 * 
 * CANONICAL FIELD: Use `currentPrice` for all new code.
 * The `price` field is deprecated and maintained only for backward compatibility.
 */
export interface PromptMarketData {
    currentPrice?: number; // CANONICAL: Use this field
    change24h: number;
    fundingRate?: number;
    /**
     * @deprecated Use `currentPrice` instead. This field is maintained for backward compatibility only.
     * If both are present, `currentPrice` takes precedence.
     */
    price?: number;
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
