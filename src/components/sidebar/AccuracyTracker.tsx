/**
 * Accuracy Tracker Component - Strategic Arena Theme
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  HistoricalAccuracy,
  getAccuracyHistory,
  getAccuracyStats,
} from "../../services/storageService";

export const AccuracyTracker: React.FC = () => {
  const [history, setHistory] = useState<HistoricalAccuracy[]>([]);
  const [stats, setStats] = useState({ total: 0, accurate: 0, rate: 0 });
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    setHistory(getAccuracyHistory());
    setStats(getAccuracyStats());
  }, []);

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
          {stats.total > 0 && (
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
                <div className="text-[10px] text-slate-500">Tracked</div>
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
                  {stats.rate.toFixed(0)}%
                </div>
                <div className="text-[10px] text-slate-500">Success Rate</div>
              </motion.div>
            </div>

            {checkedHistory.length > 0 && (
              <div className="px-4 py-3 border-t border-white/[0.05]">
                <h4 className="text-xs font-medium text-slate-400 mb-2">
                  Verified Predictions
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
                            {formatDate(record.analysisDate)} →{" "}
                            {record.checkDate
                              ? formatDate(record.checkDate)
                              : "—"}
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
                <h4 className="text-xs font-medium text-slate-400 mb-2">
                  Pending Verification ({pendingHistory.length})
                </h4>
                <div className="space-y-1.5 max-h-28 overflow-y-auto">
                  {pendingHistory.slice(0, 5).map((record, index) => (
                    <motion.div
                      key={record.id}
                      className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.04 }}
                    >
                      <div className="flex items-center gap-2">
                        <motion.span
                          className="text-sm"
                          animate={{ rotate: [0, 10, -10, 0] }}
                          transition={{
                            repeat: Infinity,
                            duration: 2,
                            delay: index * 0.2,
                          }}
                        >
                          ⏳
                        </motion.span>
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
                          {formatDate(record.analysisDate)}
                        </div>
                      </div>
                    </motion.div>
                  ))}
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
