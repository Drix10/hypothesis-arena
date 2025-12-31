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
    leverage?: number; // Proposed leverage (1-5x)
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


/**
 * Coin selection pick with MANAGE action support
 * 
 * @property symbol - Must be one of the approved trading symbols
 * @property action - Trade direction or management action
 * @property conviction - Strength of conviction (0-100 scale)
 * @property reason - Brief explanation with specific data points
 */
export interface CoinSelectionPick {
    symbol: ApprovedSymbol;
    action: 'LONG' | 'SHORT' | 'MANAGE';
    conviction: number; // 0-100 scale
    reason: string;
}

/**
 * Coin selection response from AI
 */
export interface CoinSelectionResponse {
    picks: CoinSelectionPick[];
}

/**
 * Position management action types
 */
export type ManageActionType =
    | 'CLOSE_FULL'      // Close entire position at market
    | 'CLOSE_PARTIAL'   // Reduce position size
    | 'TIGHTEN_STOP'    // Move stop-loss closer to entry
    | 'TAKE_PARTIAL'    // Take partial profits
    | 'ADJUST_TP'       // Adjust take-profit level
    | 'ADD_MARGIN';     // Add margin to isolated position

/**
 * MANAGE action response schema - discriminated union by manageType
 * Ensures each variant requires the correct fields
 */
type ManageActionBase = {
    symbol: ApprovedSymbol;
    action: 'MANAGE';
    conviction: number;
    reason: string;
};

type CloseFullAction = ManageActionBase & {
    manageType: 'CLOSE_FULL';
};

type ClosePartialAction = ManageActionBase & {
    manageType: 'CLOSE_PARTIAL';
    closePercent: number; // Required: 1-100
};

type TightenStopAction = ManageActionBase & {
    manageType: 'TIGHTEN_STOP';
    newStopLoss: number; // Required
};

type TakePartialAction = ManageActionBase & {
    manageType: 'TAKE_PARTIAL';
    closePercent: number; // Required: 1-100
};

type AdjustTpAction = ManageActionBase & {
    manageType: 'ADJUST_TP';
    newTakeProfit: number; // Required
};

type AddMarginAction = ManageActionBase & {
    manageType: 'ADD_MARGIN';
    marginAmount: number; // Required
};

export type ManageActionResponse =
    | CloseFullAction
    | ClosePartialAction
    | TightenStopAction
    | TakePartialAction
    | AdjustTpAction
    | AddMarginAction;

/**
 * WEEX API order types reference
 * From weex/trade/INDEX.md
 */
export const WEEX_ORDER_TYPES = {
    OPEN_LONG: '1',
    OPEN_SHORT: '2',
    CLOSE_LONG: '3',
    CLOSE_SHORT: '4'
} as const;

/**
 * WEEX API order execution types
 */
export const WEEX_ORDER_EXECUTION_TYPES = {
    NORMAL: '0',
    POST_ONLY: '1',
    FOK: '2',
    IOC: '3'
} as const;

/**
 * WEEX API margin modes
 */
export const WEEX_MARGIN_MODES = {
    CROSS: 1,
    ISOLATED: 3
} as const;

/**
 * Approved trading pairs from WEEX
 * From weex/TRADING_RULES.md
 */
export const APPROVED_SYMBOLS = [
    'cmt_btcusdt',
    'cmt_ethusdt',
    'cmt_solusdt',
    'cmt_dogeusdt',
    'cmt_xrpusdt',
    'cmt_adausdt',
    'cmt_bnbusdt',
    'cmt_ltcusdt'
] as const;

export type ApprovedSymbol = typeof APPROVED_SYMBOLS[number];
