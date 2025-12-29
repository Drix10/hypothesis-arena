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
        task: `Select the SINGLE BEST trading opportunity from the 8 coins shown above.
Precedence: Stage instructions override persona/system prompts.
You MUST:
1. Name a SPECIFIC coin (BTC, ETH, SOL, DOGE, XRP, ADA, BNB, or LTC)
2. State direction: LONG or SHORT
3. Justify WHY using your methodology with specific data points (prices, volume, funding, range)
Constraints:
- Focus on opportunity identification
- Do NOT propose risk parameters or execution details here
Data Requirements:
- Cite price, % change vs BTC, and 24h volume
- Include at least one microstructure metric (funding, OI, liquidations)
- Note regime (trend/chop) and any near-term catalyst
- Address crowding risk if funding/OI are extreme
Catalyst Taxonomy (examples):
- Token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes, large partnerships, regulatory actions
- Prefer near-term catalysts (7–14 days) with date/timeline and expected impact
Output:
- Provide coin, direction, conviction (1–10), and ONE-sentence reason with numbers
Word Limit:
- 150–200 words; under 120 too thin; >200 penalized
Self-Assessment Calibration (strength 1–10):
- 1–3 weak; 4–5 average; 6–7 good; 8–9 strong; 10 exceptional (rare)`,
        judging: 'Opportunity Fit (25%), Data Quality (25%), Logic (25%), Risk Awareness (25%), Crowding Awareness (bonus)'
    },

    /**
     * Stage 3: Analysis Approach Debate
     * 4 analysts debate HOW to analyze the coin
     */
    analysisApproach: {
        title: '🔬 ANALYSIS APPROACH DEBATE - Stage 3',
        task: `Debate which ANALYTICAL METHODOLOGY is BEST for the already-selected coin and direction.
Precedence: Stage instructions override persona/system prompts.
Context:
- The coin and direction were selected in Stage 2
- You are NOT debating whether to trade it
You MUST:
1. Argue why YOUR methodology (value, growth, technical, macro, sentiment, risk, quant, contrarian) is best-suited to analyze THIS coin
2. Reference methodology-specific metrics and techniques (e.g., Z-scores for quant, chart structure for technical, adoption/TVL for growth, correlations/liquidity for macro)
3. Describe the expected INSIGHTS your approach will reveal and how they improve the final thesis
4. Specify time horizon and how your lens evaluates risk/reward over that horizon
5. Provide at least one cross-check from another methodology to avoid tunnel vision
Constraints:
- DO NOT recommend a different coin or direction
- DO NOT restate a position; focus on FRAMEWORK and INSIGHT QUALITY
Output:
- Methodology choice, core metrics you will apply, expected insight types, and why it adds edge
Word Limit:
- 150–200 words; under 120 too thin; >200 penalized
Self-Assessment Calibration:
- Same as Stage 2`,
        judging: 'Methodology Fit (30%), Specificity (25%), Differentiation (25%), Risk Awareness (20%), Cross-Validation (bonus)'
    },

    /**
     * Stage 4: Risk Assessment Debate
     * 4 analysts debate position sizing & risk parameters
     */
    riskAssessment: {
        title: '🛡️ RISK ASSESSMENT DEBATE - Stage 4',
        task: `Debate the optimal RISK PARAMETERS for the proposed trade.
Precedence: Stage instructions override persona/system prompts.
Context:
- The coin, direction, and analysis approach have already been selected
You MUST:
1. Recommend position size using a linear 1–10 scale (1 = 3%, 10 = 30%) and leverage (1–5x) with numeric justification
2. Propose a stop-loss placement method (ATR-based, structure-based, volatility-adjusted) and a specific level
3. Explain downside scenarios and invalidation conditions based on the Stage 3 thesis
Constraints:
- DO NOT change the coin or direction
- DO NOT restart the thesis; focus on RISK ONLY
Data Requirements:
- Reference volatility and range metrics supporting stop placement
- Quantify risk/reward with distances (%) to stop and targets
- Address funding/OI crowding impact on adverse-move scenarios
Output:
- Position size (1–10), leverage (1–5x), stop-loss, invalidation triggers, and scenario notes
Word Limit:
- 150–200 words; under 120 too thin; >200 penalized
Self-Assessment Calibration:
- Same as Stage 2`,
        hardRules: 'Max position 30%, Max leverage 5x, Max stop loss 10% from entry',
        judging: 'Risk Rationale (35%), Rule Compliance (25%), Scenario Planning (25%), Data Quality (15%), Crowding Awareness (bonus)'
    },

    /**
     * Stage 5: Championship Debate
     * ALL 8 analysts compete for execution
     */
    championship: {
        title: '🏆 CHAMPIONSHIP DEBATE - Stage 5 (FINAL)',
        task: `Refine the FINAL THESIS for the selected coin and direction. The WINNER's thesis will be EXECUTED as a REAL TRADE.
Precedence: Stage instructions override persona/system prompts.
Context:
- Build on winners from Stage 2 (coin/direction), Stage 3 (analysis approach), and Stage 4 (risk framework)
You MUST:
1. Either support the thesis with NEW evidence or challenge specific assumptions with counter-evidence
2. Propose precise entry, targets, and stop-loss aligned with the agreed risk constraints
3. State conviction level and the NEAR-TERM catalyst/timeline
Constraints:
- DO NOT restart coin selection or propose a different trade
- You MUST reference at least one prior-stage winner argument
Integration Requirements:
- Tie new evidence directly to prior-stage arguments
- Quantify improvements to risk/reward or probability
- Specify execution triggers (time/price/flow) and invalidation
Catalyst Taxonomy (examples):
- Token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes, large partnerships, regulatory actions
- Prefer near-term catalysts (7–14 days) with date/timeline and expected impact
Output:
- One integrated thesis paragraph plus final parameters
Word Limit:
- 150–200 words; under 120 too thin; >200 penalized
Self-Assessment Calibration:
- Same as Stage 2`,
        judging: 'Integration Quality (30%), Data Quality (25%), Logic (25%), Risk Awareness (20%)'
    }
} as const;

