/**
 * Recommendation Card - Cinematic Command Center
 * Epic verdict display with dramatic visual hierarchy
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FinalRecommendation } from "../../types/stock";

interface RecommendationCardProps {
  recommendation: FinalRecommendation;
  onExecuteTrades?: () => void;
  tradingPreview?: {
    buyCount: number;
    sellCount: number;
    holdCount: number;
    totalValue: number;
    avgConfidence: number;
  };
}

const REC_CONFIG: Record<
  string,
  {
    gradient: string;
    accent: string;
    glow: string;
    label: string;
    icon: string;
  }
> = {
  strong_buy: {
    gradient: "linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)",
    accent: "#00ff88",
    glow: "0 0 60px rgba(0,255,136,0.4)",
    label: "STRONG BUY",
    icon: "⚡",
  },
  buy: {
    gradient: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
    accent: "#22c55e",
    glow: "0 0 40px rgba(34,197,94,0.3)",
    label: "BUY",
    icon: "↗",
  },
  hold: {
    gradient: "linear-gradient(135deg, #ffd700 0%, #f59e0b 100%)",
    accent: "#ffd700",
    glow: "0 0 40px rgba(255,215,0,0.3)",
    label: "HOLD",
    icon: "◆",
  },
  sell: {
    gradient: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
    accent: "#ef4444",
    glow: "0 0 40px rgba(239,68,68,0.3)",
    label: "SELL",
    icon: "↘",
  },
  strong_sell: {
    gradient: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
    accent: "#dc2626",
    glow: "0 0 60px rgba(220,38,38,0.4)",
    label: "STRONG SELL",
    icon: "⚠",
  },
};

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  recommendation,
  onExecuteTrades,
  tradingPreview,
}) => {
  const config = REC_CONFIG[recommendation.recommendation] || REC_CONFIG.hold;
  const isPositive = recommendation.upside >= 0;
  const hasTradingActivity =
    tradingPreview &&
    (tradingPreview.buyCount > 0 || tradingPreview.sellCount > 0);

  return (
    <div className="relative">
      {/* Outer glow */}
      <div
        className="absolute -inset-2 rounded-3xl opacity-50 blur-xl"
        style={{ background: config.gradient }}
      />

      {/* Main card */}
      <div
        role="article"
        aria-label={`Investment recommendation: ${config.label}`}
        className="relative overflow-hidden rounded-2xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: `${config.glow}, 0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)`,
        }}
      >
        {/* Top accent bar */}
        <div className="h-1" style={{ background: config.gradient }} />

        {/* Diagonal accent */}
        <div
          className="absolute top-0 right-0 w-96 h-96 opacity-10"
          style={{
            background: `linear-gradient(135deg, ${config.accent} 0%, transparent 50%)`,
            clipPath: "polygon(100% 0, 0 0, 100% 100%)",
          }}
        />

        {/* Scanlines */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        <div className="relative p-6 sm:p-8">
          {/* Hero Section */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8 mb-10">
            <div className="flex items-center gap-5">
              <div className="relative">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl"
                  style={{
                    background: config.gradient,
                    boxShadow: config.glow,
                  }}
                >
                  {config.icon}
                </div>
              </div>

              <div>
                <div className="text-[10px] text-slate-500 font-bold tracking-[0.2em] uppercase mb-2">
                  INVESTMENT VERDICT
                </div>
                <h1
                  className="text-4xl sm:text-5xl font-black"
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    color: config.accent,
                    textShadow: `0 0 40px ${config.accent}60`,
                  }}
                >
                  {config.label}
                </h1>
              </div>
            </div>

            {/* Confidence meters */}
            <div className="flex gap-8">
              <CircularMeter
                label="CONFIDENCE"
                value={recommendation.confidence}
                color={config.accent}
              />
              <CircularMeter
                label="CONSENSUS"
                value={recommendation.consensusStrength}
                color="#00f0ff"
              />
            </div>
          </div>

          {/* Metrics Grid */}
          <div
            className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
            role="list"
            aria-label="Key metrics"
          >
            <div role="listitem">
              <MetricCard
                label="CURRENT PRICE"
                value={`${recommendation.currentPrice.toFixed(2)}`}
              />
            </div>
            <div role="listitem">
              <MetricCard
                label="TARGET PRICE"
                value={`${recommendation.priceTarget.base.toFixed(2)}`}
                accent="#00f0ff"
              />
            </div>
            <div role="listitem">
              <MetricCard
                label="UPSIDE"
                value={`${isPositive ? "+" : ""}${recommendation.upside.toFixed(
                  1
                )}%`}
                accent={isPositive ? "#22c55e" : "#ef4444"}
              />
            </div>
            <div role="listitem">
              <MetricCard
                label="RISK LEVEL"
                value={recommendation.riskLevel.replace("_", " ").toUpperCase()}
                accent={
                  recommendation.riskLevel.includes("high")
                    ? "#ef4444"
                    : recommendation.riskLevel === "medium"
                    ? "#ffd700"
                    : "#22c55e"
                }
              />
            </div>
          </div>

          {/* Price Target Range */}
          <div
            className="p-5 rounded-xl mb-8"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-slate-400 font-bold tracking-wider">
                12-MONTH PRICE TARGET RANGE
              </span>
              <span className="text-[10px] text-slate-600 px-2 py-1 rounded bg-white/5">
                Current position shown
              </span>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-[9px] text-red-400/70 mb-1 font-bold tracking-wider">
                  BEAR
                </div>
                <span className="text-red-400 font-bold font-mono">
                  ${recommendation.priceTarget.bear.toFixed(0)}
                </span>
              </div>

              <div className="flex-1 relative py-4">
                <div className="h-3 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
                  <div
                    className="h-full"
                    style={{
                      background:
                        "linear-gradient(90deg, #ef4444 0%, #ffd700 50%, #22c55e 100%)",
                    }}
                  />
                </div>

                {/* Current price marker */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 z-10"
                  style={{
                    left: `${calculatePosition(
                      recommendation.currentPrice,
                      recommendation.priceTarget.bear,
                      recommendation.priceTarget.bull
                    )}%`,
                  }}
                >
                  <div className="w-5 h-5 bg-white rounded-full shadow-lg border-2 border-slate-900" />
                </div>

                {/* Target marker */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 z-10"
                  style={{
                    left: `${calculatePosition(
                      recommendation.priceTarget.base,
                      recommendation.priceTarget.bear,
                      recommendation.priceTarget.bull
                    )}%`,
                  }}
                >
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{
                      background: "#00f0ff",
                      boxShadow: "0 0 20px rgba(0,240,255,0.5)",
                    }}
                  />
                </div>
              </div>

              <div className="text-center">
                <div className="text-[9px] text-green-400/70 mb-1 font-bold tracking-wider">
                  BULL
                </div>
                <span className="text-green-400 font-bold font-mono">
                  ${recommendation.priceTarget.bull.toFixed(0)}
                </span>
              </div>
            </div>

            <div className="flex justify-center gap-6 mt-3 text-[10px] text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 bg-white rounded-full" /> Current
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ background: "#00f0ff" }}
                />{" "}
                Target
              </span>
            </div>
          </div>

          {/* Trading Preview */}
          <AnimatePresence>
            {tradingPreview && (
              <motion.div
                className="p-5 rounded-xl mb-8"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(255,215,0,0.05) 0%, rgba(0,240,255,0.05) 100%)",
                  border: "1px solid rgba(255,215,0,0.2)",
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-bold text-white">
                      <span className="text-xl">⚔️</span>
                      Agent Trading Decisions
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">
                      Based on debate tournament results
                    </div>
                  </div>
                  {hasTradingActivity && onExecuteTrades && (
                    <button
                      onClick={onExecuteTrades}
                      className="px-5 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] transition-transform"
                      style={{
                        background:
                          "linear-gradient(135deg, rgba(255,215,0,0.2) 0%, rgba(0,240,255,0.2) 100%)",
                        border: "1px solid rgba(255,215,0,0.4)",
                        color: "#ffd700",
                      }}
                    >
                      💰 Execute Trades
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <TradingBox
                    type="BUY"
                    count={tradingPreview.buyCount}
                    color="#22c55e"
                    icon="📈"
                  />
                  <TradingBox
                    type="SELL"
                    count={tradingPreview.sellCount}
                    color="#ef4444"
                    icon="📉"
                  />
                  <TradingBox
                    type="HOLD"
                    count={tradingPreview.holdCount}
                    color="#64748b"
                    icon="⏸️"
                  />
                </div>

                {hasTradingActivity && (
                  <div className="flex justify-between mt-4 text-xs text-slate-400">
                    <span>
                      Est. Total:{" "}
                      <span className="text-white font-bold">
                        ${tradingPreview.totalValue.toLocaleString()}
                      </span>
                    </span>
                    <span>
                      Avg. Confidence:{" "}
                      <span className="text-white font-bold">
                        {tradingPreview.avgConfidence.toFixed(0)}%
                      </span>
                    </span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Allocation & Summary */}
          <div className="grid lg:grid-cols-3 gap-4">
            <div
              className="p-5 rounded-xl"
              style={{
                background: "rgba(0,240,255,0.05)",
                border: "1px solid rgba(0,240,255,0.2)",
              }}
            >
              <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-2">
                SUGGESTED ALLOCATION
              </div>
              <div
                className="text-3xl font-black"
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  color: "#00f0ff",
                  textShadow: "0 0 30px rgba(0,240,255,0.4)",
                }}
              >
                {recommendation.suggestedAllocation.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                of portfolio
              </div>
            </div>

            <div
              className="lg:col-span-2 p-5 rounded-xl"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-2">
                EXECUTIVE SUMMARY
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                {recommendation.executiveSummary}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const CircularMeter: React.FC<{
  label: string;
  value: number;
  color: string;
}> = ({ label, value, color }) => (
  <div className="text-center">
    <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-2">
      {label}
    </div>
    <div
      className="text-3xl font-black"
      style={{
        fontFamily: "'Space Grotesk', sans-serif",
        color,
        textShadow: `0 0 30px ${color}60`,
      }}
    >
      {value.toFixed(0)}%
    </div>
  </div>
);

const MetricCard: React.FC<{
  label: string;
  value: string;
  accent?: string;
}> = ({ label, value, accent = "#ffffff" }) => (
  <div
    className="p-4 rounded-xl hover:bg-white/[0.04] transition-colors"
    style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.06)",
    }}
  >
    <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-2">
      {label}
    </div>
    <div
      className="text-xl font-bold"
      style={{
        fontFamily: "'Space Grotesk', sans-serif",
        color: accent,
        textShadow: accent !== "#ffffff" ? `0 0 20px ${accent}40` : "none",
      }}
    >
      {value}
    </div>
  </div>
);

