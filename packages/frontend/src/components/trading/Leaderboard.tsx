/**
 * Leaderboard Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useState, useMemo } from "react";
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

const METHODOLOGY_EMOJIS: Record<string, string> = {
  value: "🎩",
  growth: "🚀",
  technical: "📊",
  macro: "🌍",
  sentiment: "📱",
  risk: "🛡️",
  quant: "🤖",
  contrarian: "😈",
};

export const Leaderboard: React.FC<LeaderboardProps> = ({
  entries,
  onAgentClick,
}) => {
  const [sortField, setSortField] = useState<SortField>("rank");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field)
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    else {
      setSortField(field);
      setSortDirection(field === "rank" ? "asc" : "desc");
    }
  };

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const aVal = a[sortField],
        bVal = b[sortField];
      const aIsNull = aVal === null || aVal === undefined;
      const bIsNull = bVal === null || bVal === undefined;
      if (aIsNull && bIsNull) return 0;
      if (aIsNull) return 1;
      if (bIsNull) return -1;
      if (aVal === bVal) return 0;
      return (aVal > bVal ? 1 : -1) * (sortDirection === "asc" ? 1 : -1);
    });
  }, [entries, sortField, sortDirection]);

  const getRankBadge = (rank: number) => {
    if (rank === 1)
      return {
        emoji: "🥇",
        color: "#ffd700",
        glow: "0 0 20px rgba(255,215,0,0.4)",
      };
    if (rank === 2)
      return {
        emoji: "🥈",
        color: "#c0c0c0",
        glow: "0 0 15px rgba(192,192,192,0.3)",
      };
    if (rank === 3)
      return {
        emoji: "🥉",
        color: "#cd7f32",
        glow: "0 0 15px rgba(205,127,50,0.3)",
      };
    return { emoji: `#${rank}`, color: "#64748b", glow: "none" };
  };

  const formatPercent = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  const getReturnColor = (value: number) =>
    value > 0.1
      ? "#00ff88"
      : value > 0
      ? "#22c55e"
      : value < -0.1
      ? "#ef4444"
      : value < 0
      ? "#dc2626"
      : "#94a3b8";

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
      }}
    >
      {/* Diagonal accent */}
      <div
        className="absolute top-0 right-0 w-40 h-40 opacity-20"
        style={{
          background: "linear-gradient(135deg, #ffd700 0%, transparent 60%)",
          clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        }}
      />
      {/* Scanlines */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />
      {/* Noise */}
      <div
        className="absolute inset-0 opacity-[0.15] pointer-events-none mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Header */}
      <div
        className="px-6 py-5 border-b border-white/[0.06] relative z-10"
        style={{
          background:
            "linear-gradient(90deg, rgba(255,215,0,0.08) 0%, rgba(0,240,255,0.08) 100%)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
            style={{
              background:
                "linear-gradient(145deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)",
              border: "1px solid rgba(255,215,0,0.3)",
              boxShadow: "0 0 30px rgba(255,215,0,0.15)",
            }}
          >
            🏆
          </div>
          <div>
            <h2
              className="text-xl font-black text-white tracking-tight"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Leaderboard
            </h2>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
              Click column headers to sort
            </p>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto relative z-10">
        <table className="w-full">
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.02)" }}>
              {[
                { key: "rank", label: "Rank" },
                { key: null, label: "Agent" },
                { key: "totalReturn", label: "Return" },
                { key: "totalValue", label: "Value" },
                { key: "winRate", label: "Win Rate" },
                { key: "tradesCount", label: "Trades" },
                { key: "sharpeRatio", label: "Sharpe" },
                { key: "maxDrawdown", label: "Max DD" },
              ].map((col) => (
                <th
                  key={col.label}
                  onClick={
                    col.key ? () => handleSort(col.key as SortField) : undefined
                  }
                  onKeyDown={
                    col.key
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleSort(col.key as SortField);
                          }
                        }
                      : undefined
                  }
                  role={col.key ? "button" : undefined}
                  tabIndex={col.key ? 0 : undefined}
                  aria-sort={
                    col.key && sortField === col.key
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className={`px-4 py-3 text-left text-[10px] font-black text-slate-500 uppercase tracking-widest ${
                    col.key
                      ? "cursor-pointer hover:bg-white/[0.03] transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                      : ""
                  }`}
                >
                  {col.label}{" "}
                  {col.key &&
                    sortField === col.key &&
                    (sortDirection === "asc" ? "↑" : "↓")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const rankBadge = getRankBadge(entry.rank);
              const returnColor = getReturnColor(entry.totalReturn);
              return (
                <tr
                  key={entry.agentId}
                  onClick={() => onAgentClick?.(entry.agentId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onAgentClick?.(entry.agentId);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${entry.agentName} portfolio details`}
                  className="cursor-pointer transition-colors group hover:bg-white/[0.03] focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span
                      className="text-2xl"
                      style={{ textShadow: rankBadge.glow }}
                    >
                      {rankBadge.emoji}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="text-xl group-hover:scale-110 transition-transform">
                        {METHODOLOGY_EMOJIS[entry.methodology] || "📈"}
                      </span>
                      <div>
                        <div
                          className="text-sm font-bold text-white"
                          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                        >
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
                      className="text-sm font-black"
                      style={{
                        color: returnColor,
                        textShadow: `0 0 15px ${returnColor}40`,
                      }}
                    >
                      {formatPercent(entry.totalReturn)}
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div className="text-sm text-white font-bold font-mono">
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
                    <div className="text-sm text-slate-300 font-mono">
                      {entry.tradesCount}
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div
                      className={`text-sm ${
                        entry.sharpeRatio != null && entry.sharpeRatio < 0
                          ? "text-red-400"
                          : "text-slate-300"
                      }`}
                    >
                      {entry.tradesCount > 0 && entry.sharpeRatio != null
                        ? entry.sharpeRatio.toFixed(2)
                        : "N/A"}
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div
                      className="text-sm font-bold"
                      style={{ color: "#ef4444" }}
                    >
                      {entry.maxDrawdown > 0
                        ? `-${(entry.maxDrawdown * 100).toFixed(1)}%`
                        : "0%"}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && (
        <div className="text-center py-16 text-slate-400 relative z-10">
          <div className="text-4xl mb-3 opacity-30">📊</div>
          <p className="text-sm">
            No trading data yet. Start analyzing stocks to see agent
            performance!
          </p>
        </div>
      )}

      {/* Bottom accent */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #ffd700, #00f0ff, transparent)",
        }}
      />
    </div>
  );
};
