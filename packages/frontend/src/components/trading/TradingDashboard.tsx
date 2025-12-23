/**
 * Trading Dashboard - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TradingSystemState, LeaderboardEntry } from "../../types/trading";
import { tradingService } from "../../services/trading";
import { Leaderboard } from "./Leaderboard";
import { PortfolioPerformanceChart } from "./PortfolioPerformanceChart";
import { RecentTrades } from "./RecentTrades";
import { TradingSettings } from "./TradingSettings";
import AgentPortfolioView from "./AgentPortfolioView";

export const TradingDashboard: React.FC = () => {
  const [tradingState, setTradingState] = useState<TradingSystemState | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Ref to track if component is mounted for async cleanup
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Handle hash-based routing for agent portfolio view
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      const match = hash.match(/#\/trading\/agent\/(.+)/);
      if (match && match[1]) {
        setSelectedAgentId(match[1]);
      } else {
        setSelectedAgentId(null);
      }
    };

    // Check initial hash
    handleHashChange();

    // Listen for hash changes
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    loadTradingState();
  }, []);

  const loadTradingState = () => {
    setIsLoading(true);
    setError(null);
    try {
      let state = tradingService.loadTradingState();
      if (!state) state = tradingService.initializeTradingSystem();
      setTradingState(state);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load trading data"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const generateLeaderboard = useCallback(
    (state: TradingSystemState): LeaderboardEntry[] => {
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
    },
    []
  );

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
        setError(
          err instanceof Error ? err.message : "Failed to reset portfolios"
        );
      }
    }
  };

  const handleExport = () => {
    if (!tradingState) return;
    let url: string | null = null;
    try {
      const jsonData = tradingService.exportTradingData(tradingState);
      const blob = new Blob([jsonData], { type: "application/json" });
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trading-data-${
        new Date().toISOString().split("T")[0]
      }.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      alert("Failed to export data. Please try again.");
    } finally {
      if (url) URL.revokeObjectURL(url);
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
      if (isAborted || !isMountedRef.current) return;
      cleanup();
      try {
        const jsonData = e.target?.result as string;
        const state = await tradingService.importTradingData(jsonData);
        if (!isMountedRef.current) return;
        if (state) setTradingState(state);
        else alert("Failed to import data. Please check the file format.");
      } catch {
        if (!isMountedRef.current) return;
        alert("Failed to import data. The file may be corrupted or invalid.");
      }
    };
    reader.onerror = () => {
      if (isAborted || !isMountedRef.current) return;
      cleanup();
      alert("Failed to read file. Please try again.");
    };
    reader.onabort = () => {
      isAborted = true;
      cleanup();
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const handleAgentClick = useCallback((agentId: string) => {
    window.location.hash = `/trading/agent/${agentId}`;
  }, []);

  const handleBackFromAgent = useCallback(() => {
    window.location.hash = "/trading";
    setSelectedAgentId(null);
  }, []);

  // Get selected agent's portfolio
  const selectedPortfolio = useMemo(() => {
    if (!selectedAgentId || !tradingState) return null;
    return tradingState.portfolios[selectedAgentId] || null;
  }, [selectedAgentId, tradingState]);

  // If an agent is selected and we're still loading, show loading state
  if (selectedAgentId && isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div
            className="w-20 h-20 rounded-2xl mx-auto mb-6 flex items-center justify-center animate-spin"
            style={{
              background:
                "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
              border: "1px solid rgba(0,240,255,0.3)",
              boxShadow: "0 0 40px rgba(0,240,255,0.2)",
            }}
          >
            <span className="text-3xl">📊</span>
          </div>
          <p
            className="text-slate-400"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Loading portfolio...
          </p>
        </div>
      </div>
    );
  }

  // If an agent is selected but portfolio not found, show error
  if (selectedAgentId && tradingState && !selectedPortfolio) {
    return (
      <div className="space-y-6">
        <button
          onClick={handleBackFromAgent}
          className="flex items-center gap-2 text-cyan hover:text-cyan-light transition-colors font-medium text-sm"
        >
          <span>←</span>
          <span>Back to Leaderboard</span>
        </button>
        <div className="flex items-center justify-center py-20">
          <div
            className="p-8 text-center rounded-xl"
            style={{
              background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
              border: "1px solid rgba(239,68,68,0.3)",
              boxShadow: "0 0 40px rgba(239,68,68,0.1)",
            }}
          >
            <p className="text-red-400 mb-4 font-semibold">
              Portfolio not found for agent: {selectedAgentId}
            </p>
            <button
              onClick={handleBackFromAgent}
              className="px-6 py-3 rounded-lg font-bold text-sm hover:scale-105 active:scale-95 transition-transform"
              style={{
                background:
                  "linear-gradient(135deg, rgba(0,240,255,0.2) 0%, rgba(0,240,255,0.05) 100%)",
                border: "1px solid rgba(0,240,255,0.4)",
                color: "#00f0ff",
              }}
            >
              Back to Leaderboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If an agent is selected, show their portfolio view
  if (selectedAgentId && selectedPortfolio) {
    return (
      <AgentPortfolioView
        portfolio={selectedPortfolio}
        onBack={handleBackFromAgent}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div
            className="w-20 h-20 rounded-2xl mx-auto mb-6 flex items-center justify-center animate-spin"
            style={{
              background:
                "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
              border: "1px solid rgba(0,240,255,0.3)",
              boxShadow: "0 0 40px rgba(0,240,255,0.2)",
            }}
          >
            <span className="text-3xl">🏆</span>
          </div>
          <p
            className="text-slate-400"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Initializing Trading Arena...
          </p>
        </div>
      </div>
    );
  }

  if (error || !tradingState) {
    return (
      <div className="flex items-center justify-center py-20">
        <div
          className="p-8 text-center rounded-xl"
          style={{
            background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
            border: "1px solid rgba(239,68,68,0.3)",
            boxShadow: "0 0 40px rgba(239,68,68,0.1)",
          }}
        >
          <p className="text-red-400 mb-4 font-semibold">
            {error || "Failed to load trading system"}
          </p>
          <button
            onClick={loadTradingState}
            className="px-6 py-3 rounded-lg font-bold text-sm hover:scale-105 active:scale-95 transition-transform"
            style={{
              background:
                "linear-gradient(135deg, rgba(0,240,255,0.2) 0%, rgba(0,240,255,0.05) 100%)",
              border: "1px solid rgba(0,240,255,0.4)",
              color: "#00f0ff",
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
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

        <div
          className="flex items-center justify-between relative z-10"
          role="banner"
          aria-label="Trading Arena Header"
        >
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-3xl"
              aria-hidden="true"
              style={{
                background:
                  "linear-gradient(145deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)",
                border: "1px solid rgba(255,215,0,0.3)",
                boxShadow: "0 0 30px rgba(255,215,0,0.15)",
              }}
            >
              🏆
            </div>
            <div>
              <h1
                className="text-2xl font-black text-white tracking-tight"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                Agent Trading Arena
              </h1>
              <p className="text-slate-500 text-sm mt-1">
                8 AI strategists competing with{" "}
                <span className="text-gold font-bold">$100,000</span> each •{" "}
                <span className="text-cyan font-bold">
                  {tradingState.totalTrades}
                </span>{" "}
                total trades
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <ActionButton
              icon="📥"
              label="Export"
              onClick={handleExport}
              color="#22c55e"
            />
            <label>
              <ActionButton icon="📤" label="Import" color="#00f0ff" />
              <input
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
            </label>
            <ActionButton
              icon="⚙️"
              label="Settings"
              onClick={() => setShowSettings(!showSettings)}
              color="#94a3b8"
            />
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

      <Leaderboard entries={leaderboard} onAgentClick={handleAgentClick} />
      <PortfolioPerformanceChart
        portfolios={Object.values(tradingState.portfolios)}
      />
      <RecentTrades
        portfolios={Object.values(tradingState.portfolios)}
        limit={20}
      />

      {/* Disclaimer */}
      <div
        className="relative overflow-hidden rounded-xl p-4"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          borderLeft: "3px solid #ffd700",
          border: "1px solid rgba(255,215,0,0.2)",
        }}
      >
        <p className="text-xs text-slate-400 leading-relaxed">
          <span className="text-gold font-bold">⚠️ DISCLAIMER:</span> This is a
          simulation for educational purposes only. Past performance does not
          guarantee future results. Not financial advice.
        </p>
      </div>
    </div>
  );
};

const ActionButton: React.FC<{
  icon: string;
  label: string;
  onClick?: () => void;
  color: string;
}> = ({ icon, label, onClick, color }) => (
  <button
    onClick={onClick}
    className="px-3 py-2 text-xs font-bold rounded-lg flex items-center gap-1.5 hover:scale-[1.02] active:scale-[0.98] transition-transform"
    style={{ background: `${color}15`, border: `1px solid ${color}40`, color }}
  >
    <span>{icon}</span>
    <span className="hidden sm:inline">{label}</span>
  </button>
);