const TradingBox: React.FC<{
  type: string;
  count: number;
  color: string;
  icon: string;
}> = ({ type, count, color, icon }) => (
  <div
    className="p-4 rounded-lg text-center"
    style={{ background: `${color}10`, border: `1px solid ${color}30` }}
  >
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs font-bold" style={{ color }}>
        {type}
      </span>
      <span className="text-lg">{icon}</span>
    </div>
    <div
      className="text-2xl font-black"
      style={{ color, fontFamily: "'Space Grotesk', sans-serif" }}
    >
      {count}
    </div>
    <div className="text-[10px]" style={{ color: `${color}80` }}>
      agents
    </div>
  </div>
);

function calculatePosition(current: number, min: number, max: number): number {
  if (!isFinite(current) || !isFinite(min) || !isFinite(max)) {
    if (process.env.NODE_ENV === "development") {
      console.warn("calculatePosition: Non-finite values detected", {
        current,
        min,
        max,
      });
    }
    return 50;
  }
  if (max === min) {
    if (process.env.NODE_ENV === "development") {
      console.warn("calculatePosition: min equals max", { min, max });
    }
    return 50;
  }
  // Handle negative prices - this shouldn't happen in stock prices but handle gracefully
  if (current < 0 || min < 0 || max < 0) {
    // Use absolute values as fallback
    const absMin = Math.abs(min);
    const absMax = Math.abs(max);
    const absCurrent = Math.abs(current);
    if (absMax === absMin) return 50;
    const position = ((absCurrent - absMin) / (absMax - absMin)) * 100;
    return Math.max(5, Math.min(95, position));
  }

  const position = ((current - min) / (max - min)) * 100;
  return Math.max(5, Math.min(95, position));
}

export default RecommendationCard;
