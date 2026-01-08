/**
 * Analyst Profiles - QUANTITATIVE TRADING EDITION
 * 
 * 4 specialized quant analysts inspired by modern quantitative trading methodologies.
 * Each brings a distinct approach and edge to the parallel analysis pipeline.
 * 
 * PARALLEL ANALYSIS PIPELINE (v5.0.0):
 * - Stage 1 (Market Scan): Fetch data for all 8 coins + indicators
 * - Stage 2 (Parallel Analysis): 4 quants analyze independently in parallel
 * - Stage 3 (Judge Decision): Compare all 4 and pick winner
 * - Stage 4 (Execution): Place trade on WEEX with TP/SL
 * 
 * ANALYST METHODOLOGIES:
 * - Jim (Statistical Arbitrage) - Mean reversion, pattern recognition, statistical models
 * - Ray (ML-Driven Signals) - Machine learning, alternative data, AI-driven predictions
 * - Karen (Multi-Strategy Risk) - Market-neutral, portfolio optimization, risk management
 * - Quant (Liquidity & Arbitrage) - Market making, arbitrage, microstructure analysis
 */

import type { AnalystAgent } from './types';

export const ANALYST_PROFILES: Record<string, AnalystAgent> = {
    technical: {
        id: 'jim',
        name: 'Jim',
        title: 'Statistical Arbitrage Quant',
        methodology: 'technical',
        avatarEmoji: '📊',
        description: 'Statistical arbitrage specialist focusing on mean reversion and pattern recognition. Uses mathematical models to find short-term pricing inefficiencies across crypto perpetuals. Believes markets are not perfectly efficient and exploits transient anomalies.',
        focusAreas: [
            'Mean reversion signals (z-scores, Bollinger bands)',
            'Statistical arbitrage pairs trading',
            'Price pattern recognition via ML',
            'High-frequency signal extraction',
            'Cross-asset correlation breakdowns',
            'Volatility regime detection',
            'Order book imbalance signals',
            'Funding rate mean reversion',
            'Basis trading (perp vs spot)'
        ],
        biases: [
            'Models can overfit to historical patterns',
            'Mean reversion fails in trending markets',
            'Requires high trade frequency for edge'
        ],
        pipelineRole: 'coin_selector',
        coinTypeSpecialty: ['l1_growth', 'momentum_meme'],
        tournamentStrengths: [
            'DATA QUALITY - Precise statistical thresholds with z-scores',
            'LOGIC - Mathematical models with clear entry/exit rules',
            'RISK AWARENESS - Position sizing based on volatility'
        ]
    },

    ml: {
        id: 'ray',
        name: 'Ray',
        title: 'AI/ML Signals Quant',
        methodology: 'ml',
        avatarEmoji: '🤖',
        description: 'ML-driven quant leveraging machine learning and alternative data. Uses AI models trained on vast datasets to predict short-term price movements. Combines traditional market data with sentiment, on-chain metrics, and cross-market signals.',
        focusAreas: [
            'Machine learning price predictions',
            'Sentiment analysis from social/news',
            'On-chain flow analysis',
            'Cross-market correlation signals',
            'Regime classification models',
            'Feature engineering from raw data',
            'Ensemble model predictions',
            'Real-time signal adaptation',
            'Alternative data integration'
        ],
        biases: [
            'ML models can fail in new regimes',
            'Overfitting to training data',
            'Black box decision making'
        ],
        pipelineRole: 'coin_selector',
        coinTypeSpecialty: ['blue_chip'],
        tournamentStrengths: [
            'DATA QUALITY - Multi-source data fusion',
            'LOGIC - AI-driven probability estimates',
            'CATALYST - Detects regime shifts early'
        ]
    },

    risk: {
        id: 'karen',
        name: 'Karen',
        title: 'Multi-Strategy Risk Quant',
        methodology: 'risk',
        avatarEmoji: '🛡️',
        description: 'Multi-strategy quant focused on market-neutral approaches and risk-adjusted returns. Combines multiple uncorrelated strategies to generate alpha while minimizing drawdowns. Emphasizes capital preservation and Sharpe ratio optimization.',
        focusAreas: [
            'Market-neutral position construction',
            'Portfolio beta hedging',
            'Drawdown and VaR limits',
            'Correlation risk monitoring',
            'Leverage optimization',
            'Liquidation distance analysis',
            'Funding cost vs expected return',
            'Position concentration limits',
            'Tail risk hedging'
        ],
        biases: [
            'May sacrifice upside for risk control',
            'Over-hedging reduces returns',
            'Conservative in trending markets'
        ],
        pipelineRole: 'risk_council',
        coinTypeSpecialty: ['blue_chip', 'utility'],
        tournamentStrengths: [
            'RISK AWARENESS - Primary strength, Sharpe ratio focus',
            'DATA QUALITY - Precise risk metrics and limits',
            'LOGIC - Systematic risk rules without emotion'
        ]
    },

    quant: {
        id: 'quant',
        name: 'Quant',
        title: 'Liquidity & Arbitrage Quant',
        methodology: 'quant',
        avatarEmoji: '⚡',
        description: 'Market microstructure specialist focusing on liquidity and arbitrage opportunities. Exploits pricing inefficiencies across exchanges and instruments. Focuses on bid-ask spreads, cross-exchange arb, and ETF/index arbitrage opportunities.',
        focusAreas: [
            'Cross-exchange price discrepancies',
            'Funding rate arbitrage',
            'Basis spread opportunities',
            'Order flow toxicity analysis',
            'Market microstructure signals',
            'Liquidity provision edge',
            'Index vs components arbitrage',
            'Execution cost optimization',
            'Latency-sensitive opportunities'
        ],
        biases: [
            'Arb opportunities are fleeting',
            'Requires fast execution',
            'Edge erodes with competition'
        ],
        pipelineRole: 'coin_selector',
        coinTypeSpecialty: ['l1_growth', 'utility'],
        tournamentStrengths: [
            'DATA QUALITY - Real-time spread and flow analysis',
            'LOGIC - Clear arbitrage math with defined edge',
            'RISK AWARENESS - Tight stops on failed arbs'
        ]
    }
};
