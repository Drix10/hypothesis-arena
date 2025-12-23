/**
 * Agent Portfolio View - Cinematic Dark Theme
 *
 * Detailed view of a single agent's portfolio with positions, trades, and performance
 */

import React, { useState, useCallback, useRef } from "react";
import { AgentPortfolio } from "../../types/trading";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface AgentPortfolioViewProps {
  portfolio: AgentPortfolio;
  onBack: () => void;
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

export const AgentPortfolioView: React.FC<AgentPortfolioViewProps> = ({
  portfolio,
  onBack,
}) => {
  const [selectedTab, setSelectedTab] = useState<
    "positions" | "trades" | "performance"
  >("positions");

  // Refs for tab buttons to manage focus
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({
    positions: null,
    trades: null,
    performance: null,
  });

  const formatCurrency = useCallback((value: number) => {
    if (!Number.isFinite(value)) return "$0";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }, []);

  const formatPercent = useCallback((value: number) => {
    if (!Number.isFinite(value)) return "0.00%";
    const sign = value >= 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(2)}%`;
  }, []);

  const formatDateTime = useCallback((timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, []);

  const getStatusConfig = useCallback((status: string) => {
    const config: Record<string, { text: string; color: string; bg: string }> =
      {
        active: {
          text: "✓ Active",
          color: "#00ff88",
          bg: "rgba(0,255,136,0.15)",
        },
        paused: {
          text: "⏸ Paused",
          color: "#ffd700",
          bg: "rgba(255,215,0,0.15)",
        },
        liquidated: {
          text: "⚠ Liquidated",
          color: "#ef4444",
          bg: "rgba(239,68,68,0.15)",
        },
      };
    return config[status] || config.active;
  }, []);

  const getReturnColor = useCallback(
    (value: number) => (value >= 0 ? "#00ff88" : "#ef4444"),
    []
  );

  return (
    <div className="space-y-6">
      {/* Back Button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-cyan hover:text-cyan-light transition-colors font-medium text-sm"
      >
        <span>←</span>
        <span>Back to Leaderboard</span>
      </button>

      {/* Header Card */}
      <div
        className="relative overflow-hidden rounded-xl p-6"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <div
          className="absolute top-0 right-0 w-32 h-32 opacity-20"
          style={{
            background: "linear-gradient(135deg, #ffd700 0%, transparent 60%)",
            clipPath: "polygon(100% 0, 0 0, 100% 100%)",
          }}
        />
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-4">
            <div
              className="w-16 h-16 rounded-xl flex items-center justify-center text-4xl"
              style={{
                background:
                  "linear-gradient(145deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)",
                border: "1px solid rgba(255,215,0,0.3)",
                boxShadow: "0 0 30px rgba(255,215,0,0.15)",
              }}
            >
              {METHODOLOGY_EMOJIS[portfolio.methodology] || "📈"}
            </div>
            <div>
              <h1
                className="text-2xl font-black text-white tracking-tight"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                {portfolio.agentName}
              </h1>
              <p className="text-slate-500 text-sm capitalize">
                {portfolio.methodology} Investor
              </p>
            </div>
          </div>
          <div className="text-right">
            {(() => {
              const statusConfig = getStatusConfig(portfolio.status);
              return (
                <span
                  className="px-2 py-1 rounded-lg text-xs font-bold"
                  style={{
                    background: statusConfig.bg,
                    color: statusConfig.color,
                    border: `1px solid ${statusConfig.color}40`,
                  }}
                >
                  {statusConfig.text}
                </span>
              );
            })()}
            <div className="text-xs text-slate-500 mt-2">
              Last trade:{" "}
              {portfolio.lastTradeAt
                ? formatDateTime(portfolio.lastTradeAt)
                : "Never"}
            </div>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          <MetricCard
            label="Total Value"
            value={formatCurrency(portfolio.totalValue)}
            subValue={formatPercent(portfolio.totalReturn)}
            subColor={getReturnColor(portfolio.totalReturn)}
          />
          <MetricCard
            label="Cash"
            value={formatCurrency(portfolio.currentCash)}
            subValue={
              portfolio.totalValue > 0
                ? `${(
                    (portfolio.currentCash / portfolio.totalValue) *
                    100
                  ).toFixed(1)}% of portfolio`
                : "0%"
            }
          />
          <MetricCard
            label="Win Rate"
            value={
              portfolio.totalTrades > 0
                ? `${(portfolio.winRate * 100).toFixed(1)}%`
                : "N/A"
            }
            subValue={`${portfolio.winningTrades}W / ${portfolio.losingTrades}L`}
          />
          <MetricCard
            label="Max Drawdown"
            value={
              portfolio.maxDrawdown > 0
                ? `-${(portfolio.maxDrawdown * 100).toFixed(1)}%`
                : "0%"
            }
            subValue={`Current: ${
              portfolio.currentDrawdown > 0
                ? `-${(portfolio.currentDrawdown * 100).toFixed(1)}%`
                : "0%"
            }`}
            valueColor="#ef4444"
          />
        </div>
      </div>

      {/* Tabs */}
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="flex border-b border-white/[0.06]"
          role="tablist"
          aria-label="Portfolio sections"
          onKeyDown={(e) => {
            const tabs = ["positions", "trades", "performance"] as const;
            const currentIndex = tabs.indexOf(selectedTab);
            let newIndex = currentIndex;

            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              newIndex = (currentIndex + 1) % tabs.length;
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
            } else if (e.key === "Home") {
              e.preventDefault();
              newIndex = 0;
            } else if (e.key === "End") {
              e.preventDefault();
              newIndex = tabs.length - 1;
            }

            if (newIndex !== currentIndex) {
              setSelectedTab(tabs[newIndex]);
              // Move focus to the new tab
              tabRefs.current[tabs[newIndex]]?.focus();
            }
          }}
        >
          {[
            {
              id: "positions",
              label: `Positions (${portfolio.positions.length})`,
            },
            {
              id: "trades",
              label: `Trade History (${portfolio.trades.length})`,
            },
            { id: "performance", label: "Performance" },
          ].map((tab) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={selectedTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selectedTab === tab.id ? 0 : -1}
              onClick={() => setSelectedTab(tab.id as typeof selectedTab)}
              className={`px-6 py-4 font-medium text-sm transition-colors ${
                selectedTab === tab.id
                  ? "text-cyan border-b-2 border-cyan"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          <div
            id="panel-positions"
            role="tabpanel"
            aria-labelledby="tab-positions"
            hidden={selectedTab !== "positions"}
          >
            {selectedTab === "positions" && (
              <PositionsTab
                portfolio={portfolio}
                formatCurrency={formatCurrency}
                formatPercent={formatPercent}
                getReturnColor={getReturnColor}
              />
            )}
          </div>
          <div
            id="panel-trades"
            role="tabpanel"
            aria-labelledby="tab-trades"
            hidden={selectedTab !== "trades"}
          >
            {selectedTab === "trades" && (
              <TradesTab
                portfolio={portfolio}
                formatCurrency={formatCurrency}
                formatDateTime={formatDateTime}
                getReturnColor={getReturnColor}
              />
            )}
          </div>
          <div
            id="panel-performance"
            role="tabpanel"
            aria-labelledby="tab-performance"
            hidden={selectedTab !== "performance"}
          >
            {selectedTab === "performance" && (
              <PerformanceTab
                portfolio={portfolio}
                formatCurrency={formatCurrency}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Sub-components
const PositionsTab: React.FC<{
  portfolio: AgentPortfolio;
  formatCurrency: (v: number) => string;
  formatPercent: (v: number) => string;
  getReturnColor: (v: number) => string;
}> = ({ portfolio, formatCurrency, formatPercent, getReturnColor }) => {
  if (portfolio.positions.length === 0) {
    return <EmptyState icon="📊" message="No open positions" />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr style={{ background: "rgba(255,255,255,0.02)" }}>
            {[
              "Ticker",
              "Shares",
              "Avg Cost",
              "Current",
              "Value",
              "P&L",
              "% Port",
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
          {portfolio.positions.map((pos) => (
            <tr
              key={pos.ticker}
              className="border-b border-white/[0.04] hover:bg-white/[0.02]"
            >
              <td className="px-4 py-3 font-bold text-white">{pos.ticker}</td>
              <td className="px-4 py-3 text-slate-300">{pos.shares}</td>
              <td className="px-4 py-3 text-slate-300">
                {formatCurrency(pos.avgCostBasis)}
              </td>
              <td className="px-4 py-3 text-slate-300">
                {formatCurrency(pos.currentPrice)}
              </td>
              <td className="px-4 py-3 text-white font-medium">
                {formatCurrency(pos.marketValue)}
              </td>
              <td className="px-4 py-3">
                <span
                  style={{ color: getReturnColor(pos.unrealizedPnL) }}
                  className="font-bold"
                >
                  {formatCurrency(pos.unrealizedPnL)}
                </span>
                <div className="text-xs text-slate-500">
                  {formatPercent(pos.unrealizedPnLPercent)}
                </div>
              </td>
              <td className="px-4 py-3 text-slate-300">
                {portfolio.totalValue > 0
                  ? `${((pos.marketValue / portfolio.totalValue) * 100).toFixed(
                      1
                    )}%`
                  : "0%"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const TradesTab: React.FC<{
  portfolio: AgentPortfolio;
  formatCurrency: (v: number) => string;
  formatDateTime: (v: number) => string;
  getReturnColor: (v: number) => string;
}> = ({ portfolio, formatCurrency, formatDateTime, getReturnColor }) => {
  if (portfolio.trades.length === 0) {
    return <EmptyState icon="📜" message="No trades yet" />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr style={{ background: "rgba(255,255,255,0.02)" }}>
            {["Date", "Type", "Ticker", "Shares", "Price", "Total", "P&L"].map(
              (h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-[10px] font-black text-slate-500 uppercase tracking-widest"
                >
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {portfolio.trades
            .slice()
            .reverse()
            .map((trade) => (
              <tr
                key={trade.id}
                className="border-b border-white/[0.04] hover:bg-white/[0.02]"
              >
                <td className="px-4 py-3 text-sm text-slate-400">
                  {formatDateTime(trade.timestamp)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className="inline-flex items-center px-2 py-1 rounded-lg text-xs font-bold"
                    style={{
                      background:
                        trade.type === "BUY"
                          ? "rgba(0,255,136,0.15)"
                          : "rgba(239,68,68,0.15)",
                      color: trade.type === "BUY" ? "#00ff88" : "#ef4444",
                      border: `1px solid ${
                        trade.type === "BUY"
                          ? "rgba(0,255,136,0.3)"
                          : "rgba(239,68,68,0.3)"
                      }`,
                    }}
                  >
                    {trade.type === "BUY" ? "↑" : "↓"} {trade.type}
                  </span>
                </td>
                <td className="px-4 py-3 font-bold text-white">
                  {trade.ticker}
                </td>
                <td className="px-4 py-3 text-slate-300">{trade.shares}</td>
                <td className="px-4 py-3 text-slate-300">
                  {formatCurrency(trade.price)}
                </td>
                <td className="px-4 py-3 text-white font-medium">
                  {formatCurrency(trade.totalValue)}
                </td>
                <td className="px-4 py-3">
                  {trade.realizedPnL !== undefined ? (
                    <span
                      style={{ color: getReturnColor(trade.realizedPnL) }}
                      className="font-bold"
                    >
                      {formatCurrency(trade.realizedPnL)}
                    </span>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
};

const PerformanceTab: React.FC<{
  portfolio: AgentPortfolio;
  formatCurrency: (v: number) => string;
}> = ({ portfolio, formatCurrency }) => {
  if (portfolio.performanceHistory.length === 0) {
    return <EmptyState icon="📈" message="No performance data yet" />;
  }
  return (
    <div>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={portfolio.performanceHistory}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.06)"
          />
          <XAxis
            dataKey="timestamp"
            tickFormatter={(ts) =>
              new Date(ts).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })
            }
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
              backgroundColor: "#0d1117",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "8px",
              padding: "12px",
            }}
            labelStyle={{ color: "#94a3b8" }}
            formatter={(value: number) => [
              formatCurrency(value),
              "Portfolio Value",
            ]}
          />
          <Line
            type="monotone"
            dataKey="totalValue"
            name="Portfolio Value"
            stroke="#00f0ff"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, fill: "#00f0ff" }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        <MetricCard
          label="Sharpe Ratio"
          value={
            portfolio.sharpeRatio !== null
              ? portfolio.sharpeRatio.toFixed(2)
              : "N/A"
          }
        />
        <MetricCard
          label="Volatility"
          value={
            portfolio.volatility != null
              ? `${(portfolio.volatility * 100).toFixed(1)}%`
              : "N/A"
          }
        />
        <MetricCard
          label="Profit Factor"
          value={
            portfolio.profitFactor != null &&
            Number.isFinite(portfolio.profitFactor)
              ? portfolio.profitFactor.toFixed(2)
              : "N/A"
          }
        />
        <MetricCard
          label="Avg Win / Loss"
          value={
            portfolio.avgWin > 0 ? formatCurrency(portfolio.avgWin) : "N/A"
          }
          subValue={
            portfolio.avgLoss < 0 ? formatCurrency(portfolio.avgLoss) : "N/A"
          }
        />
      </div>
    </div>
  );
};

const MetricCard: React.FC<{
  label: string;
  value: string;
  subValue?: string;
  subColor?: string;
  valueColor?: string;
}> = ({ label, value, subValue, subColor, valueColor }) => (
  <div
    className="p-4 rounded-xl"
    style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.05)",
    }}
  >
    <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">
      {label}
    </div>
    <div
      className="text-xl font-black"
      style={{
        color: valueColor || "#fff",
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      {value}
    </div>
    {subValue && (
      <div className="text-xs mt-1" style={{ color: subColor || "#64748b" }}>
        {subValue}
      </div>
    )}
  </div>
);

const EmptyState: React.FC<{ icon: string; message: string }> = ({
  icon,
  message,
}) => (
  <div className="text-center py-16 text-slate-400">
    <div className="text-4xl mb-3 opacity-30">{icon}</div>
    <p className="text-sm">{message}</p>
  </div>
);

export default AgentPortfolioView;
