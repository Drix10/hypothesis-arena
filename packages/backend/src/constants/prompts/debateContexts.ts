/**
 * Debate Context Templates
 * 
 * Context strings for turn-by-turn debate generation.
 * These provide the debate framework and judging criteria.
 * 
 * All debate contexts are stored here to avoid hardcoding in service files.
 */

export const DEBATE_CONTEXTS = {
    /**
     * Stage 2: Coin Selection Debate
     * 4 analysts debate which coin to trade
     */
    coinSelection: {
        title: '🎯 COIN SELECTION DEBATE - Stage 2',
        task: `Select the BEST trading opportunity from the 8 coins shown above.
You MUST:
1. Name a SPECIFIC coin (BTC, ETH, SOL, DOGE, XRP, ADA, BNB, or LTC)
2. State direction: LONG or SHORT
3. Explain WHY using your methodology with specific numbers from the data`,
        judging: 'Data Quality (25%), Logic (25%), Risk Awareness (25%), Catalyst (25%)'
    },

    /**
     * Stage 3: Analysis Approach Debate
     * 4 analysts debate HOW to analyze the coin
     */
    analysisApproach: {
        title: '🔬 ANALYSIS APPROACH DEBATE - Stage 3',
        task: `Propose the BEST analytical framework for this specific coin and direction.
You MUST:
1. Explain your methodology's unique advantage for THIS coin
2. Reference specific price levels, support/resistance, or metrics
3. Provide entry, target, and stop-loss reasoning`,
        judging: 'Data Quality (25%), Logic (25%), Risk Awareness (25%), Catalyst (25%)'
    },

    /**
     * Stage 4: Risk Assessment Debate
     * 4 analysts debate position sizing & risk parameters
     */
    riskAssessment: {
        title: '🛡️ RISK ASSESSMENT DEBATE - Stage 4',
        task: `Debate the optimal RISK PARAMETERS for this trade.
You MUST:
1. Recommend position size (1-10 scale)
2. Justify your risk level assessment
3. Consider the proposed thesis and adjust if needed`,
        hardRules: 'Max position 30%, Max leverage 5x, Max stop loss 10% from entry',
        judging: 'Data Quality (25%), Logic (25%), Risk Awareness (25%), Catalyst (25%)'
    },

    /**
     * Stage 5: Championship Debate
     * ALL 8 analysts compete for execution
     */
    championship: {
        title: '🏆 CHAMPIONSHIP DEBATE - Stage 5 (FINAL)',
        task: `Present your COMPLETE THESIS for this trade. The WINNER's thesis will be EXECUTED as a REAL TRADE.
You MUST:
1. State your recommendation (LONG or SHORT)
2. Provide specific entry, target, and stop-loss prices
3. Explain your conviction level and key catalyst`,
        judging: 'Data Quality (25%), Logic (25%), Risk Awareness (25%), Catalyst (25%)'
    }
} as const;

/**
 * Debate Turn Instructions
 * 
 * Instructions for generating individual debate turns.
 * Used by generateDebateTurn() helper function.
 * 
 * FIXES APPLIED:
 * - Added self-assessment calibration to reduce uniform 8-9/10 scores
 * - Added stop-loss diversity requirement to prevent clustering
 * - Added echo chamber prevention instructions
 * - Added structured direction output requirement
 */
export const DEBATE_TURN_INSTRUCTIONS = {
    general: `CRITICAL REQUIREMENTS:
- Your argument MUST be 150-200 words (this is MANDATORY - shorter responses will be rejected)
- Use YOUR specific methodology to analyze - apply your unique frameworks and scorecards
- Reference at least 3-4 SPECIFIC data points with exact numbers (prices, percentages, volumes, funding rates)
- Be persuasive and DIRECTLY engage with previous arguments - don't just state your view, counter theirs
- Include at least ONE on-chain metric (TVL, MVRV, active addresses) OR microstructure metric (funding, OI, liquidations)
- State a clear recommendation: specific coin name + LONG or SHORT direction
- Quantify your conviction with specific price targets and risk levels
- DO NOT end your argument mid-sentence - complete your full thought

DIRECTION REQUIREMENT (CRITICAL):
- You MUST explicitly state "I recommend LONG" or "I recommend SHORT" in your argument
- Do NOT use negations like "I would NOT go LONG" - state your actual recommendation directly
- Your direction must be unambiguous and clearly stated

STOP-LOSS DIVERSITY (IMPORTANT):
- If other analysts have placed stops at similar levels, YOU MUST differentiate
- Use YOUR methodology to calculate a UNIQUE stop-loss level
- Consider: ATR-based stops, structure-based stops, or volatility-adjusted stops
- Clustered stops are vulnerable to liquidity hunts - differentiate yourself

QUALITY STANDARDS:
- Vague phrases like "looks good" or "seems bullish" are NOT acceptable
- Every claim must have supporting data with specific numbers
- Address the strongest counter-argument from previous speakers
- Your argument should be a complete, well-structured paragraph

SELF-ASSESSMENT CALIBRATION (strength field):
- 1-3: Weak argument, limited data, speculative
- 4-5: Average argument, some supporting data
- 6-7: Good argument, solid data and logic
- 8-9: Strong argument, compelling data and clear catalyst
- 10: Exceptional, overwhelming evidence (RARE - use sparingly)
- BE HONEST - inflated scores hurt your credibility. Most arguments are 5-7.

Respond with valid JSON matching the schema. The "argument" field must be your complete 150-200 word response.`,

    opening: `OPENING TURN: Present your initial position with your STRONGEST data-backed arguments.
- Name the SPECIFIC coin you recommend (BTC, ETH, SOL, DOGE, XRP, ADA, BNB, or LTC)
- State clearly: "I recommend LONG" or "I recommend SHORT" (use these exact words)
- Lead with your 2-3 most compelling data points with exact numbers
- Explain WHY your methodology gives you an edge on this specific trade
- Set up your thesis for the debate ahead
- Include YOUR unique stop-loss level based on YOUR methodology (not just below obvious support)`,

    rebuttal: `REBUTTAL TURN: Directly engage with the previous arguments.
- Quote or reference specific claims made by other analysts
- Challenge their weakest points with DATA from YOUR methodology
- Defend your position against valid criticisms
- Strengthen your thesis with additional supporting evidence
- If you agree with a point, acknowledge it but explain why your approach is still superior
- DIFFERENTIATE: If others have similar views, explain what YOUR methodology adds that theirs misses
- If you notice stop-loss clustering, call it out as a risk and propose a differentiated level`,

    closing: `CLOSING TURN: Make your final, most compelling argument.
- Summarize the 2-3 strongest points supporting your thesis
- Address the single best counter-argument and explain why it doesn't invalidate your view
- Restate your specific recommendation: "I recommend LONG/SHORT [COIN] at [entry] with target [target] and stop-loss [stop]"
- Your stop-loss MUST be different from other analysts if they've clustered (explain your methodology)
- End with a clear call to action - why should this trade be executed NOW?
- Rate your argument HONESTLY (most closing arguments are 6-8, not 9-10)`
} as const;
