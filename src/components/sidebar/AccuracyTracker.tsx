/**
 * Accuracy Tracker Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
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
import {
  ANALYST_PROFILES,
  getAllAnalysts,
} from "../../constants/analystPrompts";
import { AnalystMethodology } from "../../types/stock";

const VERIFICATION_DAYS = 3;
const TOTAL_AGENTS = getAllAnalysts().length;

/** Color configuration for recommendation badges */
interface RecBadgeColorConfig {
  bg: string;
  border: string;
  color: string;
}

export const RECOMMENDATION_COLOR_CONFIG: Record<string, RecBadgeColorConfig> =
  {
    strong_buy: {
      bg: "rgba(0,255,136,0.12)",
      border: "rgba(0,255,136,0.3)",
      color: "#00ff88",
    },
    buy: {
      bg: "rgba(34,197,94,0.12)",
      border: "rgba(34,197,94,0.3)",
      color: "#22c55e",
    },
    hold: {
      bg: "rgba(255,215,0,0.12)",
      border: "rgba(255,215,0,0.3)",
      color: "#ffd700",
    },
    sell: {
      bg: "rgba(239,68,68,0.12)",
      border: "rgba(239,68,68,0.3)",
      color: "#ef4444",
    },
    strong_sell: {
      bg: "rgba(220,38,38,0.12)",
      border: "rgba(220,38,38,0.3)",
      color: "#dc2626",
    },
  };

const getAgentIcon = (
  methodology: AnalystMethodology | string | undefined
): string => {
  if (!methodology) return "🤖";
  const profile = ANALYST_PROFILES[methodology as AnalystMethodology];
  return profile?.avatarEmoji || "🤖";
};

const getAgentName = (portfolio: AgentPortfolio): string => {
  if (portfolio.agentName) return portfolio.agentName;
  if (portfolio.methodology) {
    const profile =
      ANALYST_PROFILES[portfolio.methodology as AnalystMethodology];
    return profile?.name || "Agent";
  }
  return "Agent";
};

// Helper components defined before main component
const StatItem: React.FC<{ label: string; value: string; color: string }> = ({
  label,
  value,
  color,
}) => (
  <div className="text-center flex-1">
    <div
      className="text-base font-black"
      style={{ color, fontFamily: "'Space Grotesk', sans-serif" }}
    >
      {value}
    </div>
    <div className="text-[9px] text-slate-500 uppercase tracking-widest">
      {label}
    </div>
  </div>
);

