// Analysis Types - Shared between frontend and backend

import { Recommendation } from './trading';

export type AnalysisStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface InvestmentThesis {
    agentId: string;
    agentName: string;
    ticker: string;
    recommendation: Recommendation;
    confidence: number;
    targetPrice: number;
    timeHorizon: string;
    keyPoints: string[];
    risks: string[];
    catalysts: string[];
    generatedAt: number;
}

export interface DebateRound {
    roundNumber: number;
    bullArgument: string;
    bearArgument: string;
    bullScore: number;
    bearScore: number;
    judgeReasoning: string;
}

export interface DebateResult {
    matchId: string;
    bullAgent: string;
    bearAgent: string;
    rounds: DebateRound[];
    winner: 'bull' | 'bear' | 'tie';
    finalScore: {
        bull: number;
        bear: number;
    };
    confidence: number;
}

export interface Analysis {
    id: string;
    userId: string;
    symbol: string;
    status: AnalysisStatus;
    recommendation?: Recommendation;
    confidence?: number;
    createdAt: number;
    completedAt?: number;
    theses: InvestmentThesis[];
    debateResults?: DebateResult[];
    marketData?: MarketData;
    error?: string;
}

export interface MarketData {
    symbol: string;
    price: number;
    change24h: number;
    changePercent24h: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    marketCap?: number;
    timestamp: number;
}

export interface AILog {
    id?: string;
    orderId?: string;
    tradeId?: string;
    stage: string;
    model: string;
    input: Record<string, any>;
    output: Record<string, any>;
    explanation: string;
    createdAt: number;
    submitted?: boolean;
    submittedAt?: number;
}
