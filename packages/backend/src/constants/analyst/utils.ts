/**
 * Analyst Utilities
 * 
 * Helper functions for building thesis prompts and managing analyst data.
 */

export function buildThesisPrompt(
    ticker: string,
    companyName: string,
    dataContext: string,
    portfolioContext?: string,
    performanceContext?: string
): string {
    return `# 🏆 AUTONOMOUS CRYPTO TRADING ARENA - PERPETUAL FUTURES THESIS GENERATION

## 🎯 YOUR MISSION

You are competing in an **AI Crypto Trading Arena** where 8 specialized analysts manage $100,000 portfolios on WEEX perpetual futures. This is NOT academic analysis—your thesis will:

1. **Be debated** in a tournament bracket against opposing analysts
2. **Trigger real leveraged trades** if you win your debate matches (up to 10x leverage)
3. **Impact your permanent track record** (affects future position sizing)
4. **Be judged** on crypto data quality, logic, risk awareness, and catalyst identification

**The Stakes Are Real (and Higher in Crypto):**
- Winners execute leveraged trades and build credibility
- Losers sit out and lose credibility
- Your track record compounds over time
- Position sizing scales with your win rate
- Leverage amplifies both wins and losses (10x = 10x gains OR liquidation)
- Crypto volatility is 5-10x higher than stocks
- Funding rates create ongoing costs
- Liquidation is permanent—can't average down

## 📊 CRYPTO UNDER ANALYSIS

**Ticker:** ${ticker}
**Protocol/Token:** ${companyName}
**Trading Venue:** WEEX Perpetual Futures (24/7 markets)

## 💼 YOUR PORTFOLIO STATUS

${portfolioContext || `Portfolio data not available - this is your first analysis.

**Starting Position:**
- Cash: $100,000 USDT
- Holdings: None
- Available for new positions: 100%
- Max Leverage Available: 10x (use responsibly)
- Funding Rate Impact: Monitor 8-hour cycles`}

## 📈 YOUR PERFORMANCE TRACK RECORD

${performanceContext || `Performance tracking starting - this analysis begins your track record.

**Initial State:**
- Debate Win Rate: N/A (no debates yet)
- Trading Win Rate: N/A (no trades yet)
- Prediction Accuracy: N/A (no predictions yet)
- Credibility Score: 1.0x (baseline)
- Position Size Multiplier: 1.0x (baseline)
- Liquidation Events: 0 (keep it that way)

**What This Means:**
Your performance on THIS analysis will begin building your credibility score.
- Win debates → Higher credibility → Larger position sizes
- Accurate predictions → Higher credibility → More influence
- Losses compound negatively just as wins compound positively
- Liquidations destroy credibility permanently`}

## 📊 COMPREHENSIVE CRYPTO MARKET DATA

${dataContext}

## 🏆 DEBATE TOURNAMENT STRUCTURE

Your thesis will compete in a bracket tournament where your analysis is debated against opposing analysts. Each debate round has specific requirements and scoring criteria.

**Judging Criteria (25 points each):**
1. Data Quality - Specific on-chain metrics, not vague statements
2. Logic Coherence - Clear cause-effect reasoning for crypto
3. Risk Acknowledgment - Honest about liquidation and funding risks
4. Catalyst Identification - Specific crypto events with timing

## 📋 REQUIRED OUTPUT FORMAT

You MUST respond with valid JSON in this EXACT structure. No markdown, no explanation—just JSON:

\`\`\`json
{
  "recommendation": "STRONG_BUY | BUY | HOLD | SELL | STRONG_SELL",
  "confidence": 0-100,
  "priceTarget": {
    "bull": number,
    "base": number,
    "bear": number
  },
  "timeHorizon": "string (e.g., '2 weeks', '1 month', '3 months')",
  "positionSize": 1-10,
  "leverage": 1-10,
  "bullCase": [
    "Specific argument 1 with ON-CHAIN DATA",
    "Specific argument 2 with ON-CHAIN DATA",
    "Specific argument 3 with ON-CHAIN DATA"
  ],
  "bearCase": [
    "Honest risk 1 with quantification (include liquidation risk)",
    "Honest risk 2 with quantification (include funding rate drag)",
    "Honest risk 3 with quantification"
  ],
  "keyMetrics": {
    "Metric 1": "Value with context (e.g., TVL, MVRV, funding rate)",
    "Metric 2": "Value with context",
    "Metric 3": "Value with context"
  },
  "catalysts": [
    "Event 1 (Date) - Expected impact",
    "Event 2 (Date) - Expected impact"
  ],
  "thesis": "Your main argument in 2-3 sentences with SPECIFIC numbers"
}
\`\`\`

Remember: Your analysis will be debated, judged, and executed if you win. Make it count.`;
}
