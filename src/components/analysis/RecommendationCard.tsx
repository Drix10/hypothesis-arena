/**
 * Recommendation Card Component - Strategic Arena Theme
 * Premium verdict display with confidence visualization
 */

import React from "react";
import { motion } from "framer-motion";
import { FinalRecommendation } from "../../types/stock";

interface RecommendationCardProps {
  recommendation: FinalRecommendation;
}

const REC_STYLES: Record<
  string,
  { gradient: string; text: string; label: string; icon: string; bg: string }
> = {
  strong_buy: {
    gradient: "from-bull to-bull-light",
    text: "text-bull-light",
    label: "STRONG BUY",
    icon: "🚀",
    bg: "bg-bull/[0.08]",
  },
  buy: {
    gradient: "from-bull to-bull-dark",
    text: "text-bull-light",
    label: "BUY",
    icon: "📈",
    bg: "bg-bull/[0.06]",
  },
  hold: {
    gradient: "from-gold to-gold-dark",
    text: "text-gold-light",
    label: "HOLD",
    icon: "⏸️",
    bg: "bg-gold/[0.06]",
  },
  sell: {
    gradient: "from-bear to-bear-dark",
    text: "text-bear-light",
    label: "SELL",
    icon: "📉",
    bg: "bg-bear/[0.06]",
  },
  strong_sell: {
    gradient: "from-bear-dark to-crimson",
    text: "text-bear-light",
    label: "STRONG SELL",
    icon: "🛑",
    bg: "bg-bear/[0.08]",
  },
};

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  recommendation,
}) => {
  const style = REC_STYLES[recommendation.recommendation] || REC_STYLES.hold;
  const isPositive = recommendation.upside >= 0;

  return (
    <motion.div
      className="glass-card rounded-2xl overflow-hidden relative"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Top gradient accent */}
      <div
        className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${style.gradient}`}
      />

      {/* Background glow */}
      <div
        className={`absolute top-0 left-1/2 -translate-x-1/2 w-80 h-80 rounded-full blur-[100px] pointer-events-none ${style.bg} opacity-50`}
      />

      <div className="relative p-5 sm:p-6">
        {/* Main Verdict Section */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
          <div className="flex items-center gap-4">
            <motion.div
              className={`w-16 h-16 rounded-xl bg-gradient-to-br ${style.gradient} flex items-center justify-center text-3xl`}
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
            >
              {style.icon}
            </motion.div>
            <div>
              <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
                Investment Verdict
              </div>
              <motion.div
                className={`text-3xl sm:text-4xl font-bold ${style.text} font-serif`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
              >
                {style.label}
              </motion.div>
            </div>
          </div>

          <div className="flex gap-8">
            <MetricDisplay
              label="Confidence"
              value={`${recommendation.confidence.toFixed(0)}%`}
            />
            <MetricDisplay
              label="Consensus"
              value={`${recommendation.consensusStrength.toFixed(0)}%`}
            />
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          <MetricCard
            label="Current Price"
            value={`${recommendation.currentPrice.toFixed(2)}`}
          />
          <MetricCard
            label="Target Price"
            value={`${recommendation.priceTarget.base.toFixed(2)}`}
          />
          <MetricCard
            label="Upside"
            value={`${isPositive ? "+" : ""}${recommendation.upside.toFixed(
              1
            )}%`}
            variant={isPositive ? "bull" : "bear"}
          />
          <MetricCard
            label="Risk Level"
            value={recommendation.riskLevel.replace("_", " ").toUpperCase()}
            variant={
              recommendation.riskLevel.includes("high")
                ? "bear"
                : recommendation.riskLevel === "medium"
                ? "gold"
                : "bull"
            }
          />
        </div>

        {/* Price Target Range - Enhanced */}
        <div className="p-5 rounded-xl bg-gradient-to-br from-white/[0.03] to-white/[0.01] border border-white/[0.08] mb-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs text-slate-300 font-semibold tracking-wide">
              12-Month Price Target Range
            </span>
            <span className="text-[10px] text-slate-500 bg-white/[0.03] px-2 py-1 rounded-md">
              Current position shown
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className="text-[10px] text-bear-light/70 mb-1 font-medium">
                BEAR
              </div>
              <span className="text-bear-light font-bold text-sm">
                ${recommendation.priceTarget.bear.toFixed(0)}
              </span>
            </div>
            <div
              className="flex-1 relative"
              style={{ paddingTop: "0.5rem", paddingBottom: "0.5rem" }}
            >
              {/* Bar container with rounded corners */}
              <div className="relative h-4 bg-gradient-to-r from-arena-deep via-arena-surface to-arena-deep rounded-full shadow-inner overflow-hidden">
                {/* Gradient background */}
                <div className="absolute inset-0 bg-gradient-to-r from-bear/20 via-gold/20 to-bull/20" />

                {/* Glow effect */}
                <div className="absolute inset-0 bg-gradient-to-r from-bear/10 via-transparent to-bull/10 blur-sm" />
              </div>

              {/* Current price marker - positioned on the bar */}
              <motion.div
                className="absolute z-10 w-5 h-5"
                style={{
                  left: `${calculatePosition(
                    recommendation.currentPrice,
                    recommendation.priceTarget.bear,
                    recommendation.priceTarget.bull
                  )}%`,
                  top: "0.4rem",
                  transform: "translate(-50%, -50%)",
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.5, type: "spring", stiffness: 200 }}
              >
                <div className="relative w-full h-full">
                  <div className="w-full h-full bg-white rounded-full shadow-lg border-2 border-arena-deep" />
                  <div className="absolute inset-0 bg-white rounded-full animate-ping opacity-30" />
                </div>
              </motion.div>

              {/* Target price marker - positioned on the bar */}
              <motion.div
                className="absolute z-10 w-3 h-3"
                style={{
                  left: `${calculatePosition(
                    recommendation.priceTarget.base,
                    recommendation.priceTarget.bear,
                    recommendation.priceTarget.bull
                  )}%`,
                  top: "0.6rem",
                  transform: "translate(-50%, -50%)",
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.6, type: "spring", stiffness: 200 }}
              >
                <div className="relative w-full h-full">
                  <div className="w-full h-full bg-cyan rounded-full shadow-lg shadow-cyan/50" />
                  <div className="absolute inset-0 bg-cyan rounded-full blur-sm opacity-50" />
                </div>
              </motion.div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-bull-light/70 mb-1 font-medium">
                BULL
              </div>
              <span className="text-bull-light font-bold text-sm">
                ${recommendation.priceTarget.bull.toFixed(0)}
              </span>
            </div>
          </div>
          <div className="flex justify-center mt-3 gap-6 text-[10px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-white rounded-full shadow-sm" />{" "}
              Current Price
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-cyan rounded-full shadow-sm shadow-cyan/50" />{" "}
              Base Target
            </span>
          </div>
        </div>

        {/* Allocation & Summary */}
        <div className="grid lg:grid-cols-3 gap-3">
          <div className="p-4 rounded-xl bg-cyan/[0.08] border border-cyan/20">
            <div className="text-[10px] text-slate-500 mb-1.5 font-semibold tracking-wider uppercase">
              Suggested Allocation
            </div>
            <div className="text-2xl font-bold text-cyan">
              {recommendation.suggestedAllocation.toFixed(1)}%
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              of portfolio
            </div>
          </div>

          <div className="lg:col-span-2 p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
            <div className="text-[10px] text-slate-500 mb-2 font-semibold tracking-wider uppercase">
              Executive Summary
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              {recommendation.executiveSummary}
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const MetricDisplay: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="text-center">
    <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
      {label}
    </div>
    <motion.div
      className="text-2xl sm:text-3xl font-bold text-white"
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.4, type: "spring" }}
    >
      {value}
    </motion.div>
  </div>
);

const MetricCard: React.FC<{
  label: string;
  value: string;
  variant?: "bull" | "bear" | "gold";
}> = ({ label, value, variant }) => (
  <motion.div
    className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06] text-center"
    whileHover={{ backgroundColor: "rgba(255,255,255,0.04)" }}
  >
    <div className="text-[10px] text-slate-500 mb-1.5 font-semibold tracking-wider uppercase">
      {label}
    </div>
    <div
      className={`text-lg font-bold ${
        variant === "bull"
          ? "text-bull-light"
          : variant === "bear"
          ? "text-bear-light"
          : variant === "gold"
          ? "text-gold-light"
          : "text-white"
      }`}
    >
      {value}
    </div>
  </motion.div>
);

function calculatePosition(current: number, min: number, max: number): number {
  if (max === min) return 50;
  const position = ((current - min) / (max - min)) * 100;
  return Math.max(5, Math.min(95, position));
}

export default RecommendationCard;
