/**
 * Arena Types - AI Analysis & Debate
 */

export interface AIAnalysis {
    analystId: string;
    analystName: string;
    analystEmoji: string;
    recommendation: string;
    confidence: number;
    thesis: string;
    reasoning: string[];
    riskLevel: string;
    priceTarget?: { bull: number; base: number; bear: number };
}

export interface DebateMatch {
    id: string;
    round: "quarterfinal" | "semifinal" | "final";
    bullAnalyst: AIAnalysis;
    bearAnalyst: AIAnalysis;
    winner: "bull" | "bear";
    bullScore: number;
    bearScore: number;
    winningArguments: string[];
}

export const REC_CONFIG: Record<string, { accent: string; label: string; icon: string }> = {
    strong_buy: { accent: "#22D3EE", label: "STRONG BUY", icon: "⚡" },
    buy: { accent: "#4ADE80", label: "BUY", icon: "↗" },
    hold: { accent: "#FFD54F", label: "HOLD", icon: "◆" },
    sell: { accent: "#FB7185", label: "SELL", icon: "↘" },
    strong_sell: { accent: "#F43F5E", label: "STRONG SELL", icon: "⚠" },
};

export const ROUND_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
    quarterfinal: { label: "QUARTER FINAL", icon: "⚔️", color: "#64748b" },
    semifinal: { label: "SEMI FINAL", icon: "🔥", color: "#F5B800" },
    final: { label: "CHAMPIONSHIP", icon: "👑", color: "#FFD54F" },
};
