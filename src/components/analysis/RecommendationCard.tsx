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

        {/* Price Target Range */}
        <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400 font-medium">
              12-Month Price Target Range
            </span>
            <span className="text-[10px] text-slate-600">
              Current position shown
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-bear-light font-semibold text-xs w-16">
              ${recommendation.priceTarget.bear.toFixed(0)}
            </span>
            <div className="flex-1 relative h-3 bg-arena-deep rounded-full overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-bear/30 via-gold/30 to-bull/30" />
              <motion.div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-md border-2 border-arena-deep"
                style={{
                  left: `${calculatePosition(
                    recommendation.currentPrice,
                    recommendation.priceTarget.bear,
                    recommendation.priceTarget.bull
                  )}%`,
                }}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.5, type: "spring" }}
              />
              <motion.div
                className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-cyan rounded-full"
                style={{
                  left: `${calculatePosition(
                    recommendation.priceTarget.base,
                    recommendation.priceTarget.bear,
                    recommendation.priceTarget.bull
                  )}%`,
                }}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.6, type: "spring" }}
              />
            </div>
            <span className="text-bull-light font-semibold text-xs w-16 text-right">
              ${recommendation.priceTarget.bull.toFixed(0)}
            </span>
          </div>
          <div className="flex justify-center mt-2.5 gap-5 text-[10px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-white rounded-full" /> Current
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 bg-cyan rounded-full" /> Target
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