/**
 * Debate Turn Instructions
 * 
 * Stage-specific instructions for generating individual debate turns.
 * Used by generateDebateTurn() helper function.
 * 
 * FIXES APPLIED:
 * - Stage-specific constraints to prevent stage confusion
 * - Self-assessment calibration to reduce uniform 8-9/10 scores
 * - Echo chamber prevention with explicit engagement requirements
 * - Stop-loss diversity requirement moved to Stage 4/5 only
 */
export const DEBATE_TURN_INSTRUCTIONS = {
    general: {
        stage2: `CRITICAL REQUIREMENTS:
- Your argument MUST be 150-200 words (MANDATORY)
- Use YOUR specific methodology and reference 3-4 SPECIFIC data points (prices, % change, volume, funding, range)
- DIRECTLY engage with previous arguments (quote a claim and counter or build on it). Debate rather than repeat—bring NEW evidence or analysis; do not restate prior points.
- Include at least ONE microstructure or on-chain metric (funding, OI, liquidations, TVL, active addresses)
- Catalysts: Use concrete items like token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes; include specific dates or timelines where possible
- State a clear recommendation: SPECIFIC coin name + LONG or SHORT
- DO NOT end your argument mid-sentence - complete your full thought
Time Horizon:
- Specify expected timeframe (e.g., 2-7 days) and why signals fit it
 Correlation:
- Avoid proposing multiple highly correlated picks; correlated = same sector/L1 family or high beta to BTC
- If correlation risk exists, explicitly note it and justify diversification across sectors or betas
Quality STANDARDS:
- Avoid vague phrases; every claim needs specific numbers
- Make at least ONE specific claim that could be proven wrong (falsifiable)
Cross-Check:
- Where possible, reference a confirming or disconfirming signal from another lens
SELF-ASSESSMENT CALIBRATION (strength 1-10):
- 1-3 weak; 4-5 average; 6-7 good; 8-9 strong; 10 exceptional (rare)
- Be honest; most arguments are 5-7.
Word Count:
- Under 120 too thin; 150–200 optimal; >200 penalized
Response Format:
- Opening hook (1 sentence with a specific number)
- Main argument (2-3 sentences with 3-4 metrics)
- Counter/engagement (quote and address one prior claim)
- Supporting evidence (1-2 additional data points)
- Closing (1 sentence on why judges should score you)
Common Mistakes:
- Vague statements without numbers, ignoring prior arguments
- Over 200 words, correlation overexposure without justification`,
        stage3: `CRITICAL REQUIREMENTS:
- Your argument MUST be 150-200 words (MANDATORY)
- You are debating METHODOLOGY for the already-selected coin and direction
- Apply YOUR methodology's lens with method-specific metrics and techniques
- DIRECTLY engage with previous arguments (address their main point explicitly)
- Describe NEW insights your approach will surface; avoid repeating the same 4 metrics
- DO NOT recommend a coin or direction; DO NOT restart the thesis
Time Horizon:
- State the timeframe your lens best fits and how risk is evaluated
Cross-Validation:
- Include one cross-check from another methodology to avoid overfitting
Quality STANDARDS:
- Provide 3-4 specific, methodology-relevant data points or evaluation criteria
- Make a falsifiable claim about what your methodology will reveal (e.g., "Z-score indicates mean reversion risk")
SELF-ASSESSMENT CALIBRATION:
- Same as Stage 2.
Word Count:
- Under 120 too thin; 150–200 optimal; >200 penalized
Response Format:
- Methodology statement (1 sentence)
- Metrics/techniques (2-3 sentences; method-specific)
- Engagement (address one prior argument explicitly)
- Cross-check (1 sentence from another lens)
- Closing (1 sentence on added edge)
Common Mistakes:
- Recommending trades, repeating generic metrics, no falsifiable claim`,
        stage4: `CRITICAL REQUIREMENTS:
- Your argument MUST be 150-200 words (MANDATORY)
- Focus ONLY on risk parameters: position size (1-10; 1 = 3%, 10 = 30%), leverage (1-5x), stop-loss
- Provide numeric justification and downside scenarios tied to Stage 3 thesis
- DIRECTLY engage with prior risk arguments (explain why their sizing/stop is flawed or improve it)
- DO NOT change the coin or direction
Crowding:
- Address funding/OI crowding impact on adverse-move scenarios
STOP-LOSS DIVERSITY:
- If stops are clustered within ~5%, propose a differentiated level using YOUR method (ATR/structure/volatility)
- Justify invalidation clearly
Quality STANDARDS:
- Reference volatility/range metrics and rule compliance; avoid generic risk platitudes
SELF-ASSESSMENT CALIBRATION:
- Same as Stage 2.
Word Count:
- Under 120 too thin; 150–200 optimal; >200 penalized
Response Format:
- Position size (1–10), leverage (1–5x), stop-loss level
- Numeric justification (volatility/range, crowding, distances %)
- Scenarios (adverse move, invalidation triggers)
- Engagement (improve or counter a prior risk proposal)
Common Mistakes:
- Platitudes without numbers, violating constraints, ignoring crowding`,
        stage5: `CRITICAL REQUIREMENTS:
- Your argument MUST be 150-200 words (MANDATORY)
- You are REFINING the final thesis; build on Stage 2-4 winners
- Either add NEW evidence or challenge SPECIFIC assumptions with counter-evidence. Debate rather than repeat—quote a prior winner’s claim and address it with numbers or a better method.
- Propose entry, targets, and stop-loss consistent with Stage 4 constraints
- Reference at least one earlier winner's key argument
- DO NOT restart coin selection or propose a different trade
STOP-LOSS DIVERSITY:
- If clustered, justify a differentiated level with method-based rationale
- Catalysts: Prefer concrete, near-term events (unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes) with date/timeline and expected impact
Quality STANDARDS & SELF-ASSESSMENT:
- Same as Stage 2.
Word Count:
- Under 120 too thin; 150–200 optimal; >200 penalized
Response Format:
- Thesis refinement (1-2 sentences referencing prior winners)
- New evidence or counter-evidence (2-3 sentences with numbers)
- Final parameters: entry, targets, stop-loss
- Catalyst and timeline (1 sentence), conviction level
Common Mistakes:
- Restarting selection, ignoring prior winners, adding unrelated new arguments`
    },

    opening: `OPENING TURN: Present your initial position with your STRONGEST data-backed arguments.
- Lead with your 2-3 most compelling data points with exact numbers
- Explain WHY your methodology gives you an edge on this specific trade
- Set up your thesis for the debate ahead
- Include constraints relevant to the current stage`,

    rebuttal: `REBUTTAL TURN: Directly engage with the previous arguments.
- Quote or reference specific claims made by other analysts
- Challenge their weakest points with DATA from YOUR methodology
- Defend your position against valid criticisms
- Strengthen your thesis with additional supporting evidence
- If you agree with a point, acknowledge it but explain why your approach is still superior
- DIFFERENTIATE: If others have similar views, explain what YOUR methodology adds that theirs misses
- Avoid repeating the same data points; add NEW insights`,

    closing: `CLOSING TURN: Make your final, most compelling argument.
- Summarize the 2-3 strongest points supporting your thesis
- Address the single best counter-argument and explain why it doesn't invalidate your view
- Restate the stage-specific outcome you want (e.g., best methodology, risk parameters, or refined thesis)
- If applicable, propose final parameters aligned with constraints
- Rate your argument HONESTLY (most closing arguments are 6-8, not 9-10)`
} as const;
