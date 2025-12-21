/**
 * Recent Trades Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useState, useMemo } from "react";
import { AgentPortfolio } from "../../types/trading";

interface RecentTradesProps {
  portfolios: AgentPortfolio[];
  limit?: number;
}

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

export const RecentTrades: React.FC<RecentTradesProps> = ({
  portfolios,
  limit = 20,
}) => {
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterType, setFilterType] = useState<"all" | "BUY" | "SELL">("all");

  const { filteredTrades, displayTrades } = useMemo(() => {
    const trades = portfolios.flatMap((portfolio) =>
      portfolio.trades.map((trade) => ({
        ...trade,
        agentName: portfolio.agentName,
        agentId: portfolio.agentId,
        methodology: portfolio.methodology,
      }))
    );
    const sorted = trades.slice().sort((a, b) => b.timestamp - a.timestamp);
    const filtered = sorted.filter((trade) => {
      if (filterAgent !== "all" && trade.agentId !== filterAgent) return false;
      if (filterType !== "all" && trade.type !== filterType) return false;
      return true;
    });
    return {
      filteredTrades: filtered,
      displayTrades: filtered.slice(0, limit),
    };
  }, [portfolios, filterAgent, filterType, limit]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  const formatDateTime = (timestamp: number) =>
    new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

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
        className="absolute top-0 right-0 w-32 h-32 opacity-20"
        style={{
          background: "linear-gradient(135deg, #00f0ff 0%, transparent 60%)",
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
            "linear-gradient(90deg, rgba(0,240,255,0.08) 0%, rgba(34,197,94,0.08) 100%)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
            style={{
              background:
                "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
              border: "1px solid rgba(0,240,255,0.3)",
              boxShadow: "0 0 30px rgba(0,240,255,0.15)",
            }}
          >
            🎯
          </div>
          <div>
            <h2
              className="text-xl font-black text-white tracking-tight"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Recent Trades
            </h2>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
              Latest trading activity across all agents
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div
        className="px-6 py-4 border-b border-white/[0.06] flex gap-4 relative z-10"
        style={{ background: "rgba(255,255,255,0.01)" }}
      >
        <div>
          <label className="block text-[9px] font-black text-slate-500 mb-1.5 uppercase tracking-widest">
            Agent
          </label>
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm text-white focus:outline-none"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <option value="all">All Agents</option>
            {portfolios.map((p) => (
              <option key={p.agentId} value={p.agentId}>
                {p.agentName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[9px] font-black text-slate-500 mb-1.5 uppercase tracking-widest">
            Type
          </label>
          <select
            value={filterType}
            onChange={(e) =>
              setFilterType(e.target.value as "all" | "BUY" | "SELL")
            }
            className="px-3 py-2 rounded-lg text-sm text-white focus:outline-none"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <option value="all">All Types</option>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto relative z-10">
        <table className="w-full">
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.02)" }}>
              {[
                "Time",
                "Agent",
                "Type",
                "Ticker",
                "Shares",
                "Price",
                "Total",
                "P&L",
              ].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-[10px] font-black text-slate-500 uppercase tracking-widest"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayTrades.map((trade) => (
              <tr
                key={trade.id}
                className="transition-colors group hover:bg-white/[0.03]"
                style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
              >
                <td className="px-4 py-4 whitespace-nowrap text-xs text-slate-400 font-mono">
                  {formatDateTime(trade.timestamp)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className="text-base group-hover:scale-110 transition-transform">
                      {METHODOLOGY_EMOJIS[trade.methodology] || "📈"}
                    </span>
                    <span className="text-sm font-bold text-white">
                      {trade.agentName}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-black"
                    style={{
                      background:
                        trade.type === "BUY"
                          ? "rgba(0,255,136,0.12)"
                          : "rgba(239,68,68,0.12)",
                      border: `1px solid ${
                        trade.type === "BUY"
                          ? "rgba(0,255,136,0.3)"
                          : "rgba(239,68,68,0.3)"
                      }`,
                      color: trade.type === "BUY" ? "#00ff88" : "#ef4444",
                    }}
                  >
                    {trade.type === "BUY" ? "▲" : "▼"} {trade.type}
                  </span>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span
                    className="text-sm font-black text-white"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                  >
                    {trade.ticker}
                  </span>
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-300 font-mono">
                  {trade.shares}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-300 font-mono">
                  {formatCurrency(trade.price)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm font-bold text-white font-mono">
                  {formatCurrency(trade.totalValue)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm">
                  {trade.realizedPnL != null ? (
                    <span
                      className="font-black"
                      style={{
                        color: trade.realizedPnL >= 0 ? "#00ff88" : "#ef4444",
                        textShadow: `0 0 10px ${
                          trade.realizedPnL >= 0
                            ? "rgba(0,255,136,0.3)"
                            : "rgba(239,68,68,0.3)"
                        }`,
                      }}
                    >
                      {trade.realizedPnL >= 0 ? "+" : ""}
                      {formatCurrency(trade.realizedPnL)}
                      {trade.realizedPnLPercent != null && (
                        <span className="text-[10px] ml-1 opacity-70">
                          ({(trade.realizedPnLPercent * 100).toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayTrades.length === 0 && (
        <div className="text-center py-16 text-slate-400 relative z-10">
          <div className="text-4xl mb-3 opacity-30">🎯</div>
          <p className="text-sm">
            No trades yet. Start analyzing stocks to see trading activity!
          </p>
        </div>
      )}

      {filteredTrades.length > limit && (
        <div
          className="px-6 py-4 border-t border-white/[0.06] text-center text-xs text-slate-400 relative z-10"
          style={{ background: "rgba(255,255,255,0.01)" }}
        >
          Showing {limit} of {filteredTrades.length} trades
        </div>
      )}

      {/* Bottom accent */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #00f0ff, #22c55e, transparent)",
        }}
      />
    </div>
  );
};
