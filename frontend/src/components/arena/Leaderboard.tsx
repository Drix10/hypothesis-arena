/**
 * Leaderboard - Performance rankings table
 */

import React, { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "../ui/AnimatedNumber";
import type { AnalystState } from "./AnalystGrid";

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

type SortKey = "rank" | "return" | "balance" | "winRate" | "trades";

// Moved outside component to prevent re-creation on each render
const SortHeader: React.FC<{
  label: string;
  sortKey: SortKey;
  currentSortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  className?: string;
}> = ({ label, sortKey, currentSortKey, sortAsc, onSort, className = "" }) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSort(sortKey);
    }
  };

  return (
    <th
      onClick={() => onSort(sortKey)}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-sort={
        currentSortKey === sortKey
          ? sortAsc
            ? "ascending"
            : "descending"
          : "none"
      }
      className={`px-4 py-3 text-right text-sm font-semibold text-slate-400 cursor-pointer hover:text-white transition-colors focus:outline-none focus:text-cyan-400 ${className}`}
    >
      <span className="flex items-center justify-end gap-1">
        {label}
        {currentSortKey === sortKey && (
          <span className="text-cyan-400">{sortAsc ? "↑" : "↓"}</span>
        )}
      </span>
    </th>
  );
};

interface LeaderboardProps {
  analysts: AnalystState[];
}

export const Leaderboard: React.FC<LeaderboardProps> = ({ analysts }) => {
  const [sortBy, setSortBy] = useState<SortKey>("return");
  const [sortAsc, setSortAsc] = useState(false);

  // FIXED: Memoize sorted array to prevent unnecessary re-renders
  // Added safe number handling for potentially undefined values
  const sorted = React.useMemo(() => {
    return [...analysts].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortBy) {
        case "rank":
          aVal = a.rank ?? 999;
          bVal = b.rank ?? 999;
          break;
        case "return":
          aVal = a.returnPercent ?? 0;
          bVal = b.returnPercent ?? 0;
          break;
        case "balance":
          aVal = a.totalValue ?? 0;
          bVal = b.totalValue ?? 0;
          break;
        case "winRate":
          aVal = a.winRate ?? 0;
          bVal = b.winRate ?? 0;
          break;
        case "trades":
          aVal = a.tradesCount ?? 0;
          bVal = b.tradesCount ?? 0;
          break;
        default:
          aVal = a.returnPercent ?? 0;
          bVal = b.returnPercent ?? 0;
      }
      return sortAsc ? aVal - bVal : bVal - aVal;
    });
  }, [analysts, sortBy, sortAsc]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortBy === key) {
        setSortAsc((prev) => !prev);
      } else {
        setSortBy(key);
        setSortAsc(false);
      }
    },
    [sortBy]
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-xl overflow-hidden"
    >
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-white/5">
            <tr>
              <SortHeader
                label="Rank"
                sortKey="rank"
                currentSortKey={sortBy}
                sortAsc={sortAsc}
                onSort={handleSort}
                className="text-left w-16"
              />
              <th className="px-4 py-3 text-left text-sm font-semibold text-slate-400">
                Analyst
              </th>
              <SortHeader
                label="Balance"
                sortKey="balance"
                currentSortKey={sortBy}
                sortAsc={sortAsc}
                onSort={handleSort}
              />
              <SortHeader
                label="Return"
                sortKey="return"
                currentSortKey={sortBy}
                sortAsc={sortAsc}
                onSort={handleSort}
              />
              <SortHeader
                label="Win Rate"
                sortKey="winRate"
                currentSortKey={sortBy}
                sortAsc={sortAsc}
                onSort={handleSort}
              />
              <SortHeader
                label="Trades"
                sortKey="trades"
                currentSortKey={sortBy}
                sortAsc={sortAsc}
                onSort={handleSort}
              />
              <th className="px-4 py-3 text-right text-sm font-semibold text-slate-400">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((analyst, index) => {
              const info = ANALYST_INFO[analyst.id] || {
                name: analyst.id,
                emoji: "🤖",
                color: "text-slate-400",
                desc: "Analyst",
              };
              // FIXED: Handle undefined returnPercent
              const returnPercent = analyst.returnPercent ?? 0;
              const isPositive = returnPercent >= 0;
              const isTop3 = index < 3;

              return (
                <motion.tr
                  key={analyst.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="border-t border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-4">
                    <span
                      className={`text-2xl font-bold ${
                        isTop3 ? "text-yellow-400" : "text-slate-600"
                      }`}
                    >
                      {index === 0
                        ? "🥇"
                        : index === 1
                        ? "🥈"
                        : index === 2
                        ? "🥉"
                        : `#${index + 1}`}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{info.emoji}</span>
                      <div>
                        <div className={`font-bold ${info.color}`}>
                          {info.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {info.desc}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="font-mono font-bold">
                      $
                      <AnimatedNumber value={analyst.totalValue} decimals={2} />
                    </div>
                    <div className="text-xs text-slate-500">
                      Cash: $
                      <AnimatedNumber value={analyst.balance} decimals={2} />
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <span
                      className={`font-mono font-bold text-lg ${
                        isPositive ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {isPositive ? "+" : ""}
                      <AnimatedNumber value={returnPercent} decimals={2} />%
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-2 bg-white/10 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-cyan-400"
                          initial={{ width: 0 }}
                          animate={{
                            width: `${
                              Number.isFinite(analyst.winRate)
                                ? analyst.winRate
                                : 0
                            }%`,
                          }}
                          transition={{ duration: 0.5, delay: index * 0.05 }}
                        />
                      </div>
                      <span className="font-mono text-sm">
                        {(Number.isFinite(analyst.winRate)
                          ? analyst.winRate
                          : 0
                        ).toFixed(0)}
                        %
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right font-mono">
                    {analyst.tradesCount ?? 0}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <StatusBadge status={analyst.status} />
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    analyzing: {
      bg: "bg-blue-500/20",
      text: "text-blue-400",
      label: "Analyzing",
    },
    trading: {
      bg: "bg-green-500/20",
      text: "text-green-400",
      label: "Trading",
    },
    cooldown: {
      bg: "bg-yellow-500/20",
      text: "text-yellow-400",
      label: "Cooldown",
    },
    paused: { bg: "bg-red-500/20", text: "text-red-400", label: "Paused" },
    idle: { bg: "bg-slate-500/20", text: "text-slate-400", label: "Idle" },
  };

  const { bg, text, label } = config[status] || config.idle;

  return (
    <span className={`px-2 py-1 rounded text-xs font-semibold ${bg} ${text}`}>
      {label}
    </span>
  );
};

export default Leaderboard;
