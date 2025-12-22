/**
 * Post-Analysis Trading View
 *
 * Shows trading decisions after debate tournament completes
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { InvestmentThesis, StockDebate } from "../../types/stock";
import { TradingSystemState, TradeDecision } from "../../types/trading";
import { tradingService } from "../../services/trading";
import { marketHoursService } from "../../services/trading";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  Clock,
} from "lucide-react";

interface PostAnalysisTradingViewProps {
  ticker: string;
  currentPrice: number;
  priceTimestamp: number;
  theses: InvestmentThesis[];
  debates: StockDebate[];
  onContinue: () => void;
  onViewPortfolios?: () => void;
}

export const PostAnalysisTradingView: React.FC<
  PostAnalysisTradingViewProps
> = ({
  ticker,
  currentPrice,
  priceTimestamp,
  theses,
  debates,
  onContinue,
  onViewPortfolios,
}) => {
  const [tradingState, setTradingState] = useState<TradingSystemState | null>(
    null
  );
  const [decisions, setDecisions] = useState<Map<string, TradeDecision>>(
    new Map()
  );
  const [isExecuting, setIsExecuting] = useState(false);
  const [executedTrades, setExecutedTrades] = useState<Set<string>>(new Set());
  const [executionProgress, setExecutionProgress] = useState({
    current: 0,
    total: 0,
  });
  const [showConfirmation, setShowConfirmation] = useState(false);

  // Ref to track if component is mounted for async cleanup
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const loadAndAnalyze = async () => {
      try {
        if (!isMountedRef.current) return;

        let state = tradingService.loadTradingState();
        if (!state) {
          state = tradingService.initializeTradingSystem();
        }

        if (!isMountedRef.current) return;
        setTradingState(state);

        // Generate trade decisions for each agent
        const newDecisions = new Map<string, TradeDecision>();

        for (const thesis of theses) {
          if (!isMountedRef.current) return;

          const portfolio = state.portfolios[thesis.agentId];
          if (!portfolio) continue;

          // Find relevant debate
          const debate = debates.find(
            (d) =>
              d.bullThesis.agentId === thesis.agentId ||
              d.bearThesis.agentId === thesis.agentId
          );

          if (!debate) continue;

          try {
            const decision = await tradingService.determineTradeDecision(
              thesis,
              debate,
              portfolio,
              currentPrice,
              priceTimestamp
            );

            if (!isMountedRef.current) return;
            newDecisions.set(thesis.agentId, decision);
          } catch {
            // Failed to determine trade decision - skip this agent
          }
        }

        if (isMountedRef.current) {
          setDecisions(newDecisions);
        }
      } catch {
        // Failed to generate trading decisions - state will remain empty
      }
    };

    loadAndAnalyze();
  }, [ticker, currentPrice, priceTimestamp, theses, debates]);

  const executeAllTrades = useCallback(async () => {
    if (!tradingState) return;

    setIsExecuting(true);
    const newExecuted = new Set<string>();
    const tradesToExecute = Array.from(decisions.entries()).filter(
      ([, decision]) => decision.action !== "HOLD" && decision.isValid
    );

    setExecutionProgress({ current: 0, total: tradesToExecute.length });

    for (let i = 0; i < tradesToExecute.length; i++) {
      // Check if component is still mounted before continuing
      if (!isMountedRef.current) return;

      const [agentId, decision] = tradesToExecute[i];

      // Reload fresh state for each trade to avoid race conditions
      const freshState = tradingService.loadTradingState();
      if (!freshState) continue;

      const portfolio = freshState.portfolios[agentId];
      if (!portfolio) continue;

      try {
        const trade = await tradingService.executeTrade(
          portfolio,
          decision,
          freshState
        );
        if (trade) {
          newExecuted.add(agentId);
        }
      } catch {
        // Trade execution failed - silently continue to next trade
      }

      if (!isMountedRef.current) return;
      setExecutionProgress({ current: i + 1, total: tradesToExecute.length });
    }

    if (!isMountedRef.current) return;

    setExecutedTrades(newExecuted);
    setIsExecuting(false);
    setShowConfirmation(false);

    // Reload state to show updated portfolios
    const updatedState = tradingService.loadTradingState();
    if (updatedState) {
      setTradingState(updatedState);
    }
  }, [tradingState, decisions]);

  const marketStatus = marketHoursService.getMarketStatus();

  const getMethodologyEmoji = useCallback((methodology: string) => {
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
  }, []);

  const formatCurrency = useCallback((value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }, []);

  const buyDecisions = useMemo(
    () =>
      Array.from(decisions.values()).filter(
        (d) => d.action === "BUY" && d.isValid
      ),
    [decisions]
  );
  const sellDecisions = useMemo(
    () =>
      Array.from(decisions.values()).filter(
        (d) => d.action === "SELL" && d.isValid
      ),
    [decisions]
  );
  const holdDecisions = useMemo(
    () =>
      Array.from(decisions.values()).filter(
        (d) => d.action === "HOLD" || !d.isValid
      ),
    [decisions]
  );

  const hasExecutableTrades = useMemo(
    () => buyDecisions.length > 0 || sellDecisions.length > 0,
    [buyDecisions, sellDecisions]
  );

  if (!tradingState) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="mb-6">
        <h2
          id="trading-modal-title"
          className="text-2xl font-bold text-gray-900 mb-2"
        >
          ⚔️ Debate Complete - Trading Decisions
        </h2>
        <p className="text-gray-600">
          Analysis complete for <span className="font-semibold">{ticker}</span>{" "}
          at {formatCurrency(currentPrice)}
        </p>
      </div>

      {/* Execution Progress */}
      {isExecuting && (
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-blue-800">
              Executing Trades...
            </span>
            <span className="text-sm text-blue-600">
              {executionProgress.current} of {executionProgress.total}
            </span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{
                width: `${
                  executionProgress.total > 0
                    ? (executionProgress.current / executionProgress.total) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {showConfirmation && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-start">
            <AlertCircle className="w-5 h-5 text-yellow-600 mr-3 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-800 mb-2">
                Confirm Trade Execution
              </p>
              <p className="text-sm text-yellow-700 mb-3">
                You are about to execute{" "}
                {buyDecisions.length + sellDecisions.length} trades with an
                estimated total value of $
                {(
                  buyDecisions.reduce((sum, d) => sum + d.estimatedValue, 0) +
                  sellDecisions.reduce((sum, d) => sum + d.estimatedValue, 0)
                ).toLocaleString()}
                . This action cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={executeAllTrades}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium text-sm"
                >
                  Confirm & Execute
                </button>
                <button
                  onClick={() => setShowConfirmation(false)}
                  className="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-medium text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Market Status Warning */}
      {!marketStatus.isOpen && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg flex items-start">
          <Clock className="w-5 h-5 text-yellow-600 mr-3 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-800">Market Closed</p>
            <p className="text-sm text-yellow-700 mt-1">
              {marketHoursService.getMarketStatusMessage(marketStatus)}
            </p>
            <p className="text-xs text-yellow-600 mt-1">
              Trades will be queued as pending orders and executed when market
              opens.
            </p>
          </div>
        </div>
      )}

      {/* Trading Actions Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-green-50 rounded-lg p-4 border border-green-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-green-800">
              Buy Orders
            </span>
            <TrendingUp className="w-5 h-5 text-green-600" />
          </div>
          <div className="text-2xl font-bold text-green-900">
            {buyDecisions.length}
          </div>
        </div>
        <div className="bg-red-50 rounded-lg p-4 border border-red-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-red-800">
              Sell Orders
            </span>
            <TrendingDown className="w-5 h-5 text-red-600" />
          </div>
          <div className="text-2xl font-bold text-red-900">
            {sellDecisions.length}
          </div>
        </div>
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-800">Hold/Skip</span>
            <Minus className="w-5 h-5 text-gray-600" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {holdDecisions.length}
          </div>
        </div>
      </div>

      {/* Trading Decisions Table */}
      <div className="mb-6 overflow-hidden border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Agent
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Action
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Shares
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Value
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Confidence
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Reasoning
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {Array.from(decisions.entries()).map(([agentId, decision]) => {
              const portfolio = tradingState?.portfolios[agentId];
              if (!portfolio) return null;
              const isExecuted = executedTrades.has(agentId);

              return (
                <tr key={agentId} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center">
                      <span className="text-lg mr-2">
                        {getMethodologyEmoji(portfolio.methodology)}
                      </span>
                      <span className="text-sm font-medium text-gray-900">
                        {portfolio.agentName}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        decision.action === "BUY"
                          ? "bg-green-100 text-green-800"
                          : decision.action === "SELL"
                          ? "bg-red-100 text-red-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {decision.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {decision.shares > 0 ? decision.shares : "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {decision.estimatedValue > 0
                      ? formatCurrency(decision.estimatedValue)
                      : "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {decision.confidence.toFixed(0)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
                    {decision.reasoning[0] || "No reasoning provided"}
                  </td>
                  <td className="px-4 py-3">
                    {isExecuted ? (
                      <span className="text-green-600 text-sm font-medium">
                        ✓ Executed
                      </span>
                    ) : decision.isValid && decision.action !== "HOLD" ? (
                      <span className="text-blue-600 text-sm font-medium">
                        Pending
                      </span>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Warnings */}
      {Array.from(decisions.values()).some((d) => d.warnings.length > 0) && (
        <div className="mb-6 p-4 bg-orange-50 border border-orange-200 rounded-lg">
          <div className="flex items-start">
            <AlertCircle className="w-5 h-5 text-orange-600 mr-3 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-orange-800 mb-2">
                Warnings
              </p>
              <ul className="text-sm text-orange-700 space-y-1">
                {Array.from(decisions.values())
                  .flatMap((d) => d.warnings)
                  .map((warning, i) => (
                    <li key={i}>• {warning}</li>
                  ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-6 border-t border-gray-200">
        <button
          onClick={() => {
            if (onViewPortfolios) {
              onViewPortfolios();
            } else {
              onContinue();
            }
          }}
          className="px-4 py-2 text-blue-600 hover:text-blue-700 font-medium transition-colors"
        >
          View All Portfolios
        </button>
        <div className="flex gap-3">
          <button
            onClick={onContinue}
            className="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-medium"
          >
            Skip Trading
          </button>
          <button
            onClick={() => setShowConfirmation(true)}
            disabled={
              isExecuting ||
              executedTrades.size > 0 ||
              showConfirmation ||
              !hasExecutableTrades
            }
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              isExecuting ||
              executedTrades.size > 0 ||
              showConfirmation ||
              !hasExecutableTrades
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-blue-500 text-white hover:bg-blue-600"
            }`}
          >
            {isExecuting
              ? "Executing..."
              : executedTrades.size > 0
              ? "Trades Executed"
              : !hasExecutableTrades
              ? "No Trades Available"
              : "Execute Trades"}
          </button>
        </div>
      </div>
    </div>
  );
};
