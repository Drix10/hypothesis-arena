/**
 * Agent Portfolio View
 *
 * Detailed view of a single agent's portfolio with positions, trades, and performance
 */

import React, { useState } from "react";
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
import { TrendingUp, TrendingDown, ArrowLeft } from "lucide-react";

interface AgentPortfolioViewProps {
  portfolio: AgentPortfolio;
  onBack: () => void;
}

export const AgentPortfolioView: React.FC<AgentPortfolioViewProps> = ({
  portfolio,
  onBack,
}) => {
  const [selectedTab, setSelectedTab] = useState<
    "positions" | "trades" | "performance"
  >("positions");

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
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${(value * 100).toFixed(2)}%`;
  };

  const formatDateTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const getStatusColor = (status: string) => {
    if (status === "active") return "text-green-600";
    if (status === "paused") return "text-yellow-600";
    return "text-red-600";
  };

  const getStatusBadge = (status: string) => {
    if (status === "active") return "✓ Active";
    if (status === "paused") return "⏸ Paused";
    return "⚠ Liquidated";
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={onBack}
            className="flex items-center text-blue-600 hover:text-blue-700 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </button>

          <div className="bg-white rounded-lg shadow-lg p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <span className="text-6xl mr-4">
                  {getMethodologyEmoji(portfolio.methodology)}
                </span>
                <div>
                  <h1 className="text-3xl font-bold text-gray-900">
                    {portfolio.agentName}
                  </h1>
                  <p className="text-gray-600 capitalize">
                    {portfolio.methodology} Investor
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div
                  className={`text-sm font-medium ${getStatusColor(
                    portfolio.status
                  )}`}
                >
                  {getStatusBadge(portfolio.status)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Last trade:{" "}
                  {portfolio.lastTradeAt
                    ? formatDateTime(portfolio.lastTradeAt)
                    : "Never"}
                </div>
              </div>
            </div>

            {/* Key Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-gray-600 mb-1">Total Value</div>
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(portfolio.totalValue)}
                </div>
                <div
                  className={`text-sm font-medium ${
                    portfolio.totalReturn >= 0
                      ? "text-green-600"
                      : "text-red-600"
                  }`}
                >
                  {formatPercent(portfolio.totalReturn)}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-gray-600 mb-1">Cash</div>
                <div className="text-2xl font-bold text-gray-900">
                  {formatCurrency(portfolio.currentCash)}
                </div>
                <div className="text-xs text-gray-500">
                  {portfolio.totalValue > 0
                    ? `${(
                        (portfolio.currentCash / portfolio.totalValue) *
                        100
                      ).toFixed(1)}%`
                    : "0%"}{" "}
                  of portfolio
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-gray-600 mb-1">Win Rate</div>
                <div className="text-2xl font-bold text-gray-900">
                  {portfolio.totalTrades > 0
                    ? `${(portfolio.winRate * 100).toFixed(1)}%`
                    : "N/A"}
                </div>
                <div className="text-xs text-gray-500">
                  {portfolio.winningTrades}W / {portfolio.losingTrades}L
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm text-gray-600 mb-1">Max Drawdown</div>
                <div className="text-2xl font-bold text-red-600">
                  {portfolio.maxDrawdown > 0
                    ? `-${(portfolio.maxDrawdown * 100).toFixed(1)}%`
                    : "0%"}
                </div>
                <div className="text-xs text-gray-500">
                  Current:{" "}
                  {portfolio.currentDrawdown > 0
                    ? `-${(portfolio.currentDrawdown * 100).toFixed(1)}%`
                    : "0%"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="border-b border-gray-200">
            <div className="flex">
              <button
                onClick={() => setSelectedTab("positions")}
                className={`px-6 py-3 font-medium transition-colors ${
                  selectedTab === "positions"
                    ? "text-blue-600 border-b-2 border-blue-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Positions ({portfolio.positions.length})
              </button>
              <button
                onClick={() => setSelectedTab("trades")}
                className={`px-6 py-3 font-medium transition-colors ${
                  selectedTab === "trades"
                    ? "text-blue-600 border-b-2 border-blue-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Trade History ({portfolio.trades.length})
              </button>
              <button
                onClick={() => setSelectedTab("performance")}
                className={`px-6 py-3 font-medium transition-colors ${
                  selectedTab === "performance"
                    ? "text-blue-600 border-b-2 border-blue-600"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Performance
              </button>
            </div>
          </div>

          <div className="p-6">
            {/* Positions Tab */}
            {selectedTab === "positions" && (
              <div>
                {portfolio.positions.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Ticker
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Shares
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Avg Cost
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Current Price
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Market Value
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Unrealized P&L
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            % of Portfolio
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {portfolio.positions.map((position) => (
                          <tr
                            key={position.ticker}
                            className="hover:bg-gray-50"
                          >
                            <td className="px-4 py-3 font-semibold text-gray-900">
                              {position.ticker}
                            </td>
                            <td className="px-4 py-3 text-gray-900">
                              {position.shares}
                            </td>
                            <td className="px-4 py-3 text-gray-900">
                              {formatCurrency(position.avgCostBasis)}
                            </td>
                            <td className="px-4 py-3 text-gray-900">
                              {formatCurrency(position.currentPrice)}
                            </td>
                            <td className="px-4 py-3 font-medium text-gray-900">
                              {formatCurrency(position.marketValue)}
                            </td>
                            <td
                              className={`px-4 py-3 font-semibold ${
                                position.unrealizedPnL >= 0
                                  ? "text-green-600"
                                  : "text-red-600"
                              }`}
                            >
                              {position.unrealizedPnL >= 0 ? "+" : ""}
                              {formatCurrency(position.unrealizedPnL)}
                              <div className="text-xs">
                                ({formatPercent(position.unrealizedPnLPercent)})
                              </div>
                            </td>
                            <td className="px-4 py-3 text-gray-900">
                              {portfolio.totalValue > 0
                                ? `${(
                                    (position.marketValue /
                                      portfolio.totalValue) *
                                    100
                                  ).toFixed(1)}%`
                                : "0%"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>No open positions</p>
                  </div>
                )}
              </div>
            )}

            {/* Trades Tab */}
            {selectedTab === "trades" && (
              <div>
                {portfolio.trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Date
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Type
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Ticker
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Shares
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Price
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Total
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            P&L
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {portfolio.trades
                          .slice()
                          .reverse()
                          .map((trade) => (
                            <tr key={trade.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {formatDateTime(trade.timestamp)}
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                    trade.type === "BUY"
                                      ? "bg-green-100 text-green-800"
                                      : "bg-red-100 text-red-800"
                                  }`}
                                >
                                  {trade.type === "BUY" ? (
                                    <TrendingUp className="w-3 h-3 mr-1" />
                                  ) : (
                                    <TrendingDown className="w-3 h-3 mr-1" />
                                  )}
                                  {trade.type}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-semibold text-gray-900">
                                {trade.ticker}
                              </td>
                              <td className="px-4 py-3 text-gray-900">
                                {trade.shares}
                              </td>
                              <td className="px-4 py-3 text-gray-900">
                                {formatCurrency(trade.price)}
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-900">
                                {formatCurrency(trade.totalValue)}
                              </td>
                              <td className="px-4 py-3">
                                {trade.realizedPnL !== undefined ? (
                                  <span
                                    className={`font-semibold ${
                                      trade.realizedPnL >= 0
                                        ? "text-green-600"
                                        : "text-red-600"
                                    }`}
                                  >
                                    {trade.realizedPnL >= 0 ? "+" : ""}
                                    {formatCurrency(trade.realizedPnL)}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">-</span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>No trades yet</p>
                  </div>
                )}
              </div>
            )}

            {/* Performance Tab */}
            {selectedTab === "performance" && (
              <div>
                {portfolio.performanceHistory.length > 0 ? (
                  <div>
                    <ResponsiveContainer width="100%" height={400}>
                      <LineChart data={portfolio.performanceHistory}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis
                          dataKey="timestamp"
                          tickFormatter={(ts) =>
                            new Date(ts).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })
                          }
                          stroke="#6b7280"
                          style={{ fontSize: "12px" }}
                        />
                        <YAxis
                          stroke="#6b7280"
                          style={{ fontSize: "12px" }}
                          tickFormatter={formatCurrency}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "white",
                            border: "1px solid #e5e7eb",
                            borderRadius: "8px",
                            padding: "12px",
                          }}
                          formatter={(value: number) => formatCurrency(value)}
                        />
                        <Line
                          type="monotone"
                          dataKey="totalValue"
                          name="Portfolio Value"
                          stroke="#3B82F6"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>

                    {/* Performance Stats */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600 mb-1">
                          Sharpe Ratio
                        </div>
                        <div className="text-xl font-bold text-gray-900">
                          {portfolio.sharpeRatio !== null
                            ? portfolio.sharpeRatio.toFixed(2)
                            : "N/A"}
                        </div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600 mb-1">
                          Volatility
                        </div>
                        <div className="text-xl font-bold text-gray-900">
                          {portfolio.performanceHistory.length >= 2 &&
                          portfolio.volatility !== null &&
                          portfolio.volatility !== undefined
                            ? `${(portfolio.volatility * 100).toFixed(1)}%`
                            : "N/A"}
                        </div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600 mb-1">
                          Profit Factor
                        </div>
                        <div className="text-xl font-bold text-gray-900">
                          {portfolio.totalTrades > 0 &&
                          portfolio.profitFactor !== null &&
                          portfolio.profitFactor !== undefined &&
                          Number.isFinite(portfolio.profitFactor)
                            ? portfolio.profitFactor.toFixed(2)
                            : "N/A"}
                        </div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600 mb-1">
                          Avg Win / Loss
                        </div>
                        <div className="text-xl font-bold text-gray-900">
                          {portfolio.avgWin > 0
                            ? formatCurrency(portfolio.avgWin)
                            : "N/A"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {portfolio.avgLoss < 0
                            ? formatCurrency(portfolio.avgLoss)
                            : "N/A"}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <p>No performance data yet</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
