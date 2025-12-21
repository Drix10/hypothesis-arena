/**
 * Accuracy Tracker Component - Premium Dashboard
 * Shows 8 AI agents' trading performance + prediction accuracy
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  HistoricalAccuracy,
  getAccuracyHistory,
  getAccuracyStats,
  getPendingVerifications,
  updateAccuracyCheck,
} from "../../services/storageService";
import { getQuote } from "../../services/data/yahooFinance";
import { tradingService } from "../../services/trading";
import { AgentPortfolio } from "../../types/trading";
import { ANALYST_PROFILES } from "../../constants/analystPrompts";
import { AnalystMethodology } from "../../types/stock";

const VERIFICATION_DAYS = 3;

// Get emoji icon for an agent based on their methodology
const getAgentIcon = (
  methodology: AnalystMethodology | string | undefined
): string => {
  if (!methodology) return "🤖";
  const profile = ANALYST_PROFILES[methodology as AnalystMethodology];
  return profile?.avatarEmoji || "🤖";
};

// Get agent display name
const getAgentName = (portfolio: AgentPortfolio): string => {
  if (portfolio.agentName) return portfolio.agentName;
  if (portfolio.methodology) {
    const profile =
      ANALYST_PROFILES[portfolio.methodology as AnalystMethodology];
    return profile?.name || "Agent";
  }
  return "Agent";
};

export const AccuracyTracker: React.FC = () => {
  const [history, setHistory] = useState<HistoricalAccuracy[]>([]);
  const [stats, setStats] = useState({ total: 0, accurate: 0, rate: 0 });
  const [portfolios, setPortfolios] = useState<AgentPortfolio[]>([]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyingTicker, setVerifyingTicker] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const isVerifyingRef = useRef(false);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshData = useCallback(() => {
    setHistory(getAccuracyHistory());
    setStats(getAccuracyStats());
    const state = tradingService.loadTradingState();
    if (state?.portfolios) {
      const sorted = Object.values(state.portfolios).sort(
        (a, b) => b.totalReturn - a.totalReturn
      );
      setPortfolios(sorted);
    }
  }, []);

  const verifyRecord = useCallback(
    async (record: HistoricalAccuracy): Promise<boolean> => {
      try {
        setVerifyingTicker(record.ticker);
        const quote = await getQuote(record.ticker);
        if (quote?.price > 0)
          return updateAccuracyCheck(record.id, quote.price);
      } catch (error) {
        console.warn(`Failed to verify ${record.ticker}:`, error);
      } finally {
        setVerifyingTicker(null);
      }
      return false;
    },
    []
  );

  const autoVerifyPredictions = useCallback(async () => {
    if (isVerifyingRef.current) return;
    const pending = getPendingVerifications(VERIFICATION_DAYS);
    if (pending.length === 0) return;
    isVerifyingRef.current = true;
    setIsVerifying(true);
    let verified = 0;
    for (const record of pending) {
      const success = await verifyRecord(record);
      if (success) verified++;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (verified > 0) {
      setVerifyMessage(`${verified} verified`);
      refreshData();
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(
        () => setVerifyMessage(null),
        3000
      );
    }
    isVerifyingRef.current = false;
    setIsVerifying(false);
  }, [refreshData, verifyRecord]);

  const handleManualVerify = useCallback(async () => {
    if (isVerifyingRef.current) return;
    const allPending = history.filter((h) => h.wasAccurate === undefined);
    if (allPending.length === 0) return;
    isVerifyingRef.current = true;
    setIsVerifying(true);
    let verified = 0;
    for (const record of allPending) {
      const success = await verifyRecord(record);
      if (success) verified++;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    setVerifyMessage(verified > 0 ? `${verified} verified` : "API unavailable");
    refreshData();
    if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = setTimeout(() => setVerifyMessage(null), 3000);
    isVerifyingRef.current = false;
    setIsVerifying(false);
  }, [history, refreshData, verifyRecord]);

  useEffect(() => {
    refreshData();
    if (!isVerifyingRef.current) autoVerifyPredictions();
    return () => {
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    };
  }, [refreshData, autoVerifyPredictions]);

  const getDaysLeft = (date: number) =>
    Math.max(
      0,
      Math.ceil((date + VERIFICATION_DAYS * 86400000 - Date.now()) / 86400000)
    );
  const fmtPrice = (p: number) =>
    p >= 1000 ? `$${p.toFixed(0)}` : `$${p.toFixed(2)}`;
  const fmtMoney = (v: number) =>
    v >= 1e6
      ? `$${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}K`
      : `$${v.toFixed(0)}`;
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

  const checked = history.filter((h) => h.wasAccurate !== undefined);
  const pending = history.filter((h) => h.wasAccurate === undefined);
  const totalAUM = portfolios.reduce((s, p) => s + p.totalValue, 0);
  const avgReturn = portfolios.length
    ? portfolios.reduce((s, p) => s + p.totalReturn, 0) / portfolios.length
    : 0;
  const totalTrades = portfolios.reduce((s, p) => s + p.totalTrades, 0);
  const avgWinRate = portfolios.length
    ? portfolios.reduce((s, p) => s + p.winRate, 0) / portfolios.length
    : 0;

  if (history.length === 0 && portfolios.length === 0) return null;

  return (
    <motion.div
      className="rounded-2xl overflow-hidden"
      style={{
        background:
          "linear-gradient(145deg, rgba(15, 23, 42, 0.95) 0%, rgba(10, 18, 35, 0.98) 100%)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow:
          "0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* Agent Portfolios */}
      {portfolios.length > 0 && (
        <div className="p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(245, 184, 0, 0.2) 0%, rgba(245, 184, 0, 0.05) 100%)",
                  border: "1px solid rgba(245, 184, 0, 0.3)",
                }}
              >
                <span className="text-xl">🏆</span>
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  AI Portfolios
                </h3>
                <p className="text-xs text-slate-500">8 agents • $100K each</p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-white">
                {fmtMoney(totalAUM)}
              </div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                Total AUM
              </div>
            </div>
          </div>

          {/* Agent Grid */}
          <div className="grid grid-cols-4 gap-2.5 mb-5">
            {portfolios.slice(0, 8).map((p, i) => {
              const isTop3 = i < 3;
              const isPositive = p.totalReturn >= 0;
              const icon = getAgentIcon(p.methodology);
              const name = getAgentName(p);

              return (
                <motion.div
                  key={p.agentId}
                  className="relative p-3 rounded-xl text-center transition-all cursor-default group"
                  style={{
                    background: isTop3
                      ? "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)"
                      : "rgba(255,255,255,0.02)",
                    border: isTop3
                      ? "1px solid rgba(255,255,255,0.12)"
                      : "1px solid rgba(255,255,255,0.04)",
                  }}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  whileHover={{
                    scale: 1.03,
                    boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
                  }}
                >
                  {/* Rank badge */}
                  {isTop3 && (
                    <div
                      className="absolute -top-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shadow-lg"
                      style={{
                        background:
                          i === 0
                            ? "linear-gradient(135deg, #FFD700 0%, #FFA500 100%)"
                            : i === 1
                            ? "linear-gradient(135deg, #E8E8E8 0%, #B8B8B8 100%)"
                            : "linear-gradient(135deg, #CD7F32 0%, #8B4513 100%)",
                        color:
                          i === 0 ? "#1a1a2e" : i === 1 ? "#1a1a2e" : "#fff",
                      }}
                    >
                      {i + 1}
                    </div>
                  )}

                  <div className="text-2xl mb-1.5 transform group-hover:scale-110 transition-transform">
                    {icon}
                  </div>
                  <div className="text-[11px] text-slate-300 font-medium truncate mb-2">
                    {name}
                  </div>
                  <div
                    className={`text-sm font-bold ${
                      isPositive ? "text-bull-light" : "text-bear-light"
                    }`}
                    style={{
                      textShadow: isPositive
                        ? "0 0 10px rgba(34,197,94,0.3)"
                        : "0 0 10px rgba(239,68,68,0.3)",
                    }}
                  >
                    {fmtPct(p.totalReturn)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {fmtMoney(p.totalValue)}
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Stats Bar */}
          <div
            className="flex items-center justify-between p-3 rounded-xl"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <div className="text-center flex-1">
              <div
                className={`text-base font-bold ${
                  avgReturn >= 0 ? "text-bull-light" : "text-bear-light"
                }`}
              >
                {fmtPct(avgReturn)}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Avg Return
              </div>
            </div>
            <div className="w-px h-10 bg-white/[0.08]" />
            <div className="text-center flex-1">
              <div className="text-base font-bold text-white">
                {totalTrades}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Trades
              </div>
            </div>
            <div className="w-px h-10 bg-white/[0.08]" />
            <div className="text-center flex-1">
              <div className="text-base font-bold text-gold">
                {(avgWinRate * 100).toFixed(0)}%
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Win Rate
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Predictions Section */}
      {history.length > 0 && (
        <div
          className={`p-5 ${
            portfolios.length > 0 ? "border-t border-white/[0.06]" : ""
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(6, 182, 212, 0.2) 0%, rgba(6, 182, 212, 0.05) 100%)",
                  border: "1px solid rgba(6, 182, 212, 0.3)",
                }}
              >
                <span className="text-xl">🎯</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">
                    Predictions
                  </h3>
                  {stats.total > 0 && (
                    <span
                      className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                        stats.rate >= 60
                          ? "bg-bull/20 text-bull-light"
                          : stats.rate >= 40
                          ? "bg-gold/20 text-gold"
                          : "bg-bear/20 text-bear-light"
                      }`}
                    >
                      {stats.rate.toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  {stats.total} verified • {pending.length} pending
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AnimatePresence>
                {verifyMessage && (
                  <motion.span
                    className="text-xs text-bull-light bg-bull/10 px-2.5 py-1.5 rounded-lg"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                  >
                    ✓ {verifyMessage}
                  </motion.span>
                )}
              </AnimatePresence>
              {pending.length > 0 && (
                <motion.button
                  onClick={handleManualVerify}
                  disabled={isVerifying}
                  className="text-xs font-semibold px-3 py-2 rounded-lg transition-all disabled:opacity-50"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(6, 182, 212, 0.15) 0%, rgba(6, 182, 212, 0.05) 100%)",
                    border: "1px solid rgba(6, 182, 212, 0.3)",
                    color: "#22d3ee",
                  }}
                  whileHover={{
                    scale: 1.02,
                    boxShadow: "0 0 20px rgba(6, 182, 212, 0.2)",
                  }}
                  whileTap={{ scale: 0.98 }}
                >
                  {isVerifying ? "Checking..." : "Verify Now"}
                </motion.button>
              )}
            </div>
          </div>

          {/* Results List */}
          <div className="space-y-2.5">
            {/* Verified */}
            {checked.slice(0, 3).map((r) => {
              const change =
                r.priceAtCheck && r.priceAtAnalysis > 0
                  ? ((r.priceAtCheck - r.priceAtAnalysis) / r.priceAtAnalysis) *
                    100
                  : 0;
              return (
                <motion.div
                  key={r.id}
                  className="flex items-center gap-3 p-3 rounded-xl transition-all"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                  whileHover={{ x: 3, background: "rgba(255,255,255,0.04)" }}
                >
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center text-base font-bold ${
                      r.wasAccurate
                        ? "bg-bull/15 text-bull-light"
                        : "bg-bear/15 text-bear-light"
                    }`}
                  >
                    {r.wasAccurate ? "✓" : "✗"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold">
                        {r.ticker}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          r.recommendation.includes("buy")
                            ? "bg-bull/15 text-bull-light"
                            : r.recommendation.includes("sell")
                            ? "bg-bear/15 text-bear-light"
                            : "bg-gold/15 text-gold"
                        }`}
                      >
                        {r.recommendation.replace("_", " ").toUpperCase()}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {fmtPrice(r.priceAtAnalysis)} →{" "}
                      {r.priceAtCheck ? fmtPrice(r.priceAtCheck) : "—"}
                    </div>
                  </div>
                  <div
                    className={`text-base font-bold ${
                      change >= 0 ? "text-bull-light" : "text-bear-light"
                    }`}
                  >
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(1)}%
                  </div>
                </motion.div>
              );
            })}

            {/* Pending */}
            {pending.slice(0, 2).map((r) => {
              const days = getDaysLeft(r.analysisDate);
              const isChecking = verifyingTicker === r.ticker;
              const targetPct =
                r.priceAtAnalysis > 0
                  ? ((r.targetPrice - r.priceAtAnalysis) / r.priceAtAnalysis) *
                    100
                  : 0;
              return (
                <motion.div
                  key={r.id}
                  className="flex items-center gap-3 p-3 rounded-xl"
                  style={{
                    background: "rgba(255,255,255,0.01)",
                    border: "1px dashed rgba(255,255,255,0.08)",
                  }}
                  whileHover={{ x: 3 }}
                >
                  <div className="w-9 h-9 rounded-lg bg-gold/10 flex items-center justify-center text-base">
                    {isChecking ? "⏳" : "📊"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold">
                        {r.ticker}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          r.recommendation.includes("buy")
                            ? "bg-bull/15 text-bull-light"
                            : r.recommendation.includes("sell")
                            ? "bg-bear/15 text-bear-light"
                            : "bg-gold/15 text-gold"
                        }`}
                      >
                        {r.recommendation.replace("_", " ").toUpperCase()}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Target: {fmtPrice(r.targetPrice)}
                      <span
                        className={
                          targetPct >= 0 ? "text-bull-light" : "text-bear-light"
                        }
                      >
                        {" "}
                        ({targetPct >= 0 ? "+" : ""}
                        {targetPct.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  <div
                    className="text-[11px] text-slate-400 px-2.5 py-1.5 rounded-lg"
                    style={{ background: "rgba(255,255,255,0.04)" }}
                  >
                    {isChecking ? "..." : days > 0 ? `${days}d left` : "Ready"}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div
        className="px-5 py-3 border-t border-white/[0.05]"
        style={{ background: "rgba(255,255,255,0.01)" }}
      >
        <p className="text-[10px] text-slate-500 text-center">
          Verifies predictions after {VERIFICATION_DAYS} days • Uses live market
          data
        </p>
      </div>
    </motion.div>
  );
};

export default AccuracyTracker;
