/**
 * Accuracy Tracker Component - Strategic Arena Theme
 * With auto-verification of past predictions
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
import { getFmpApiKey } from "../../services/apiKeyManager";

const VERIFICATION_DAYS = 3; // Verify after 3 days

export const AccuracyTracker: React.FC = () => {
  const [history, setHistory] = useState<HistoricalAccuracy[]>([]);
  const [stats, setStats] = useState({ total: 0, accurate: 0, rate: 0 });
  const [isExpanded, setIsExpanded] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isVerifyingRef = useRef(false); // Prevent concurrent verification runs
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshData = useCallback(() => {
    setHistory(getAccuracyHistory());
    setStats(getAccuracyStats());
  }, []);

  const autoVerifyPredictions = useCallback(
    async (signal?: AbortSignal) => {
      // Prevent concurrent runs
      if (isVerifyingRef.current) return;

      const pending = getPendingVerifications(VERIFICATION_DAYS);
      if (pending.length === 0) return;

      // Get API key from manager
      const apiKey = getFmpApiKey();
      if (!apiKey) {
        console.warn("No FMP API key available for verification");
        return;
      }

      isVerifyingRef.current = true;
      setIsVerifying(true);
      let verified = 0;

      for (const record of pending) {
        // Check if aborted
        if (signal?.aborted) {
          break;
        }

        try {
          // Fetch current price from FMP API
          const response = await fetch(
            `https://financialmodelingprep.com/api/v3/quote-short/${record.ticker}?apikey=${apiKey}`,
            { signal }
          );

          if (response.ok) {
            const data = await response.json();
            if (data && data[0] && data[0].price > 0) {
              const success = updateAccuracyCheck(record.id, data[0].price);
              if (success) {
                verified++;
              }
            }
          }

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          // Ignore abort errors
          if (error instanceof Error && error.name === "AbortError") {
            break;
          }
          console.warn(`Failed to verify ${record.ticker}:`, error);
        }
      }

      if (verified > 0 && !signal?.aborted) {
        setVerifyMessage(
          `Verified ${verified} prediction${verified > 1 ? "s" : ""}`
        );
        refreshData();
        // Clear any existing timeout
        if (messageTimeoutRef.current) {
          clearTimeout(messageTimeoutRef.current);
        }
        messageTimeoutRef.current = setTimeout(
          () => setVerifyMessage(null),
          3000
        );
      }

      isVerifyingRef.current = false;
      if (!signal?.aborted) {
        setIsVerifying(false);
      }
    },
    [refreshData]
  );

  // Auto-verify on mount with cleanup
  useEffect(() => {
    refreshData();

    // Prevent concurrent verification runs
    if (isVerifyingRef.current) return;

    // Create abort controller for cleanup
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    autoVerifyPredictions(signal);

    return () => {
      // Cleanup: abort any pending requests
      abortControllerRef.current?.abort();
      // Clear message timeout
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
    };
  }, [refreshData, autoVerifyPredictions]);

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "2-digit",
    });

  const getRecommendationColor = (rec: string): string => {
    switch (rec) {
      case "strong_buy":
      case "buy":
        return "text-bull-light";
      case "hold":
        return "text-gold-light";
      case "sell":
      case "strong_sell":
        return "text-bear-light";
      default:
        return "text-slate-400";
    }
  };

  const getDaysUntilVerification = (analysisDate: number): number => {
    const now = Date.now();
    const verificationDate =
      analysisDate + VERIFICATION_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft = Math.ceil(
      (verificationDate - now) / (24 * 60 * 60 * 1000)
    );
    return Math.max(0, daysLeft);
  };

  if (history.length === 0) return null;

  const checkedHistory = history.filter((h) => h.wasAccurate !== undefined);
  const pendingHistory = history.filter((h) => h.wasAccurate === undefined);

  return (
    <motion.div
      className="glass-card rounded-xl overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        whileTap={{ scale: 0.99 }}
        aria-expanded={isExpanded}
        aria-controls="accuracy-tracker-content"
      >
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden="true">
            🎯
          </span>
          <h3 className="text-sm font-semibold text-white">Accuracy Tracker</h3>
          {isVerifying && (
            <motion.span
              className="text-[10px] text-cyan"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
            >
              verifying...
            </motion.span>
          )}
          <AnimatePresence>
            {verifyMessage && (
              <motion.span
                className="text-[10px] text-bull-light"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
              >
                ✓ {verifyMessage}
              </motion.span>
            )}
          </AnimatePresence>
          {stats.total > 0 && !isVerifying && !verifyMessage && (
            <motion.span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
                stats.rate >= 60
                  ? "bg-bull/[0.12] text-bull-light border border-bull/25"
                  : stats.rate >= 40
                  ? "bg-gold/[0.12] text-gold-light border border-gold/25"
                  : "bg-bear/[0.12] text-bear-light border border-bear/25"
              }`}
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
            >
              {stats.rate.toFixed(0)}% accurate
            </motion.span>
          )}
        </div>
        <motion.span
          className="text-slate-500 text-xs"
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          ▼
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            id="accuracy-tracker-content"
            className="border-t border-white/[0.05]"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="px-4 py-3 bg-white/[0.01] grid grid-cols-3 gap-3">
              <motion.div
                className="text-center"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <div className="text-xl font-bold text-white">
                  {stats.total}
                </div>
                <div className="text-[10px] text-slate-500">Verified</div>
              </motion.div>
              <motion.div
                className="text-center"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
              >
                <div className="text-xl font-bold text-bull-light">
                  {stats.accurate}
                </div>
                <div className="text-[10px] text-slate-500">Accurate</div>
              </motion.div>
              <motion.div
                className="text-center"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <div
                  className={`text-xl font-bold ${
                    stats.rate >= 60
                      ? "text-bull-light"
                      : stats.rate >= 40
                      ? "text-gold-light"
                      : "text-bear-light"
                  }`}
                >
                  {stats.total > 0 ? `${stats.rate.toFixed(0)}%` : "—"}
                </div>
                <div className="text-[10px] text-slate-500">Success</div>
              </motion.div>
            </div>

            {checkedHistory.length > 0 && (
              <div className="px-4 py-3 border-t border-white/[0.05]">
                <h4 className="text-xs font-medium text-slate-400 mb-2">
                  Verified Results
                </h4>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {checkedHistory.slice(0, 10).map((record, index) => {
                    const priceChange =
                      record.priceAtCheck !== undefined &&
                      record.priceAtCheck !== null &&
                      record.priceAtAnalysis > 0
                        ? ((record.priceAtCheck - record.priceAtAnalysis) /
                            record.priceAtAnalysis) *
                          100
                        : 0;
                    return (
                      <motion.div
                        key={record.id}
                        className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.04 }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">
                            {record.wasAccurate ? "✅" : "❌"}
                          </span>
                          <div>
                            <span className="text-white font-medium text-xs">
                              {record.ticker}
                            </span>
                            <span
                              className={`ml-1.5 text-[10px] ${getRecommendationColor(
                                record.recommendation
                              )}`}
                            >
                              {record.recommendation
                                .replace("_", " ")
                                .toUpperCase()}
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`text-xs font-medium ${
                              priceChange >= 0
                                ? "text-bull-light"
                                : "text-bear-light"
                            }`}
                          >
                            {priceChange >= 0 ? "+" : ""}
                            {priceChange.toFixed(1)}%
                          </div>
                          <div className="text-[10px] text-slate-600">
                            {formatDate(record.analysisDate)}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            )}

            {pendingHistory.length > 0 && (
              <div className="px-4 py-3 border-t border-white/[0.05]">
                <h4 className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-2">
                  <span>Pending ({pendingHistory.length})</span>
                  <span className="text-[10px] text-slate-600">
                    Auto-verifies after {VERIFICATION_DAYS} days
                  </span>
                </h4>
                <div className="space-y-1.5 max-h-28 overflow-y-auto">
                  {pendingHistory.slice(0, 5).map((record, index) => {
                    const daysLeft = getDaysUntilVerification(
                      record.analysisDate
                    );
                    return (
                      <motion.div
                        key={record.id}
                        className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.04 }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">⏳</span>
                          <div>
                            <span className="text-white font-medium text-xs">
                              {record.ticker}
                            </span>
                            <span
                              className={`ml-1.5 text-[10px] ${getRecommendationColor(
                                record.recommendation
                              )}`}
                            >
                              {record.recommendation
                                .replace("_", " ")
                                .toUpperCase()}
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-slate-400">
                            ${record.priceAtAnalysis.toFixed(2)}
                          </div>
                          <div className="text-[10px] text-slate-600">
                            {daysLeft > 0
                              ? `${daysLeft}d left`
                              : "Verifying..."}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default AccuracyTracker;
