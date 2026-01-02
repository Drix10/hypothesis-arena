/**
 * Debate Context Templates
 * 
 * Context strings for turn-by-turn debate generation.
 * These provide the debate framework and judging criteria.
 * 
 * All debate contexts are stored here to avoid hardcoding in service files.
 * 
 * 6-STAGE PIPELINE (v3.1.0):
 * - Stage 1: Market Scan
 * - Stage 2: Coin Selection (4 analysts debate) - Can select MANAGE action
 * - Stage 3: Championship (8 analysts compete) - Only if LONG/SHORT selected
 * - Stage 4: Risk Council (Karen approves/vetoes) - Only if LONG/SHORT selected
 * - Stage 5: Execution - Place trade on WEEX
 * - Stage 6: Position Management - Continuous monitoring
 * 
 * Note: If MANAGE action is selected in Stage 2, flow goes directly to position
 * management decision (bypassing stages 3-4), then to execution.
 * 
 * IMPORTANT: All risk limits come from config via getTradingConfig() - NO HARDCODING
 */

import { getTradingConfig } from './promptHelpers';

// Get config values for use in templates
const cfg = getTradingConfig();

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
     * Stage 3: Championship Debate
     * ALL 8 analysts compete for execution
     * NOTE: Winner's thesis is executed ONLY if approved by Risk Council (Stage 4)
     */
    championship: {
        title: '🏆 CHAMPIONSHIP DEBATE - Stage 3 (FINAL)',
        task: `Present your COMPLETE THESIS for the selected coin and direction. The WINNER's thesis will be sent to Risk Council (Stage 4) for final approval before execution.
Precedence: Stage instructions override persona/system prompts.
Context:
- The coin and direction were selected in Stage 2
- Use YOUR methodology to analyze the opportunity
- Include risk parameters in your thesis
You MUST:
1. Apply YOUR methodology (value, growth, technical, macro, sentiment, risk, quant, contrarian) to analyze the coin
2. Propose precise entry, targets, and stop-loss with numeric justification
3. Recommend position size (1-10 scale) and leverage (1-${cfg.maxLeverage}x max)
4. State conviction level and the NEAR-TERM catalyst/timeline
5. Either support the thesis with evidence or challenge specific assumptions with counter-evidence
Constraints:
- DO NOT restart coin selection or propose a different trade
- Max position ${cfg.maxPositionSizePercent}%, Max leverage ${cfg.maxLeverage}x, Max stop loss ${cfg.maxStopLossPercent}% from entry
Risk Requirements:
- Reference volatility and range metrics supporting stop placement
- Quantify risk/reward with distances (%) to stop and targets
- Address funding/OI crowding impact on adverse-move scenarios
Catalyst Taxonomy (examples):
- Token unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes, large partnerships, regulatory actions
- Prefer near-term catalysts (7–14 days) with date/timeline and expected impact
Output:
- One integrated thesis paragraph plus final parameters (entry, targets, stop, size, leverage)
Word Limit:
- 150–200 words; under 120 too thin; >200 penalized
Self-Assessment Calibration:
- Same as Stage 2`,
        hardRules: `Max position ${cfg.maxPositionSizePercent}%, Max leverage ${cfg.maxLeverage}x, Max stop loss ${cfg.maxStopLossPercent}% from entry`,
        judging: 'Methodology Application (25%), Data Quality (25%), Risk Rationale (25%), Logic & Integration (25%)'
    }
} as const;

/**
 * Debate Turn Instructions
 * 
 * Stage-specific instructions for generating individual debate turns.
 * Used by generateDebateTurn() helper function.
 * 
 * OPTIMIZED (v3.1.0): 6-stage pipeline
 * - Stage 1: Market Scan
 * - Stage 2: Coin Selection (can select MANAGE action)
 * - Stage 3: Championship (only if LONG/SHORT selected)
 * - Stage 4: Risk Council (only if LONG/SHORT selected)
 * - Stage 5: Execution
 * - Stage 6: Position Management (continuous)
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
- You are presenting your COMPLETE THESIS using YOUR methodology
- Apply YOUR methodology's lens with method-specific metrics and techniques
- Include risk parameters: position size (1-10), leverage (1-${cfg.maxLeverage}x), stop-loss
- Either add NEW evidence or challenge SPECIFIC assumptions with counter-evidence
- DIRECTLY engage with previous arguments (address their main point explicitly)
- DO NOT restart coin selection or propose a different trade
Risk Requirements:
- Reference volatility/range metrics and rule compliance
- Quantify risk/reward with distances (%) to stop and targets
- Address funding/OI crowding impact on adverse-move scenarios
- Max position ${cfg.maxPositionSizePercent}%, Max leverage ${cfg.maxLeverage}x, Max stop loss ${cfg.maxStopLossPercent}% from entry
STOP-LOSS DIVERSITY:
- If stops are clustered within ~5%, propose a differentiated level using YOUR method (ATR/structure/volatility)
- Justify invalidation clearly
Catalysts:
- Prefer concrete, near-term events (unlock schedules, exchange listings, ETF approvals, mainnet/testnet launches, governance votes) with date/timeline and expected impact
Quality STANDARDS & SELF-ASSESSMENT:
- Same as Stage 2.
Word Count:
- Under 120 too thin; 150–200 optimal; >200 penalized
Response Format:
- Methodology application (1-2 sentences with method-specific metrics)
- Thesis with evidence (2-3 sentences with numbers)
- Risk parameters: position size (1-10), leverage (1-${cfg.maxLeverage}x), stop-loss, targets
- Catalyst and timeline (1 sentence), conviction level
Common Mistakes:
- Restarting selection, generic analysis without methodology, missing risk parameters`
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


