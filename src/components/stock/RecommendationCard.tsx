/**
 * Recommendation Card Component - Dark Theme
 */

import React from "react";
import { FinalRecommendation } from "../../types/stock";

interface RecommendationCardProps {
  recommendation: FinalRecommendation;
}

const REC_STYLES: Record<
  string,
  {
    gradient: string;
    glow: string;
    text: string;
    label: string;
    icon: string;
  }
> = {
  strong_buy: {
    gradient: "from-emerald-500 to-emerald-400",
    glow: "shadow-emerald-500/25",
    text: "text-emerald-400",
    label: "STRONG BUY",
    icon: "🚀",
  },
  buy: {
    gradient: "from-emerald-500 to-teal-400",
    glow: "shadow-emerald-500/20",
    text: "text-emerald-400",
    label: "BUY",
    icon: "📈",
  },
  hold: {
    gradient: "from-amber-500 to-orange-400",
    glow: "shadow-amber-500/20",
    text: "text-amber-400",
    label: "HOLD",
    icon: "⏸️",
  },
  sell: {
    gradient: "from-red-500 to-rose-400",
    glow: "shadow-red-500/20",
    text: "text-red-400",
    label: "SELL",
    icon: "📉",
  },
  strong_sell: {
    gradient: "from-red-600 to-red-500",
    glow: "shadow-red-500/25",
    text: "text-red-400",
    label: "STRONG SELL",
    icon: "🛑",
  },
};

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  recommendation,
}) => {
  const style = REC_STYLES[recommendation.recommendation] || REC_STYLES.hold;
  const isPositive = recommendation.upside >= 0;

  return (
    <div className="relative overflow-hidden bg-surface border border-white/5 rounded-2xl">
      {/* Gradient accent line */}
      <div
        className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${style.gradient}`}
      />

      <div className="p-6">
        {/* Main Recommendation */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 mb-8">
          <div className="flex items-center gap-4">
            <div
              className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${style.gradient} flex items-center justify-center text-3xl shadow-lg ${style.glow}`}
            >
              {style.icon}
            </div>
            <div>
              <div className="text-sm text-slate-500 mb-1">
                Investment Verdict
              </div>
              <div className={`text-3xl font-bold ${style.text}`}>
                {style.label}
              </div>
            </div>
          </div>

          <div className="flex gap-8">
            <div className="text-center">
              <div className="text-sm text-slate-500 mb-1">Confidence</div>
              <div className="text-3xl font-bold text-white">
                {recommendation.confidence.toFixed(0)}%
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm text-slate-500 mb-1">Consensus</div>
              <div className="text-3xl font-bold text-white">
                {recommendation.consensusStrength.toFixed(0)}%
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <MetricCard
            label="Current Price"
            value={`$${recommendation.currentPrice.toFixed(2)}`}
          />
          <MetricCard
            label="Target Price"
            value={`$${recommendation.priceTarget.base.toFixed(2)}`}
          />
          <MetricCard
            label="Upside"
            value={`${isPositive ? "+" : ""}${recommendation.upside.toFixed(
              1
            )}%`}
            highlight={isPositive ? "emerald" : "red"}
          />
          <MetricCard
            label="Risk Level"
            value={recommendation.riskLevel.replace("_", " ").toUpperCase()}
            highlight={
              recommendation.riskLevel.includes("high")
                ? "red"
                : recommendation.riskLevel === "medium"
                ? "amber"
                : "emerald"
            }
          />
        </div>

        {/* Price Range Visualization */}
        <div className="bg-white/[0.02] rounded-xl p-4 mb-8">
          <div className="text-xs text-slate-500 mb-3">
            12-Month Price Target Range
          </div>
          <div className="flex items-center gap-4">
            <span className="text-red-400 font-semibold text-sm w-16">
              ${recommendation.priceTarget.bear.toFixed(0)}
            </span>
            <div className="flex-1 relative h-3 bg-void rounded-full overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-red-500 via-amber-500 to-emerald-500 opacity-30" />
              {/* Current price marker */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg shadow-white/20 border-2 border-void"
                style={{
                  left: `${calculatePosition(
                    recommendation.currentPrice,
                    recommendation.priceTarget.bear,
                    recommendation.priceTarget.bull
                  )}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
            </div>
            <span className="text-emerald-400 font-semibold text-sm w-16 text-right">
              ${recommendation.priceTarget.bull.toFixed(0)}
            </span>
          </div>
        </div>

        {/* Allocation & Summary */}
        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-white/[0.02] rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">
              Suggested Allocation
            </div>
            <div className="text-2xl font-bold text-electric-cyan">
              {recommendation.suggestedAllocation.toFixed(1)}%
            </div>
            <div className="text-xs text-slate-600 mt-1">of portfolio</div>
          </div>

          <div className="md:col-span-2 bg-white/[0.02] rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-2">Executive Summary</div>
            <p className="text-sm text-slate-300 leading-relaxed">
              {recommendation.executiveSummary}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

const MetricCard: React.FC<{
  label: string;
  value: string;
  highlight?: "emerald" | "red" | "amber";
}> = ({ label, value, highlight }) => (
  <div className="bg-white/[0.02] rounded-xl p-4 text-center">
    <div className="text-xs text-slate-500 mb-1">{label}</div>
    <div
      className={`text-xl font-bold ${
        highlight === "emerald"
          ? "text-emerald-400"
          : highlight === "red"
          ? "text-red-400"
          : highlight === "amber"
          ? "text-amber-400"
          : "text-white"
      }`}
    >
      {value}
    </div>
  </div>
);

function calculatePosition(current: number, min: number, max: number): number {
  if (max === min) return 50;
  const position = ((current - min) / (max - min)) * 100;
  return Math.max(5, Math.min(95, position));
}

export default RecommendationCard;
