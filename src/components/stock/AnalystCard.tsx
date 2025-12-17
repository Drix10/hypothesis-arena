/**
 * Analyst Card Component - Dark Theme
 */

import React from "react";
import { InvestmentThesis } from "../../types/stock";
import { getAnalystById } from "../../services/stock";

interface AnalystCardProps {
  thesis: InvestmentThesis;
  onClick?: () => void;
  isWinner?: boolean;
}

const REC_STYLES: Record<
  string,
  { bg: string; border: string; text: string; label: string }
> = {
  strong_buy: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    text: "text-emerald-400",
    label: "STRONG BUY",
  },
  buy: {
    bg: "bg-emerald-500/5",
    border: "border-emerald-500/20",
    text: "text-emerald-400",
    label: "BUY",
  },
  hold: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-400",
    label: "HOLD",
  },
  sell: {
    bg: "bg-red-500/5",
    border: "border-red-500/20",
    text: "text-red-400",
    label: "SELL",
  },
  strong_sell: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    text: "text-red-400",
    label: "STRONG SELL",
  },
};

export const AnalystCard: React.FC<AnalystCardProps> = ({
  thesis,
  onClick,
  isWinner = false,
}) => {
  const analyst = getAnalystById(thesis.agentId);
  if (!analyst) return null;

  const style = REC_STYLES[thesis.recommendation] || REC_STYLES.hold;

  return (
    <div
      onClick={onClick}
      className={`relative bg-surface border rounded-xl p-4 transition-all duration-300 ${
        isWinner
          ? "border-amber-500/50 ring-1 ring-amber-500/20"
          : "border-white/5 hover:border-white/10"
      } ${onClick ? "cursor-pointer hover:bg-white/[0.02]" : ""}`}
    >
      {/* Winner Badge */}
      {isWinner && (
        <div className="absolute -top-2 -right-2 px-2 py-1 bg-amber-500 text-void text-[10px] font-bold rounded-md">
          🏆 CHAMPION
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center text-xl">
            {analyst.avatarEmoji}
          </div>
          <div>
            <div className="font-semibold text-white text-sm">
              {analyst.name}
            </div>
            <div className="text-xs text-slate-500">{analyst.title}</div>
          </div>
        </div>
      </div>

      {/* Recommendation Badge */}
      <div
        className={`inline-flex px-3 py-1.5 rounded-lg text-xs font-bold ${style.bg} ${style.border} ${style.text} border mb-4`}
      >
        {style.label}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white/[0.02] rounded-lg p-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
            Confidence
          </div>
          <div className="text-lg font-bold text-white">
            {thesis.confidence}%
          </div>
        </div>
        <div className="bg-white/[0.02] rounded-lg p-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
            Target
          </div>
          <div className="text-lg font-bold text-white">
            ${thesis.priceTarget.base.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Price Range */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-red-400">
          ${thesis.priceTarget.bear.toFixed(0)}
        </span>
        <div className="flex-1 h-1 bg-gradient-to-r from-red-500/50 via-amber-500/50 to-emerald-500/50 rounded-full" />
        <span className="text-emerald-400">
          ${thesis.priceTarget.bull.toFixed(0)}
        </span>
      </div>

      {/* Key Point */}
      {thesis.bullCase.length > 0 && (
        <div className="mt-4 pt-4 border-t border-white/5">
          <p className="text-xs text-slate-400 line-clamp-2">
            {thesis.bullCase[0]}
          </p>
        </div>
      )}
    </div>
  );
};

export default AnalystCard;
