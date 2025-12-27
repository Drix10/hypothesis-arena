/**
 * Coin Selection Scoring (Stage 2 - from FLOW.md)
 * 
 * Scoring formula for coin selection debate.
 * Ray, Jim, and Quant each pick their top 3 coins.
 * Used in CollaborativeFlow.ts aggregateCoinScores()
 */

export const COIN_SELECTION_SCORING = {
    RANK_MULTIPLIERS: {
        1: 3,  // #1 pick = 3 points × conviction
        2: 2,  // #2 pick = 2 points × conviction
        3: 1   // #3 pick = 1 point × conviction
    },
    CONVICTION_RANGE: {
        min: 1,
        max: 10
    },
    // Example: SOL picked #1 with conviction 9 = 3 × 9 = 27 points
    // Total score across all analysts determines which coin gets deep analysis
};

/**
 * Coin Type Specialist Assignments (Stage 3 - from FLOW.md)
 * 
 * Maps coin types to their specialist analysts.
 * When a coin is selected in Stage 2, these specialists analyze it in Stage 3.
 * 
 * NOTE: The actual mapping used at runtime is COIN_TYPE_MAP in CollaborativeFlow.ts.
 * This constant serves as documentation and reference for the specialist assignment logic.
 * If you need to modify specialist assignments, update COIN_TYPE_MAP in CollaborativeFlow.ts.
 */
export const COIN_TYPE_SPECIALISTS = {
    blue_chip: {
        coins: ['BTC', 'ETH'],
        specialists: ['warren', 'ray', 'karen'],
        rationale: 'Blue chips need value analysis, macro context, and risk management'
    },
    l1_growth: {
        coins: ['SOL', 'ADA'],
        specialists: ['cathie', 'quant', 'jim'],
        rationale: 'L1 growth coins need growth metrics, quant signals, and technical analysis'
    },
    momentum_meme: {
        coins: ['DOGE', 'XRP'],
        specialists: ['elon', 'devil', 'jim'],
        rationale: 'Momentum coins need sentiment analysis, contrarian view, and technicals'
    },
    utility: {
        coins: ['BNB', 'LTC'],
        specialists: ['warren', 'quant', 'karen'],
        rationale: 'Utility coins need value analysis, quant metrics, and risk assessment'
    }
};
