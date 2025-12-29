/**
 * Tournament Judging Criteria (Stage 4 - from FLOW.md)
 * 
 * These criteria are used to judge analyst debates in the Championship Tournament.
 * Each criterion is worth 25 points (0-25 scale), total 100 points.
 * Used in CollaborativeFlow.ts runDebateMatch()
 */

export const TOURNAMENT_JUDGING_CRITERIA = {
    DATA_QUALITY: {
        weight: 25,
        description: 'Uses specific numbers, not vague claims',
        scoring: [
            'References actual market data (price, volume, funding)',
            'Quantifies risks and targets with specific numbers',
            'Uses on-chain metrics where relevant',
            'Avoids vague language like "could", "might", "possibly"'
        ]
    },
    LOGIC: {
        weight: 25,
        description: 'Reasoning is sound and follows from data',
        scoring: [
            'Arguments are internally consistent',
            'Conclusions match the evidence presented',
            'Cause-effect relationships are clear',
            'No logical fallacies or contradictions'
        ]
    },
    RISK_AWARENESS: {
        weight: 25,
        description: 'Acknowledges what could go wrong',
        scoring: [
            'Has realistic bear case with specific scenarios',
            'Stop loss is reasonable (≤10% from entry)',
            'Identifies thesis invalidation triggers',
            'Acknowledges own biases and blind spots'
        ]
    },
    CATALYST: {
        weight: 25,
        description: 'Clear price driver with timeline',
        scoring: [
            'Specific catalyst identified (not just "will go up")',
            'Timeline specified (when will catalyst occur)',
            'Expected impact quantified (how much move)',
            'Explains why catalyst will move price'
        ]
    }
};

/**
 * Crypto-Specific Judging Reminders
 * 
 * Supplemental guidance for judges to maintain crypto-native rigor
 * without altering the primary scoring criteria.
 */
export const CRYPTO_JUDGING_REMINDERS = [
    'Prefer on-chain metrics (TVL, MVRV, active addresses, exchange flows) and microstructure (funding, OI, liquidations, basis).',
    'If leverage is discussed, include liquidation math and funding drag/carry implications.',
    'Near-term catalysts (7–14 days) with probability and expected impact are stronger.',
    'Penalize price-only arguments and vague statements; reward quantified, time-bound, risk-aware theses.'
];

/**
 * Common Judging Pitfalls to Avoid
 */
export const JUDGING_PITFALLS = [
    'Ignoring crowding risks (extreme funding/OI) or regime (trend vs chop).',
    'Timeframe mismatch (targets/catalysts not aligned to the stated horizon).',
    'Methodology drift or internal contradictions; missing invalidation/risks.',
    'Overweighting narrative without data; underweighting risk and liquidity.'
];
