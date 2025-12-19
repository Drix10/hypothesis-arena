/**
 * Analyst Card Component - Strategic Arena Theme
 * Premium analyst thesis display with methodology focus
 */

import React, { useState } from "react";
import { motion } from "framer-motion";
import { InvestmentThesis } from "../../types/stock";
import { getAnalystById } from "../../services/stock";

interface AnalystCardProps {
  thesis: InvestmentThesis;
  onClick?: () => void;
  isWinner?: boolean;
}

const REC_STYLES: Record<
  string,
  { bg: string; border: string; text: string; label: string; glow: string }
> = {
  strong_buy: {
    bg: "bg-bull/[0.12]",
    border: "border-bull/30",
    text: "text-bull-light",
    label: "STRONG BUY",
    glow: "",
  },
  buy: {
    bg: "bg-bull/[0.10]",
    border: "border-bull/20",
    text: "text-bull-light",
    label: "BUY",
    glow: "",
  },
  hold: {
    bg: "bg-gold/[0.10]",
    border: "border-gold/25",
    text: "text-gold-light",
    label: "HOLD",
    glow: "",
  },
  sell: {
    bg: "bg-bear/[0.10]",
    border: "border-bear/20",
    text: "text-bear-light",
    label: "SELL",
    glow: "",
  },
  strong_sell: {
    bg: "bg-bear/[0.12]",
    border: "border-bear/30",
    text: "text-bear-light",
    label: "STRONG SELL",
    glow: "",
  },
};

export const AnalystCard: React.FC<AnalystCardProps> = ({
  thesis,
  onClick,
  isWinner = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const analyst = getAnalystById(thesis.agentId);
  if (!analyst) return null;

  const style = REC_STYLES[thesis.recommendation] || REC_STYLES.hold;

  return (
    <motion.div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative glass-card rounded-xl p-4 transition-all duration-200 group ${
        isWinner ? "ring-1 ring-gold/40" : ""
      } ${onClick ? "cursor-pointer" : ""}`}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.99 }}
      layout
    >
      {/* Winner Badge */}
      {isWinner && (
        <motion.div
          className="absolute -top-2 -right-2 px-2 py-1 bg-gradient-to-r from-gold to-gold-light text-arena-deep text-[10px] font-bold rounded-md flex items-center gap-1"
          initial={{ scale: 0, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 500 }}
          role="status"
          aria-label="Tournament Champion"
        >
          <span aria-hidden="true">🏆</span>
          <span>CHAMPION</span>
        </motion.div>
      )}

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <motion.div
          className="w-10 h-10 rounded-lg bg-gradient-to-br from-white/[0.08] to-white/[0.03] flex items-center justify-center text-xl border border-white/[0.08]"
          animate={{ rotate: isHovered ? [0, -3, 3, 0] : 0 }}
          transition={{ duration: 0.4 }}
        >
          {analyst.avatarEmoji}
        </motion.div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white text-sm truncate">
            {analyst.name}
          </div>
          <div className="text-[11px] text-slate-500 truncate">
            {analyst.title}
          </div>
        </div>
      </div>

      {/* Recommendation Badge */}
      <div
        className={`inline-flex px-2.5 py-1 rounded-md text-[10px] font-bold ${style.bg} ${style.border} ${style.text} border mb-3`}
      >
        {style.label}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-0.5 font-medium">
            Confidence
          </div>
          <div className="text-lg font-bold text-white">
            {thesis.confidence}%
          </div>
        </div>
        <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-0.5 font-medium">
            Target
          </div>
          <div className="text-lg font-bold text-white">
            ${thesis.priceTarget.base.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Price Range Visualization */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[10px] mb-1.5">
          <span className="text-bear-light font-medium">
            ${thesis.priceTarget.bear.toFixed(0)}
          </span>
          <span className="text-slate-600">Range</span>
          <span className="text-bull-light font-medium">
            ${thesis.priceTarget.bull.toFixed(0)}
          </span>
        </div>
        <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-bear/70 via-gold/70 to-bull/70 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: "100%" }}
            transition={{ duration: 0.6, delay: 0.2 }}
          />
        </div>
      </div>

      {/* Key Point */}
      {thesis.bullCase.length > 0 && (
        <div className="pt-3 border-t border-white/[0.05]">
          <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2">
            "{thesis.bullCase[0]}"
          </p>
        </div>
      )}

      {/* Hover indicator */}
      <motion.div
        className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan to-cyan-light rounded-b-xl"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: isHovered ? 1 : 0 }}
        transition={{ duration: 0.2 }}
      />
    </motion.div>
  );
};

export default AnalystCard;
