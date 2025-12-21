/**
 * Recent Trades Component - Strategic Arena Theme
 * Premium trade history display matching analysis aesthetic
 */

import React, { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AgentPortfolio } from "../../types/trading";

interface RecentTradesProps {
  portfolios: AgentPortfolio[];
  limit?: number;
}

export const RecentTrades: React.FC<RecentTradesProps> = ({
  portfolios,
  limit = 20,
}) => {
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterType, setFilterType] = useState<"all" | "BUY" | "SELL">("all");

  // Memoize expensive derived data computations
  const { filteredTrades, displayTrades } = useMemo(() => {
    const trades = portfolios.flatMap((portfolio) =>
      portfolio.trades.map((trade) => ({
        ...trade,
        agentName: portfolio.agentName,
        agentId: portfolio.agentId,
        methodology: portfolio.methodology,
      }))
    );

    // Use slice() before sort() to avoid mutating the original array
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

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatDateTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="px-6 py-4 bg-gradient-to-r from-cyan/20 to-bull/20 border-b border-white/[0.08]">
        <h2 className="text-xl font-serif font-bold text-white flex items-center gap-2">
          <span className="text-2xl">🎯</span>
          Recent Trades
        </h2>
        <p className="text-slate-400 text-xs mt-1">
          Latest trading activity across all agents
        </p>
      </div>

      {/* Filters */}
      <div className="px-6 py-4 bg-white/[0.02] border-b border-white/[0.05] flex gap-4">
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 mb-1.5 uppercase tracking-wider">
            Agent
          </label>
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="px-3 py-1.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
          >
            <option value="all">All Agents</option>
            {portfolios.map((portfolio) => (
              <option key={portfolio.agentId} value={portfolio.agentId}>
                {portfolio.agentName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 mb-1.5 uppercase tracking-wider">
            Type
          </label>
          <select
            value={filterType}
            onChange={(e) =>
              setFilterType(e.target.value as "all" | "BUY" | "SELL")
            }
            className="px-3 py-1.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
          >
            <option value="all">All Types</option>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </div>
      </div>

      {/* Trades Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-white/[0.02] border-b border-white/[0.05]">
            <tr>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Time
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Agent
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Type
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Ticker
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Shares
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Price
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Total
              </th>
              <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                P&L
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {displayTrades.map((trade, index) => (
              <motion.tr
                key={trade.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.02 }}
                className="hover:bg-white/[0.03] transition-colors"
              >
                <td className="px-4 py-4 whitespace-nowrap text-xs text-slate-400">
                  {formatDateTime(trade.timestamp)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className="text-base">
                      {getMethodologyEmoji(trade.methodology)}
                    </span>
                    <span className="text-sm font-medium text-white">
                      {trade.agentName}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold ${
                      trade.type === "BUY"
                        ? "bg-bull/20 text-bull-light border border-bull/30"
                        : "bg-bear/20 text-bear-light border border-bear/30"
                    }`}
                  >
                    {trade.type === "BUY" ? "📈" : "📉"} {trade.type}
                  </span>
                </td>
                <td className="px-4 py-4 whitespace-nowrap">
                  <span className="text-sm font-bold text-white">
                    {trade.ticker}
                  </span>
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-300">
                  {trade.shares}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-300">
                  {formatCurrency(trade.price)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-white">
                  {formatCurrency(trade.totalValue)}
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm">
                  {trade.realizedPnL !== undefined ? (
                    <span
                      className={`font-bold ${
                        trade.realizedPnL >= 0
                          ? "text-bull-light"
                          : "text-bear-light"
                      }`}
                    >
                      {trade.realizedPnL >= 0 ? "+" : ""}
                      {formatCurrency(trade.realizedPnL)}
                      {trade.realizedPnLPercent !== undefined && (
                        <span className="text-[10px] ml-1 opacity-70">
                          ({(trade.realizedPnLPercent * 100).toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-600">-</span>
                  )}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayTrades.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <p className="text-sm">
            No trades yet. Start analyzing stocks to see trading activity!
          </p>
        </div>
      )}

      {filteredTrades.length > limit && (
        <div className="px-6 py-4 bg-white/[0.02] border-t border-white/[0.05] text-center text-xs text-slate-400">
          Showing {limit} of {filteredTrades.length} trades
        </div>
      )}
    </div>
  );
};
