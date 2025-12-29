/**
 * Analyst Grid - 8 AI analysts in responsive grid
 */

import React from "react";
import { motion } from "framer-motion";
import { CircularMeter } from "../ui/CircularMeter";
import { PulseIndicator } from "../ui/PulseIndicator";
import { AnimatedNumber } from "../ui/AnimatedNumber";

const ANALYST_INFO: Record<
  string,
  { name: string; emoji: string; color: string; desc: string }
> = {
  warren: {
    name: "Warren",
    emoji: "🎩",
    color: "text-blue-400",
    desc: "Value Investor",
  },
  cathie: {
    name: "Cathie",
    emoji: "🚀",
    color: "text-purple-400",
    desc: "Growth Investor",
  },
  jim: {
    name: "Jim",
    emoji: "📊",
    color: "text-green-400",
    desc: "Technical Analyst",
  },
  ray: {
    name: "Ray",
    emoji: "🌍",
    color: "text-cyan-400",
    desc: "Macro Strategist",
  },
  elon: {
    name: "Elon",
    emoji: "📱",
    color: "text-yellow-400",
    desc: "Sentiment Analyst",
  },
  karen: {
    name: "Karen",
    emoji: "🛡️",
    color: "text-rose-400",
    desc: "Risk Manager",
  },
  quant: {
    name: "Quant",
    emoji: "🤖",
    color: "text-indigo-400",
    desc: "Quantitative",
  },
  devil: {
    name: "Devil",
    emoji: "😈",
    color: "text-red-400",
    desc: "Contrarian",
  },
};

// Status configuration moved outside component to prevent recreation
const STATUS_CONFIG: Record<
  string,
  {
    bgClass: string;
    textClass: string;
    borderClass: string;
    label: string;
    pulse: boolean;
    pulseColor: "blue" | "green" | "yellow" | "red" | "cyan";
  }
> = {
  analyzing: {
    bgClass: "bg-blue-500/20",
    textClass: "text-blue-400",
    borderClass: "border-blue-500/30",
    label: "ANALYZING",
    pulse: true,
    pulseColor: "blue",
  },
  trading: {
    bgClass: "bg-green-500/20",
    textClass: "text-green-400",
    borderClass: "border-green-500/30",
    label: "TRADING",
    pulse: true,
    pulseColor: "green",
  },
  cooldown: {
    bgClass: "bg-yellow-500/20",
    textClass: "text-yellow-400",
    borderClass: "border-yellow-500/30",
    label: "COOLDOWN",
    pulse: false,
    pulseColor: "yellow",
  },
  paused: {
    bgClass: "bg-red-500/20",
    textClass: "text-red-400",
    borderClass: "border-red-500/30",
    label: "PAUSED",
    pulse: false,
    pulseColor: "red",
  },
  idle: {
    bgClass: "bg-cyan-500/20",
    textClass: "text-cyan-400",
    borderClass: "border-cyan-500/30",
    label: "IDLE",
    pulse: false,
    pulseColor: "cyan",
  },
};

export interface AnalystState {
  id: string;
  balance: number;
  totalValue: number;
  returnPercent: number;
  rank: number;
  status: "analyzing" | "trading" | "cooldown" | "paused" | "idle";
  tradesCount: number;
  winRate: number;
  lastTrade?: { symbol: string; side: string; pnl?: number };
}

interface AnalystGridProps {
  analysts: AnalystState[];
  onAnalystClick?: (analyst: AnalystState) => void;
}

export const AnalystGrid: React.FC<AnalystGridProps> = ({
  analysts,
  onAnalystClick,
}) => {
  // Sort by rank
  const sorted = [...analysts].sort((a, b) => a.rank - b.rank);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {sorted.map((analyst, index) => (
        <AnalystCard
          key={analyst.id}
          analyst={analyst}
          index={index}
          onClick={() => onAnalystClick?.(analyst)}
        />
      ))}
    </div>
  );
};

const AnalystCard: React.FC<{
  analyst: AnalystState;
  index: number;
  onClick?: () => void;
}> = ({ analyst, index, onClick }) => {
  const info = ANALYST_INFO[analyst.id] || {
    name: analyst.id,
    emoji: "🤖",
    color: "text-slate-400",
    desc: "Analyst",
  };
  const isPositive = analyst.returnPercent >= 0;
  const isTop3 = analyst.rank <= 3;
  const status = STATUS_CONFIG[analyst.status] || STATUS_CONFIG.idle;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      whileHover={{ scale: 1.02, y: -4 }}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${info.name} - ${info.desc}, Rank ${analyst.rank}, ${status.label}`}
      className={`
        glass-card rounded-xl p-4 cursor-pointer transition-all duration-300
        hover:shadow-[0_0_30px_rgba(0,240,255,0.15)]
        focus:outline-none focus:ring-2 focus:ring-cyan-400/50
        ${isTop3 ? "border border-yellow-500/30" : ""}
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <motion.span
            className="text-3xl"
            animate={analyst.status === "trading" ? { scale: [1, 1.1, 1] } : {}}
            transition={{
              duration: 0.5,
              repeat: analyst.status === "trading" ? Infinity : 0,
            }}
          >
            {info.emoji}
          </motion.span>
          <div>
            <h3 className={`font-bold ${info.color}`}>{info.name}</h3>
            <p className="text-xs text-slate-500">{info.desc}</p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Rank</div>
          <div
            className={`text-xl font-bold ${
              isTop3 ? "text-yellow-400" : "text-slate-400"
            }`}
          >
            #{analyst.rank}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-white/5 rounded-lg p-2">
          <div className="text-xs text-slate-500">Balance</div>
          <div className="font-mono font-bold">
            $<AnimatedNumber value={analyst.balance} decimals={2} />
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-2">
          <div className="text-xs text-slate-500">Return</div>
          <div
            className={`font-mono font-bold ${
              isPositive ? "text-green-400" : "text-red-400"
            }`}
          >
            {isPositive ? "+" : ""}
            <AnimatedNumber value={analyst.returnPercent} decimals={2} />%
          </div>
        </div>
      </div>

      {/* Win Rate Meter */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CircularMeter value={analyst.winRate ?? 0} size={40} color="cyan" />
          <div>
            <div className="text-xs text-slate-500">Win Rate</div>
            <div className="text-sm font-bold">
              {(analyst.winRate ?? 0).toFixed(0)}%
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Trades</div>
          <div className="text-sm font-bold">{analyst.tradesCount}</div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between">
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold ${status.bgClass} ${status.textClass} border ${status.borderClass}`}
        >
          <PulseIndicator
            active={status.pulse}
            color={status.pulseColor}
            size="sm"
          />
          {status.label}
        </div>
        {analyst.lastTrade && analyst.lastTrade.symbol && (
          <div className="text-xs text-slate-500">
            {analyst.lastTrade.symbol.replace("cmt_", "").toUpperCase()}
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default AnalystGrid;
