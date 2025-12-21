/**
 * Portfolio Performance Chart - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
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

interface PortfolioPerformanceChartProps {
  portfolios: AgentPortfolio[];
}

const AGENT_COLORS: Record<string, string> = {
  warren: "#cd7f32",
  cathie: "#a855f7",
  jim: "#3b82f6",
  ray: "#10b981",
  elon: "#f59e0b",
  karen: "#ef4444",
  quant: "#6366f1",
  devil: "#dc2626",
};

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

export const PortfolioPerformanceChart: React.FC<
  PortfolioPerformanceChartProps
> = ({ portfolios }) => {
  // Initialize with empty set, populate in useEffect to avoid recreating on every render
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    () => new Set()
  );
  const isInitializedRef = useRef(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  // Listen for changes to motion preference
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setPrefersReducedMotion(e.matches);
    };

    // Modern browsers
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    // Legacy browsers
    else if (mediaQuery.addListener) {
      // Cast to any to handle legacy API
      const legacyHandler = (e: any) => handleChange(e);
      mediaQuery.addListener(legacyHandler);
      return () => mediaQuery.removeListener(legacyHandler);
    }

    return undefined;
  }, []);

  useEffect(() => {
    setSelectedAgents((prev) => {
      const newAgentIds = new Set(portfolios.map((p) => p.agentId));
      // On first render, select all
      if (!isInitializedRef.current) {
        isInitializedRef.current = true;
        return newAgentIds;
      }
      // Keep existing selections that are still valid, even if empty (user deselected all)
      const updated = new Set<string>();
      portfolios.forEach((p) => {
        if (prev.has(p.agentId)) updated.add(p.agentId);
      });
      // Only auto-select all if no valid selections remain (agents were removed)
      return updated.size > 0 || prev.size === 0 ? updated : newAgentIds;
    });
  }, [portfolios]);

  const toggleAgent = (agentId: string) => {
    const newSelected = new Set(selectedAgents);
    if (newSelected.has(agentId)) newSelected.delete(agentId);
    else newSelected.add(agentId);
    setSelectedAgents(newSelected);
  };

  const chartData = useMemo(() => {
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
        if (value !== undefined) dataPoint[portfolio.agentId] = value;
      });
      return dataPoint;
    });
  }, [portfolios]);

  const formatCurrency = (value: number) => {
    if (!isFinite(value) || isNaN(value)) {
      console.warn("formatCurrency: Invalid value detected", value);
      return "$0";
    }
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
    <div
      className="relative overflow-hidden rounded-xl p-6"
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
      <div className="mb-6 relative z-10 flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
          style={{
            background:
              "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
            border: "1px solid rgba(0,240,255,0.3)",
            boxShadow: "0 0 30px rgba(0,240,255,0.15)",
          }}
        >
          📈
        </div>
        <div>
          <h2
            className="text-xl font-black text-white tracking-tight"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Portfolio Performance
          </h2>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
            Portfolio value over time
          </p>
        </div>
      </div>

      {/* Agent Selection */}
      <div className="mb-6 flex flex-wrap gap-2 relative z-10">
        {portfolios.map((portfolio) => (
          <button
            key={portfolio.agentId}
            onClick={() => toggleAgent(portfolio.agentId)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              prefersReducedMotion
                ? ""
                : "hover:scale-[1.02] active:scale-[0.98]"
            }`}
            style={{
              background: selectedAgents.has(portfolio.agentId)
                ? "rgba(0,240,255,0.15)"
                : "rgba(255,255,255,0.03)",
              border: `1px solid ${
                selectedAgents.has(portfolio.agentId)
                  ? "rgba(0,240,255,0.4)"
                  : "rgba(255,255,255,0.08)"
              }`,
              color: selectedAgents.has(portfolio.agentId)
                ? "#00f0ff"
                : "#94a3b8",
            }}
          >
            {METHODOLOGY_EMOJIS[portfolio.methodology] || "📈"}{" "}
            {portfolio.agentName}
          </button>
        ))}
      </div>

      {/* Chart */}
      {hasData ? (
        <div
          className="rounded-xl p-4 relative z-10"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
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
                  backgroundColor: "rgba(13, 17, 23, 0.95)",
                  border: "1px solid rgba(0,240,255,0.3)",
                  borderRadius: "12px",
                  padding: "12px",
                  backdropFilter: "blur(8px)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                }}
                labelStyle={{ color: "#e2e8f0", fontWeight: "bold" }}
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
                      stroke={AGENT_COLORS[portfolio.agentId] || "#3B82F6"}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6, strokeWidth: 2, stroke: "#0d1117" }}
                    />
                  )
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          className="h-64 flex items-center justify-center rounded-xl relative z-10"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div className="text-center">
            <div className="text-4xl mb-3 opacity-30">📊</div>
            <p className="text-sm text-slate-400 mb-1">
              No performance data yet
            </p>
            <p className="text-xs text-slate-500">
              Performance history will appear after trades are executed
            </p>
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3 relative z-10">
        <StatCard
          label="Best Performer"
          value={bestPerformer?.agentName || "N/A"}
          color="#00ff88"
          icon="🏆"
        />
        <StatCard
          label="Worst Performer"
          value={worstPerformer?.agentName || "N/A"}
          color="#ef4444"
          icon="📉"
        />
        <StatCard
          label="Avg Return"
          value={
            portfolios.length > 0 ? `${(avgReturn * 100).toFixed(2)}%` : "N/A"
          }
          color="#fff"
          icon="📊"
        />
        <StatCard
          label="Total Trades"
          value={totalTrades.toString()}
          color="#fff"
          icon="🎯"
        />
      </div>

      {/* Bottom accent */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, #00f0ff, transparent)",
        }}
      />
    </div>
  );
};

const StatCard: React.FC<{
  label: string;
  value: string;
  color: string;
  icon: string;
}> = ({ label, value, color, icon }) => {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setPrefersReducedMotion(e.matches);
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } else if (mediaQuery.addListener) {
      const legacyHandler = (e: any) => handleChange(e);
      mediaQuery.addListener(legacyHandler);
      return () => mediaQuery.removeListener(legacyHandler);
    }
    return undefined;
  }, []);

  return (
    <div
      className={`p-4 rounded-xl ${
        prefersReducedMotion ? "" : "hover:scale-[1.02] transition-transform"
      }`}
      style={{
        background: `linear-gradient(135deg, ${color}08 0%, ${color}03 100%)`,
        border: `1px solid ${color}20`,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="text-[9px] text-slate-500 uppercase tracking-widest font-black">
          {label}
        </span>
      </div>
      <div
        className="text-base font-black"
        style={{
          color,
          fontFamily: "'Space Grotesk', sans-serif",
          textShadow: `0 0 15px ${color}30`,
        }}
      >
        {value}
      </div>
    </div>
  );
};