const RecBadge: React.FC<{ rec: string }> = ({ rec }) => {
  const c =
    RECOMMENDATION_COLOR_CONFIG[rec] || RECOMMENDATION_COLOR_CONFIG.hold;
  return (
    <span
      className="px-1.5 py-0.5 text-[9px] rounded font-black uppercase tracking-wider"
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.color,
      }}
    >
      {rec.replace("_", " ")}
    </span>
  );
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
  const isMountedRef = useRef(true);

  const refreshData = useCallback(() => {
    if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return false;
      try {
        setVerifyingTicker(record.ticker);
        const quote = await getQuote(record.ticker);
        if (!isMountedRef.current) return false;
        if (quote?.price > 0)
          return updateAccuracyCheck(record.id, quote.price);
      } catch {
        // Silently fail - verification will be retried later
      } finally {
        if (isMountedRef.current) setVerifyingTicker(null);
      }
      return false;
    },
    []
  );

  const autoVerifyPredictions = useCallback(async () => {
    if (isVerifyingRef.current || !isMountedRef.current) return;
    const pending = getPendingVerifications(VERIFICATION_DAYS);
    if (pending.length === 0) return;
    isVerifyingRef.current = true;
    setIsVerifying(true);
    let verified = 0;
    for (const record of pending) {
      if (!isMountedRef.current) break;
      const success = await verifyRecord(record);
      if (success) verified++;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!isMountedRef.current) return;
    if (verified > 0) {
      setVerifyMessage(`${verified} verified`);
      refreshData();
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) setVerifyMessage(null);
      }, 3000);
    }
    isVerifyingRef.current = false;
    setIsVerifying(false);
  }, [refreshData, verifyRecord]);

  const handleManualVerify = useCallback(async () => {
    if (!isMountedRef.current) return;
    // Silently return if verification already in progress
    if (isVerifyingRef.current) return;

    const freshHistory = getAccuracyHistory();
    const allPending = freshHistory.filter((h) => h.wasAccurate === undefined);
    if (allPending.length === 0) return;
    isVerifyingRef.current = true;
    setIsVerifying(true);
    let verified = 0;
    for (const record of allPending) {
      if (!isMountedRef.current) break;
      const success = await verifyRecord(record);
      if (success) verified++;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!isMountedRef.current) return;
    setVerifyMessage(verified > 0 ? `${verified} verified` : "API unavailable");
    refreshData();
    if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) setVerifyMessage(null);
    }, 3000);
    isVerifyingRef.current = false;
    setIsVerifying(false);
  }, [refreshData, verifyRecord]);

  useEffect(() => {
    isMountedRef.current = true;
    refreshData();
    if (!isVerifyingRef.current) autoVerifyPredictions();
    return () => {
      isMountedRef.current = false;
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    };
  }, []); // Empty deps - only run on mount/unmount

  const getDaysLeft = (date: number) =>
    Math.max(
      0,
      Math.ceil((date + VERIFICATION_DAYS * 86400000 - Date.now()) / 86400000)
    );
  const fmtPrice = (p: number) =>
    p >= 1000 ? `${p.toFixed(0)}` : `${p.toFixed(2)}`;
  const fmtMoney = (v: number) =>
    v >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
      ? `${(v / 1e3).toFixed(0)}K`
      : `${v.toFixed(0)}`;
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
      className="relative overflow-hidden rounded-xl"
      style={{
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* Diagonal accent */}
      <div
        className="absolute top-0 right-0 w-24 h-24 opacity-20"
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

      {/* Agent Portfolios */}
      {portfolios.length > 0 && (
        <div className="p-5 relative z-10">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
                style={{
                  background:
                    "linear-gradient(145deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)",
                  border: "1px solid rgba(255,215,0,0.3)",
                  boxShadow: "0 0 20px rgba(255,215,0,0.15)",
                }}
              >
                🏆
              </div>
              <div>
                <h3
                  className="text-base font-black text-white"
                  style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  AI Portfolios
                </h3>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                  {TOTAL_AGENTS} agents • $100K each
                </p>
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-xl font-black text-white"
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  textShadow: "0 0 20px rgba(255,215,0,0.3)",
                }}
              >
                {fmtMoney(totalAUM)}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">
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
              const rankColors = ["#ffd700", "#c0c0c0", "#cd7f32"];

              return (
                <div
                  key={p.agentId}
                  className="relative p-3 rounded-xl text-center group hover:scale-[1.03] transition-transform"
                  style={{
                    background: isTop3
                      ? "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)"
                      : "rgba(255,255,255,0.02)",
                    border: isTop3
                      ? `1px solid ${rankColors[i]}30`
                      : "1px solid rgba(255,255,255,0.04)",
                  }}
                >
                  {isTop3 && (
                    <div
                      className="absolute -top-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black"
                      style={{
                        background: `linear-gradient(135deg, ${rankColors[i]} 0%, ${rankColors[i]}80 100%)`,
                        color: i === 2 ? "#fff" : "#0a0a0f",
                        boxShadow: `0 0 15px ${rankColors[i]}50`,
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
                    className="text-sm font-black"
                    style={{
                      color: isPositive ? "#00ff88" : "#ef4444",
                      textShadow: isPositive
                        ? "0 0 15px rgba(0,255,136,0.4)"
                        : "0 0 15px rgba(239,68,68,0.4)",
                    }}
                  >
                    {fmtPct(p.totalReturn)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 font-mono">
                    {fmtMoney(p.totalValue)}
                  </div>
                </div>
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
            <StatItem
              label="Avg Return"
              value={fmtPct(avgReturn)}
              color={avgReturn >= 0 ? "#00ff88" : "#ef4444"}
            />
            <div className="w-px h-10 bg-white/[0.08]" />
            <StatItem
              label="Trades"
              value={totalTrades.toString()}
              color="#fff"
            />
            <div className="w-px h-10 bg-white/[0.08]" />
            <StatItem
              label="Win Rate"
              value={`${(avgWinRate * 100).toFixed(0)}%`}
              color="#ffd700"
            />
          </div>
        </div>
      )}

      {/* Predictions Section */}
      {history.length > 0 && (
        <div
          className={`p-5 relative z-10 ${
            portfolios.length > 0 ? "border-t border-white/[0.06]" : ""
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
                style={{
                  background:
                    "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
                  border: "1px solid rgba(0,240,255,0.3)",
                  boxShadow: "0 0 20px rgba(0,240,255,0.15)",
                }}
              >
                🎯
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3
                    className="text-base font-black text-white"
                    style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                  >
                    Predictions
                  </h3>
                  {stats.total > 0 && (
                    <span
                      className="text-[10px] font-black px-2.5 py-1 rounded-md"
                      style={{
                        background:
                          stats.rate >= 60
                            ? "rgba(0,255,136,0.15)"
                            : stats.rate >= 40
                            ? "rgba(255,215,0,0.15)"
                            : "rgba(239,68,68,0.15)",
                        color:
                          stats.rate >= 60
                            ? "#00ff88"
                            : stats.rate >= 40
                            ? "#ffd700"
                            : "#ef4444",
                        border: `1px solid ${
                          stats.rate >= 60
                            ? "rgba(0,255,136,0.3)"
                            : stats.rate >= 40
                            ? "rgba(255,215,0,0.3)"
                            : "rgba(239,68,68,0.3)"
                        }`,
                      }}
                    >
                      {stats.rate.toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                  {stats.total} verified • {pending.length} pending
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AnimatePresence>
                {verifyMessage && (
                  <motion.span
                    className="text-xs font-bold px-2.5 py-1.5 rounded-lg"
                    style={{
                      background: "rgba(0,255,136,0.15)",
                      color: "#00ff88",
                      border: "1px solid rgba(0,255,136,0.3)",
                    }}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                  >
                    ✓ {verifyMessage}
                  </motion.span>
                )}
              </AnimatePresence>
              {pending.length > 0 && (
                <button
                  onClick={handleManualVerify}
                  disabled={isVerifying}
                  className="text-xs font-black px-3 py-2 rounded-lg disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98] transition-transform"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
                    border: "1px solid rgba(0,240,255,0.3)",
                    color: "#00f0ff",
                  }}
                >
                  {isVerifying ? "Checking..." : "Verify Now"}
                </button>
              )}
            </div>
          </div>

          {/* Results List */}
          <div className="space-y-2.5">
            {checked.slice(0, 3).map((r) => {
              const change =
                r.priceAtCheck && r.priceAtAnalysis > 0
                  ? ((r.priceAtCheck - r.priceAtAnalysis) / r.priceAtAnalysis) *
                    100
                  : 0;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 p-3 rounded-xl hover:translate-x-1 transition-transform"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-base font-black"
                    style={{
                      background: r.wasAccurate
                        ? "rgba(0,255,136,0.15)"
                        : "rgba(239,68,68,0.15)",
                      color: r.wasAccurate ? "#00ff88" : "#ef4444",
                      border: `1px solid ${
                        r.wasAccurate
                          ? "rgba(0,255,136,0.3)"
                          : "rgba(239,68,68,0.3)"
                      }`,
                    }}
                  >
                    {r.wasAccurate ? "✓" : "✗"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-bold">{r.ticker}</span>
                      <RecBadge rec={r.recommendation} />
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                      {fmtPrice(r.priceAtAnalysis)} →{" "}
                      {r.priceAtCheck ? fmtPrice(r.priceAtCheck) : "—"}
                    </div>
                  </div>
                  <div
                    className="text-base font-black"
                    style={{
                      color: change >= 0 ? "#00ff88" : "#ef4444",
                      textShadow: `0 0 10px ${
                        change >= 0
                          ? "rgba(0,255,136,0.3)"
                          : "rgba(239,68,68,0.3)"
                      }`,
                    }}
                  >
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(1)}%
                  </div>
                </div>
              );
            })}

            {pending.slice(0, 2).map((r) => {
              const days = getDaysLeft(r.analysisDate);
              const isChecking = verifyingTicker === r.ticker;
              const targetPct =
                r.priceAtAnalysis > 0
                  ? ((r.targetPrice - r.priceAtAnalysis) / r.priceAtAnalysis) *
                    100
                  : 0;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 p-3 rounded-xl hover:translate-x-1 transition-transform"
                  style={{
                    background: "rgba(255,255,255,0.01)",
                    border: "1px dashed rgba(255,255,255,0.08)",
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-base"
                    style={{
                      background: "rgba(255,215,0,0.1)",
                      border: "1px solid rgba(255,215,0,0.2)",
                    }}
                  >
                    {isChecking ? "⏳" : "📊"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-bold">{r.ticker}</span>
                      <RecBadge rec={r.recommendation} />
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Target:{" "}
                      <span className="font-mono">
                        {fmtPrice(r.targetPrice)}
                      </span>
                      <span
                        style={{
                          color: targetPct >= 0 ? "#00ff88" : "#ef4444",
                        }}
                      >
                        {" "}
                        ({targetPct >= 0 ? "+" : ""}
                        {targetPct.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  <div
                    className="text-[11px] text-slate-400 px-2.5 py-1.5 rounded-lg font-mono"
                    style={{ background: "rgba(255,255,255,0.04)" }}
                  >
                    {isChecking ? "..." : days > 0 ? `${days}d left` : "Ready"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div
        className="px-5 py-3 border-t border-white/[0.05] relative z-10"
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
