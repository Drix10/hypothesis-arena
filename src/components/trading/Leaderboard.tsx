/**
 * Leaderboard Component - Strategic Arena Theme
 * Premium ranked display matching analysis aesthetic
 */

import React, { useState } from "react";
import { motion } from "framer-motion";
import { LeaderboardEntry } from "../../types/trading";

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  onAgentClick?: (agentId: string) => void;
}

type SortField =
  | "rank"
  | "totalReturn"
  | "totalValue"
  | "winRate"
  | "tradesCount"
  | "sharpeRatio"
  | "maxDrawdown";

export const Leaderboard: React.FC<LeaderboardProps> = ({
  entries,
  onAgentClick,
}) => {
  const [sortField, setSortField] = useState<SortField>("rank");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection(field === "rank" ? "asc" : "desc");
    }
  };

  const sortedEntries = [...entries].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];

    // Handle null/undefined values consistently:
    // - null means "not yet calculated" (e.g., sharpeRatio needs 30+ data points)
    // - These should sort to the end regardless of sort direction
    const aIsNull = aVal === null || aVal === undefined;
    const bIsNull = bVal === null || bVal === undefined;

    // Both null - equal
    if (aIsNull && bIsNull) return 0;
    // Only a is null - always sort to end
    if (aIsNull) return 1;
    // Only b is null - always sort to end
    if (bIsNull) return -1;

    // Both have values - normal comparison
    if (aVal === bVal) return 0;
    const multiplier = sortDirection === "asc" ? 1 : -1;
    return (aVal > bVal ? 1 : -1) * multiplier;
  });

  const getRankBadge = (rank: number) => {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return `#${rank}`;
  };

  const getMethodologyEmoji = (methodology: string) => {
    const emojis: Record<string, string> = {
      value: "🎩",
      growth: "🚀",
      technical: "📊",
      macro: "🌍",
      sentiment: "📱",
      risk: "🛡️",
      quant: "🤖",
      contrarian: "😈",
    };
    return emojis[methodology] || "📈";
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(2)}%`;
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const getReturnColor = (value: number) => {
    if (value > 0.1) return "text-bull-light";
    if (value > 0) return "text-bull";
    if (value < -0.1) return "text-bear-light";
    if (value < 0) return "text-bear";
    return "text-slate-400";
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="px-6 py-4 bg-gradient-to-r from-gold/20 to-cyan/20 border-b border-white/[0.08]">
        <h2 className="text-xl font-serif font-bold text-white flex items-center gap-2">
          <span className="text-2xl">🏆</span>
          Leaderboard
        </h2>
        <p className="text-slate-400 text-xs mt-1">
          Click column headers to sort
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-white/[0.02] border-b border-white/[0.05]">
            <tr>
              <th
                onClick={() => handleSort("rank")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "rank"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleSort("rank")}
              >
                Rank{" "}
                {sortField === "rank" && (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider"
                scope="col"
              >
                Agent
              </th>
              <th
                onClick={() => handleSort("totalReturn")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "totalReturn"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" && handleSort("totalReturn")
                }
              >
                Return{" "}
                {sortField === "totalReturn" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                onClick={() => handleSort("totalValue")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "totalValue"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleSort("totalValue")}
              >
                Value{" "}
                {sortField === "totalValue" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                onClick={() => handleSort("winRate")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "winRate"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleSort("winRate")}
              >
                Win Rate{" "}
                {sortField === "winRate" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                onClick={() => handleSort("tradesCount")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "tradesCount"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" && handleSort("tradesCount")
                }
              >
                Trades{" "}
                {sortField === "tradesCount" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                onClick={() => handleSort("sharpeRatio")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "sharpeRatio"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" && handleSort("sharpeRatio")
                }
              >
                Sharpe{" "}
                {sortField === "sharpeRatio" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
              <th
                onClick={() => handleSort("maxDrawdown")}
                className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-white/[0.03] transition-colors"
                scope="col"
                role="columnheader"
                aria-sort={
                  sortField === "maxDrawdown"
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter" && handleSort("maxDrawdown")
                }
              >
                Max DD{" "}
                {sortField === "maxDrawdown" &&
                  (sortDirection === "asc" ? "↑" : "↓")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {sortedEntries.map((entry, index) => (
              <motion.tr
                key={entry.agentId}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => onAgentClick?.(entry.agentId)}
                onKeyDown={(e) =>
                  (e.key === "Enter" || e.key === " ") &&
                  onAgentClick?.(entry.agentId)
                }
                tabIndex={0}
                role="button"
                aria-label={`View ${entry.agentName} portfolio details`}
                className="hover:bg-white/[0.03] cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-cyan/50"
              >
                <td className="px-4 py-4 whitespace-nowrap">
                  <span className="text-2xl">{getRankBadge(entry.rank)}</span>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">
                      {getMethodologyEmoji(entry.methodology)}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {entry.agentName}
                      </div>
                      <div className="text-[10px] text-slate-500 capitalize">
                        {entry.methodology}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div
                    className={`text-sm font-bold ${getReturnColor(
                      entry.totalReturn
                    )}`}
                  >
                    {formatPercent(entry.totalReturn)}
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="text-sm text-white font-medium">
                    {formatCurrency(entry.totalValue)}
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="text-sm text-slate-300">
                    {entry.tradesCount > 0
                      ? `${(entry.winRate * 100).toFixed(1)}%`
                      : "N/A"}
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="text-sm text-slate-300">
                    {entry.tradesCount}
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div
                    className={`text-sm ${
                      entry.sharpeRatio !== null && entry.sharpeRatio < 0
                        ? "text-bear-light"
                        : "text-slate-300"
                    }`}
                  >
                    {entry.tradesCount > 0 && entry.sharpeRatio !== null
                      ? entry.sharpeRatio.toFixed(2)
                      : "N/A"}
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="text-sm text-bear-light font-medium">
                    {entry.maxDrawdown > 0
                      ? `-${(entry.maxDrawdown * 100).toFixed(1)}%`
                      : "0%"}
                  </div>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <p className="text-sm">
            No trading data yet. Start analyzing stocks to see agent
            performance!
          </p>
        </div>
      )}
    </div>
  );
};
