/**
 * Portfolio Performance Chart - Strategic Arena Theme
 * Premium chart visualization matching analysis aesthetic
 */

import React, { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { AgentPortfolio } from "../../types/trading";
import { motion } from "framer-motion";

interface PortfolioPerformanceChartProps {
  portfolios: AgentPortfolio[];
}

export const PortfolioPerformanceChart: React.FC<
  PortfolioPerformanceChartProps
> = ({ portfolios }) => {
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    new Set(portfolios.map((p) => p.agentId))
  );

  // Update selected agents when portfolios prop changes
  useEffect(() => {
    setSelectedAgents((prev) => {
      const newAgentIds = new Set(portfolios.map((p) => p.agentId));
      // Keep existing selections that are still valid, add new ones
      const updated = new Set<string>();
      portfolios.forEach((p) => {
        if (prev.has(p.agentId) || !prev.size) {
          updated.add(p.agentId);
        }
      });
      // If no selections remain, select all
      return updated.size > 0 ? updated : newAgentIds;
    });
  }, [portfolios]);

  const colors: Record<string, string> = {
    warren: "#8B4513",
    cathie: "#9333EA",
    jim: "#3B82F6",
    ray: "#10B981",
    elon: "#F59E0B",
    karen: "#EF4444",
    quant: "#6366F1",
    devil: "#DC2626",
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

  const toggleAgent = (agentId: string) => {
    const newSelected = new Set(selectedAgents);
    if (newSelected.has(agentId)) {
      newSelected.delete(agentId);
    } else {
      newSelected.add(agentId);
    }
    setSelectedAgents(newSelected);
  };

  const chartData = React.useMemo(() => {
    // Build a map of timestamp -> portfolio values for O(1) lookup
    const portfolioSnapshots = new Map<string, Map<number, number>>();
    const allTimestamps = new Set<number>();

    portfolios.forEach((portfolio) => {
      const snapshotMap = new Map<number, number>();
      portfolio.performanceHistory.forEach((snapshot) => {
        snapshotMap.set(snapshot.timestamp, snapshot.totalValue);
        allTimestamps.add(snapshot.timestamp);
      });
      portfolioSnapshots.set(portfolio.agentId, snapshotMap);
    });

    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    return sortedTimestamps.map((timestamp) => {
      const dataPoint: Record<string, number | string> = {
        timestamp,
        date: new Date(timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
      };

      portfolios.forEach((portfolio) => {
        const snapshotMap = portfolioSnapshots.get(portfolio.agentId);
        const value = snapshotMap?.get(timestamp);
        if (value !== undefined) {
          dataPoint[portfolio.agentId] = value;
        }
      });

      return dataPoint;
    });
  }, [portfolios]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const hasData = chartData.length > 0;

  const bestPerformer =
    portfolios.length > 0
      ? portfolios.reduce((best, p) =>
          p.totalReturn > best.totalReturn ? p : best
        )
      : null;

  const worstPerformer =
    portfolios.length > 0
      ? portfolios.reduce((worst, p) =>
          p.totalReturn < worst.totalReturn ? p : worst
        )
      : null;

  const avgReturn =
    portfolios.length > 0
      ? portfolios.reduce((sum, p) => sum + p.totalReturn, 0) /
        portfolios.length
      : 0;

  const totalTrades = portfolios.reduce((sum, p) => sum + p.totalTrades, 0);

  return (
    <div className="glass-card rounded-xl p-6">
      <div className="mb-6">
        <h2 className="text-xl font-serif font-bold text-white mb-2 flex items-center gap-2">
          <span className="text-2xl">📈</span>
          Portfolio Performance
        </h2>
        <p className="text-slate-400 text-xs">Portfolio value over time</p>
      </div>

      {/* Agent Selection */}
      <div className="mb-6 flex flex-wrap gap-2">
        {portfolios.map((portfolio) => (
          <motion.button
            key={portfolio.agentId}
            onClick={() => toggleAgent(portfolio.agentId)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              selectedAgents.has(portfolio.agentId)
                ? "bg-cyan/20 text-cyan border border-cyan/30"
                : "bg-white/[0.03] text-slate-400 border border-white/[0.08] hover:bg-white/[0.06]"
            }`}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {getMethodologyEmoji(portfolio.methodology)} {portfolio.agentName}
          </motion.button>
        ))}
      </div>

      {/* Chart */}
      {hasData ? (
        <div className="bg-white/[0.02] rounded-xl p-4 border border-white/[0.05]">
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.05)"
              />
              <XAxis
                dataKey="date"
                stroke="#64748b"
                style={{ fontSize: "11px" }}
              />
              <YAxis
                stroke="#64748b"
                style={{ fontSize: "11px" }}
                tickFormatter={formatCurrency}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.95)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "8px",
                  padding: "12px",
                  backdropFilter: "blur(8px)",
                }}
                labelStyle={{ color: "#e2e8f0" }}
                itemStyle={{ color: "#cbd5e1" }}
                formatter={(value: number) => formatCurrency(value)}
              />
              <Legend wrapperStyle={{ fontSize: "11px", color: "#94a3b8" }} />
              {portfolios.map(
                (portfolio) =>
                  selectedAgents.has(portfolio.agentId) && (
                    <Line
                      key={portfolio.agentId}
                      type="monotone"
                      dataKey={portfolio.agentId}
                      name={portfolio.agentName}
                      stroke={colors[portfolio.agentId] || "#3B82F6"}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                  )
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-64 flex items-center justify-center text-slate-400 bg-white/[0.02] rounded-xl border border-white/[0.05]">
          <div className="text-center">
            <p className="text-sm mb-2">No performance data yet</p>
            <p className="text-xs text-slate-500">
              Performance history will appear after trades are executed
            </p>
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="p-4 rounded-lg bg-gradient-to-br from-bull/10 to-bull/5 border border-bull/20">
          <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
            Best Performer
          </div>
          <div className="text-base font-bold text-bull-light">
            {bestPerformer ? bestPerformer.agentName : "N/A"}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-gradient-to-br from-bear/10 to-bear/5 border border-bear/20">
          <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
            Worst Performer
          </div>
          <div className="text-base font-bold text-bear-light">
            {worstPerformer ? worstPerformer.agentName : "N/A"}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
            Avg Return
          </div>
          <div className="text-base font-bold text-white">
            {portfolios.length > 0 ? `${(avgReturn * 100).toFixed(2)}%` : "N/A"}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          <div className="text-[10px] text-slate-500 mb-1 font-semibold tracking-wider uppercase">
            Total Trades
          </div>
          <div className="text-base font-bold text-white">{totalTrades}</div>
        </div>
      </div>
    </div>
  );
};
