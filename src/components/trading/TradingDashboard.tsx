/**
 * Trading Dashboard - Strategic Arena Theme
 * Premium trading interface matching analysis aesthetic
 */

import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TradingSystemState, LeaderboardEntry } from "../../types/trading";
import { tradingService } from "../../services/trading";
import { Leaderboard } from "./Leaderboard";
import { PortfolioPerformanceChart } from "./PortfolioPerformanceChart";
import { RecentTrades } from "./RecentTrades";
import { TradingSettings } from "./TradingSettings";

export const TradingDashboard: React.FC = () => {
  const [tradingState, setTradingState] = useState<TradingSystemState | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTradingState();
  }, []);

  const loadTradingState = () => {
    setIsLoading(true);
    setError(null);
    try {
      let state = tradingService.loadTradingState();

      if (!state) {
        state = tradingService.initializeTradingSystem();
      }

      setTradingState(state);
    } catch (err) {
      console.error("Failed to load trading state:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load trading data"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const generateLeaderboard = (
    state: TradingSystemState
  ): LeaderboardEntry[] => {
    const entries = Object.values(state.portfolios).map((portfolio) => ({
      agentId: portfolio.agentId,
      agentName: portfolio.agentName,
      methodology: portfolio.methodology,
      totalReturn: portfolio.totalReturn,
      totalValue: portfolio.totalValue,
      winRate: portfolio.winRate,
      tradesCount: portfolio.totalTrades,
      sharpeRatio: portfolio.sharpeRatio || 0,
      maxDrawdown: portfolio.maxDrawdown,
      rank: 0,
      rankChange: 0,
    }));

    entries.sort((a, b) => b.totalReturn - a.totalReturn);
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    return entries;
  };

  const leaderboard = useMemo(() => {
    if (!tradingState) return [];
    return generateLeaderboard(tradingState);
  }, [tradingState]);

  const handleReset = async () => {
    if (
      confirm(
        "Are you sure you want to reset all portfolios? This cannot be undone."
      )
    ) {
      try {
        const state = tradingService.initializeTradingSystem();
        setTradingState(state);
      } catch (err) {
        console.error("Failed to reset portfolios:", err);
        setError(
          err instanceof Error ? err.message : "Failed to reset portfolios"
        );
      }
    }
  };

  const handleExport = () => {
    if (!tradingState) return;

    try {
      const jsonData = tradingService.exportTradingData(tradingState);
      const blob = new Blob([jsonData], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trading-data-${
        new Date().toISOString().split("T")[0]
      }.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export trading data:", err);
      alert("Failed to export data. Please try again.");
    }
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    let isAborted = false;

    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };

    reader.onload = async (e) => {
      if (isAborted) return;
      cleanup();
      try {
        const jsonData = e.target?.result as string;
        const state = await tradingService.importTradingData(jsonData);
        if (state) {
          setTradingState(state);
        } else {
          alert("Failed to import data. Please check the file format.");
        }
      } catch (err) {
        console.error("Failed to import trading data:", err);
        alert("Failed to import data. The file may be corrupted or invalid.");
      }
    };
    reader.onerror = () => {
      if (isAborted) return;
      cleanup();
      alert("Failed to read file. Please try again.");
    };
    reader.onabort = () => {
      isAborted = true;
      cleanup();
    };
    reader.readAsText(file);

    // Reset input so same file can be selected again
    event.target.value = "";
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <motion.div
            className="w-16 h-16 rounded-full border-2 border-cyan/30 border-t-cyan mx-auto mb-4"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          />
          <p className="text-slate-400">Loading trading arena...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="glass-card rounded-xl p-8 text-center">
          <p className="text-bear-light mb-4 font-semibold">{error}</p>
          <button
            onClick={loadTradingState}
            className="px-4 py-2 bg-gradient-to-r from-cyan/20 to-cyan/10 hover:from-cyan/30 hover:to-cyan/20 border border-cyan/30 rounded-lg text-white transition-all"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!tradingState) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="glass-card rounded-xl p-8 text-center">
          <p className="text-bear-light mb-4 font-semibold">
            Failed to load trading system
          </p>
          <button
            onClick={loadTradingState}
            className="px-4 py-2 bg-gradient-to-r from-cyan/20 to-cyan/10 hover:from-cyan/30 hover:to-cyan/20 border border-cyan/30 rounded-lg text-white transition-all"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="glass-card rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-serif font-bold text-white mb-2 flex items-center gap-2">
              <span className="text-3xl">🏆</span>
              Agent Trading Arena
            </h1>
            <p className="text-slate-400 text-sm">
              8 AI strategists competing with $100,000 each •{" "}
              <span className="text-cyan">{tradingState.totalTrades}</span>{" "}
              total trades
            </p>
          </div>
          <div className="flex gap-2">
            <motion.button
              onClick={handleExport}
              className="px-3 py-2 text-xs font-medium rounded-lg bg-gradient-to-r from-bull/20 to-bull/10 hover:from-bull/30 hover:to-bull/20 border border-bull/30 text-bull-light transition-all flex items-center gap-1.5"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <span>📥</span>
              <span className="hidden sm:inline">Export</span>
            </motion.button>
            <motion.label
              className="px-3 py-2 text-xs font-medium rounded-lg bg-gradient-to-r from-cyan/20 to-cyan/10 hover:from-cyan/30 hover:to-cyan/20 border border-cyan/30 text-cyan cursor-pointer transition-all flex items-center gap-1.5"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <span>📤</span>
              <span className="hidden sm:inline">Import</span>
              <input
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
            </motion.label>
            <motion.button
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-2 text-xs font-medium rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] text-slate-300 transition-all flex items-center gap-1.5"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <span>⚙️</span>
              <span className="hidden sm:inline">Settings</span>
            </motion.button>
          </div>
        </div>
      </div>

      {/* Settings Panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <TradingSettings
              state={tradingState}
              onUpdate={setTradingState}
              onReset={handleReset}
              onClose={() => setShowSettings(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Leaderboard */}
      <Leaderboard
        entries={leaderboard}
        onAgentClick={(agentId) => {
          window.location.hash = `#/trading/agent/${agentId}`;
        }}
      />

      {/* Portfolio Performance Chart */}
      <PortfolioPerformanceChart
        portfolios={Object.values(tradingState.portfolios)}
      />

      {/* Recent Trades */}
      <RecentTrades
        portfolios={Object.values(tradingState.portfolios)}
        limit={20}
      />

      {/* Disclaimer */}
      <motion.div
        className="glass-card rounded-xl p-4 border-l-4 border-gold"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        <p className="text-xs text-slate-400 leading-relaxed">
          <span className="text-gold font-semibold">⚠️ Disclaimer:</span> This
          is a simulation for educational purposes only. Past performance does
          not guarantee future results. Not financial advice.
        </p>
      </motion.div>
    </motion.div>
  );
};
