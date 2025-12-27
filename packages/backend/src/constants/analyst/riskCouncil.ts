/**
 * Risk Council Veto Triggers (Stage 5 - Karen's Rules from FLOW.md)
 * 
 * These are the HARD RULES that Karen (Risk Council) uses to VETO trades.
 * If ANY of these conditions are true, the trade MUST be vetoed.
 * Used in CollaborativeFlow.ts buildRiskCouncilPrompt()
 */

export const RISK_COUNCIL_VETO_TRIGGERS = {
    // Position sizing limits
    MAX_POSITION_PERCENT: 30,        // Position cannot exceed 30% of account
    MAX_STOP_LOSS_DISTANCE: 10,      // Stop loss cannot be >10% from entry
    MAX_LEVERAGE: 5,                 // Never exceed 5x leverage
    MAX_CONCURRENT_POSITIONS: 3,     // No more than 3 positions open

    // Drawdown limits
    MAX_WEEKLY_DRAWDOWN: 10,         // If 7d P&L < -10%, no new trades

    // Funding rate limits (absolute value, applies to both positive and negative)
    MAX_FUNDING_AGAINST: 0.05,       // If |funding rate| >0.05% against position, veto

    // Correlation limits
    MAX_SAME_DIRECTION_POSITIONS: 2, // Max 2 positions in same direction (long or short)

    // Karen's checklist (from FLOW.md) - all conditions must be satisfied
    CHECKLIST: [
        'Position size ≤30% of account',
        'Stop loss ≤10% from entry',
        'Leverage ≤5x',
        'Not overexposed to one direction (max 2 same-direction positions)',
        'Correlation risk (not 3 positions in same sector)',
        'Funding rate acceptable (|rate| ≤0.05% against us)',
        'Volatility regime (reduce size in high vol)',
        'Recent drawdown (reduce size if down >10% this week)'
    ]
};
