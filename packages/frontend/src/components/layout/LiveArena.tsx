/**
 * Live Arena - 24/7 AI Trading Tournament Dashboard
 *
 * Clean, modular implementation using component library
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { motion, AnimatePresence } from "framer-motion";

// Services
import {
  autonomousApi,
  type EngineStatus,
  type LiveEvent,
} from "../../services/api/autonomous";
import { apiClient } from "../../services/api/client";
import { logger } from "../../services/utils/logger";

// Components
import { EmptyState, ErrorBoundary } from "../ui";
import {
  EngineStatusBanner,
  AnalystGrid,
  LiveTradeFeed,
  Leaderboard,
  DebateCard,
  type AnalystState,
  type TradeEvent,
  type DebateMatch,
} from "../arena";
import { AuthModal } from "./AuthModal";
import { Header } from "./Header";

type TabType = "tournament" | "leaderboard" | "trades" | "debates" | "manual";

// Inner component that can throw errors
const LiveArenaInner: React.FC = () => {
  // Auth State
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // UI State
  const [activeTab, setActiveTab] = useState<TabType>("tournament");

  // Engine State
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Live Events
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [sseError, setSseError] = useState<string | null>(null);
  const [sseRetryCount, setSseRetryCount] = useState(0);

  // Auth handlers
  const checkAuth = useCallback(() => {
    const authed = apiClient.isAuthenticated();
    setIsAuthenticated(authed);
    return authed;
  }, []);

  const handleLogout = useCallback(() => {
    apiClient.logout();
    setIsAuthenticated(false);
    setEngineStatus(null);
    setLiveEvents([]);
  }, []);

  // Auth check on mount
  useEffect(() => {
    checkAuth();
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "auth_token") checkAuth();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [checkAuth]);

  // Fetch engine status
  const fetchEngineStatus = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      if (!engineMountedRef.current) return;
      setEngineLoading(true);
      setEngineError(null);

      const status = await autonomousApi.getStatus();

      // Guard state updates after async operation
      if (!engineMountedRef.current) return;
      setEngineStatus(status);
    } catch (error: any) {
      logger.error("Failed to fetch engine status:", error);
      if (!engineMountedRef.current) return;
      setEngineError(error.message || "Failed to load engine status");
    } finally {
      if (engineMountedRef.current) {
        setEngineLoading(false);
      }
    }
  }, [isAuthenticated]);

  // Initial fetch
  useEffect(() => {
    if (isAuthenticated) {
      fetchEngineStatus();
    }
  }, [isAuthenticated, fetchEngineStatus]);

  // Connect to live events (SSE)
  useEffect(() => {
    if (!isAuthenticated) return;

    let cleanup: (() => void) | null = null;
    let isMounted = true; // Local mounted flag for this effect
    setSseError(null);

    try {
      cleanup = autonomousApi.connectToEvents(
        (event) => {
          // Guard against state updates after unmount/cleanup
          if (!isMounted) return;

          // Update engine status on status events
          if (event.type === "status" && event.data) {
            setEngineStatus(event.data);
          }

          // Add to live events feed
          setLiveEvents((prev) => [event, ...prev].slice(0, 100));
          setIsConnected(true);
          setSseError(null);
        },
        (error) => {
          // Guard against state updates after unmount/cleanup
          if (!isMounted) return;

          logger.error("SSE connection error:", error);
          setIsConnected(false);
          setSseError(error.message || "Connection lost");
        }
      );
    } catch (error) {
      logger.error("Failed to connect to live events:", error);
      if (isMounted) {
        setIsConnected(false);
        setSseError("Failed to connect to live events");
      }
    }

    return () => {
      isMounted = false;
      if (cleanup) cleanup();
    };
  }, [isAuthenticated, sseRetryCount]); // Add sseRetryCount to trigger reconnect

  // Manual SSE reconnect handler
  const handleSseRetry = useCallback(() => {
    setSseRetryCount((prev) => prev + 1);
  }, []);

  // Engine controls - with loading state to prevent double-clicks
  const [engineActionLoading, setEngineActionLoading] = useState(false);

  // Ref to track component mount state for async operations
  const engineMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    engineMountedRef.current = true;
    return () => {
      engineMountedRef.current = false;
    };
  }, []);

  const handleStartEngine = async () => {
    if (engineActionLoading) return;

    try {
      setEngineActionLoading(true);
      await autonomousApi.start();
      // Only update state if still mounted
      if (engineMountedRef.current) {
        await fetchEngineStatus();
      }
    } catch (error: any) {
      logger.error("Failed to start engine:", error);
      if (engineMountedRef.current) {
        alert(`Failed to start engine: ${error.message}`);
      }
    } finally {
      if (engineMountedRef.current) {
        setEngineActionLoading(false);
      }
    }
  };

  const handleStopEngine = async () => {
    if (engineActionLoading) return;
    if (!confirm("Stop the autonomous trading engine?")) return;

    try {
      setEngineActionLoading(true);
      await autonomousApi.stop();
      // Only update state if still mounted
      if (engineMountedRef.current) {
        await fetchEngineStatus();
      }
    } catch (error: any) {
      logger.error("Failed to stop engine:", error);
      if (engineMountedRef.current) {
        alert(`Failed to stop engine: ${error.message}`);
      }
    } finally {
      if (engineMountedRef.current) {
        setEngineActionLoading(false);
      }
    }
  };

  // Transform engine analysts to AnalystState format (memoized)
  // FIXED: Validate status against allowed values to prevent type mismatch
  const analysts: AnalystState[] = useMemo(
    () =>
      engineStatus?.analysts?.map((a: any, index: number) => {
        // Validate status is one of the allowed values
        const validStatuses = [
          "analyzing",
          "trading",
          "cooldown",
          "paused",
          "idle",
        ] as const;
        const rawStatus = a.status?.toLowerCase() || "idle";
        const status = validStatuses.includes(rawStatus) ? rawStatus : "idle";

        return {
          id: a.id || a.analystId || `analyst-${index}`,
          balance: a.balance ?? 100,
          totalValue: a.totalValue ?? a.balance ?? 100,
          returnPercent: a.returnPercent ?? a.return ?? 0,
          rank: a.rank ?? index + 1,
          status: status as AnalystState["status"],
          tradesCount: a.tradesCount ?? a.totalTrades ?? 0,
          winRate: a.winRate ?? 0,
          lastTrade: a.lastTrade,
        };
      }) || [],
    [engineStatus?.analysts]
  );

  // Transform live events to TradeEvent format (memoized)
  const tradeEvents: TradeEvent[] = useMemo(
    () =>
      liveEvents
        .filter((e) => e.type === "tradeExecuted" && e.data)
        .map((e, i) => ({
          id: `trade-${e.timestamp || i}`,
          timestamp: e.timestamp || Date.now(),
          analystId: e.data.analystId || "unknown",
          symbol: e.data.symbol || "cmt_btcusdt",
          side: e.data.side || "BUY",
          size: e.data.size || 0,
          price: e.data.price || 0,
          pnl: e.data.pnl,
        })),
    [liveEvents]
  );

  // Get debate events (memoized)
  const debateEvents = useMemo(
    () => liveEvents.filter((e) => e.type === "debatesComplete"),
    [liveEvents]
  );

  // Memoize tabs to prevent recreation on every render
  const tabs = useMemo(
    () => [
      { id: "tournament" as TabType, label: "Live Tournament", icon: "🏆" },
      { id: "leaderboard" as TabType, label: "Leaderboard", icon: "📊" },
      {
        id: "trades" as TabType,
        label: "Live Trades",
        icon: "⚡",
        badge: tradeEvents.length,
      },
      {
        id: "debates" as TabType,
        label: "Debates",
        icon: "⚔️",
        badge: debateEvents.length,
      },
      {
        id: "manual" as TabType,
        label: "Manual Trade",
        icon: "🎮",
        auth: true,
      },
    ],
    [tradeEvents.length, debateEvents.length]
  );

  return (
    <div className="min-h-screen bg-arena-pattern text-white flex flex-col">
      <div className="bg-noise" />

      {/* Background Glows */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div
          className="absolute w-[800px] h-[800px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(0, 240, 255, 0.15) 0%, transparent 60%)",
            left: "-10%",
            top: "-30%",
            filter: "blur(60px)",
          }}
        />
        <div
          className="absolute w-[600px] h-[600px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(255, 215, 0, 0.12) 0%, transparent 60%)",
            right: "-5%",
            bottom: "-10%",
            filter: "blur(50px)",
          }}
        />
      </div>

      <Header
        wsConnected={isConnected}
        isAuthenticated={isAuthenticated}
        assets={null}
        onLogin={() => setShowAuthModal(true)}
        onLogout={handleLogout}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Engine Status Banner */}
        {isAuthenticated && engineStatus && (
          <EngineStatusBanner
            isRunning={engineStatus.isRunning}
            currentCycle={engineStatus.cycleCount || 0}
            nextCycleIn={engineStatus.nextCycleIn}
            totalTrades={engineStatus.stats?.totalTrades || 0}
            onStart={handleStartEngine}
            onStop={handleStopEngine}
            isLoading={engineActionLoading}
          />
        )}

        {/* SSE Connection Error Banner */}
        {isAuthenticated && sseError && !isConnected && (
          <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-yellow-400 text-sm">
                <span>⚠️</span>
                <span>Live updates disconnected: {sseError}</span>
              </div>
              <button
                onClick={handleSseRetry}
                className="px-3 py-1 text-xs bg-yellow-500/20 text-yellow-400 rounded hover:bg-yellow-500/30 transition-colors"
              >
                Reconnect
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div
            className="flex gap-1 p-1 arena-card rounded-xl overflow-x-auto"
            role="tablist"
            aria-label="Tournament navigation"
          >
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const isDisabled = tab.auth && !isAuthenticated;

              return (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  onClick={() => !isDisabled && setActiveTab(tab.id)}
                  onKeyDown={(e) => {
                    // ACCESSIBILITY FIX: Improved keyboard navigation that handles multiple disabled tabs
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const currentIndex = tabs.findIndex(
                        (t) => t.id === activeTab
                      );
                      const direction = e.key === "ArrowRight" ? 1 : -1;

                      // Loop through tabs to find next enabled one
                      let iterations = 0;
                      let nextIndex = currentIndex;

                      while (iterations < tabs.length) {
                        nextIndex = nextIndex + direction;
                        // Wrap around
                        if (nextIndex < 0) nextIndex = tabs.length - 1;
                        if (nextIndex >= tabs.length) nextIndex = 0;

                        const nextTab = tabs[nextIndex];
                        const nextIsDisabled = nextTab.auth && !isAuthenticated;

                        if (!nextIsDisabled) {
                          setActiveTab(nextTab.id);
                          // Focus the new tab button
                          const nextButton = document.getElementById(
                            `tab-${nextTab.id}`
                          );
                          nextButton?.focus();
                          break;
                        }

                        iterations++;
                      }
                    }
                  }}
                  disabled={isDisabled}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`tabpanel-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  className={`
                    flex-1 min-w-[140px] px-4 py-3 text-sm font-semibold rounded-lg transition-all whitespace-nowrap
                    focus:outline-none focus:ring-2 focus:ring-cyan-400/50
                    ${
                      isActive
                        ? "bg-cyan/15 text-cyan border border-cyan/20 shadow-[0_0_15px_rgba(0,240,255,0.1)]"
                        : isDisabled
                        ? "text-slate-600 cursor-not-allowed opacity-50"
                        : "text-slate-400 hover:text-white hover:bg-white/[0.04]"
                    }
                  `}
                >
                  <span className="text-lg mr-2" aria-hidden="true">
                    {tab.icon}
                  </span>
                  {tab.label}
                  {tab.badge ? (
                    <span
                      className="ml-2 px-2 py-0.5 text-xs bg-cyan/20 text-cyan rounded-full"
                      aria-label={`${tab.badge} items`}
                    >
                      {tab.badge}
                    </span>
                  ) : null}
                  {isDisabled && (
                    <span
                      className="ml-2 text-sm opacity-50"
                      aria-hidden="true"
                    >
                      🔒
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!isAuthenticated ? (
            <div
              id={`tabpanel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              <EmptyState
                icon="🔐"
                title="Login Required"
                description="Connect your account to watch the AI trading tournament"
                action={
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="btn-primary px-6 py-3 rounded-lg font-bold"
                  >
                    Connect Account
                  </button>
                }
              />
            </div>
          ) : engineLoading ? (
            <div
              id={`tabpanel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              <LoadingState />
            </div>
          ) : engineError ? (
            <div
              id={`tabpanel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              <EmptyState
                icon="⚠️"
                title="Failed to Load"
                description={engineError}
                action={
                  <button
                    onClick={fetchEngineStatus}
                    className="btn-primary px-6 py-3 rounded-lg font-bold"
                  >
                    Retry
                  </button>
                }
              />
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {activeTab === "tournament" && (
                <div
                  key="tournament"
                  id="tabpanel-tournament"
                  role="tabpanel"
                  aria-labelledby="tab-tournament"
                >
                  <TournamentTab
                    analysts={analysts}
                    tradeEvents={tradeEvents}
                  />
                </div>
              )}
              {activeTab === "leaderboard" && (
                <div
                  key="leaderboard"
                  id="tabpanel-leaderboard"
                  role="tabpanel"
                  aria-labelledby="tab-leaderboard"
                >
                  <LeaderboardTab analysts={analysts} />
                </div>
              )}
              {activeTab === "trades" && (
                <div
                  key="trades"
                  id="tabpanel-trades"
                  role="tabpanel"
                  aria-labelledby="tab-trades"
                >
                  <TradesTab tradeEvents={tradeEvents} />
                </div>
              )}
              {activeTab === "debates" && (
                <div
                  key="debates"
                  id="tabpanel-debates"
                  role="tabpanel"
                  aria-labelledby="tab-debates"
                >
                  <DebatesTab debateEvents={debateEvents} />
                </div>
              )}
              {activeTab === "manual" && (
                <div
                  key="manual"
                  id="tabpanel-manual"
                  role="tabpanel"
                  aria-labelledby="tab-manual"
                >
                  <ManualTradeTab />
                </div>
              )}
            </AnimatePresence>
          )}
        </div>
      </main>

      <AnimatePresence>
        {showAuthModal && (
          <AuthModal
            onClose={() => setShowAuthModal(false)}
            onSuccess={() => {
              setShowAuthModal(false);
              checkAuth();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

// Tab Components
const TournamentTab: React.FC<{
  analysts: AnalystState[];
  tradeEvents: TradeEvent[];
}> = ({ analysts, tradeEvents }) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
    className="space-y-6"
  >
    <div className="text-center mb-8">
      <h2 className="text-3xl font-bold mb-2">
        <span className="text-gradient-cyan">🏆 AI TRADING TOURNAMENT</span>
      </h2>
      <p className="text-slate-400">
        8 AI analysts competing 24/7 on WEEX Exchange
      </p>
    </div>

    {analysts.length > 0 ? (
      <AnalystGrid analysts={analysts} />
    ) : (
      <EmptyState
        icon="🤖"
        title="No Analysts Active"
        description="Start the engine to begin the tournament"
      />
    )}

    {tradeEvents.length > 0 && (
      <LiveTradeFeed
        events={tradeEvents}
        maxItems={5}
        title="🔴 Recent Trades"
      />
    )}
  </motion.div>
);

const LeaderboardTab: React.FC<{ analysts: AnalystState[] }> = ({
  analysts,
}) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
  >
    <div className="text-center mb-8">
      <h2 className="text-3xl font-bold mb-2">
        <span className="text-gradient-cyan">📊 LEADERBOARD</span>
      </h2>
      <p className="text-slate-400">Performance rankings of all 8 analysts</p>
    </div>

    {analysts.length > 0 ? (
      <Leaderboard analysts={analysts} />
    ) : (
      <EmptyState
        icon="📊"
        title="No Data Yet"
        description="Start the engine to see rankings"
      />
    )}
  </motion.div>
);

const TradesTab: React.FC<{ tradeEvents: TradeEvent[] }> = ({
  tradeEvents,
}) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
  >
    <div className="text-center mb-8">
      <h2 className="text-3xl font-bold mb-2">
        <span className="text-gradient-cyan">⚡ LIVE TRADES</span>
      </h2>
      <p className="text-slate-400">Real-time trade feed from all analysts</p>
    </div>

    <LiveTradeFeed events={tradeEvents} maxItems={50} />
  </motion.div>
);

const DebatesTab: React.FC<{ debateEvents: LiveEvent[] }> = ({
  debateEvents,
}) => {
  // Transform debate events to DebateMatch format with validation
  const debates: DebateMatch[] = useMemo(() => {
    return debateEvents
      .filter((e) => e.data?.debates && Array.isArray(e.data.debates))
      .flatMap((e) => {
        const rawDebates = e.data.debates as unknown[];
        return rawDebates
          .filter((d): d is DebateMatch => {
            // Validate required fields exist
            if (!d || typeof d !== "object") return false;
            const debate = d as Record<string, unknown>;
            return (
              debate.bullAnalyst != null &&
              debate.bearAnalyst != null &&
              typeof debate.winner === "string"
            );
          })
          .map((d, idx) => ({
            ...d,
            // Ensure id exists for React keys
            id: d.id || `debate-${e.timestamp}-${idx}`,
          }));
      });
  }, [debateEvents]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
    >
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold mb-2">
          <span className="text-gradient-cyan">⚔️ ANALYST DEBATES</span>
        </h2>
        <p className="text-slate-400">
          Tournament-style debates between analysts
        </p>
      </div>

      {debates.length === 0 ? (
        <EmptyState
          icon="⏳"
          title="No Debates Yet"
          description="Debates happen every cycle when specialists analyze coins"
        />
      ) : (
        <div className="space-y-4 max-w-3xl mx-auto">
          {debates.map((debate) => (
            <DebateCard key={debate.id} debate={debate} />
          ))}
        </div>
      )}
    </motion.div>
  );
};

const ManualTradeTab: React.FC = () => {
  const [symbol, setSymbol] = useState("cmt_btcusdt");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [size, setSize] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const mountedRef = useRef(true);

  // Cleanup on unmount to prevent state updates after unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const symbols = [
    "cmt_btcusdt",
    "cmt_ethusdt",
    "cmt_solusdt",
    "cmt_dogeusdt",
    "cmt_xrpusdt",
    "cmt_adausdt",
    "cmt_bnbusdt",
    "cmt_ltcusdt",
  ];

  const handleTrade = async () => {
    const parsedSize = parseFloat(size);
    // Validate size: must be positive, finite, and within reasonable bounds
    const MAX_TRADE_SIZE = 1000000; // $1M max per trade for safety
    if (!size || !Number.isFinite(parsedSize) || parsedSize <= 0) {
      setResult({ success: false, message: "Please enter a valid size" });
      return;
    }
    if (parsedSize > MAX_TRADE_SIZE) {
      setResult({
        success: false,
        message: `Trade size cannot exceed $${MAX_TRADE_SIZE.toLocaleString()}`,
      });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      // This would call the trading API
      // For now, show that it's not connected to a portfolio
      if (mountedRef.current) {
        setResult({
          success: false,
          message:
            "Manual trading requires a portfolio. Create one in the Tournament tab first, then use the TradingService API directly.",
        });
      }
    } catch (error: any) {
      if (mountedRef.current) {
        setResult({ success: false, message: error.message });
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
    >
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold mb-2">
          <span className="text-gradient-cyan">🎮 MANUAL TRADE</span>
        </h2>
        <p className="text-slate-400">
          Execute your own trades (separate from AI tournament)
        </p>
      </div>

      <div className="max-w-md mx-auto glass-card rounded-xl p-6 space-y-6">
        {/* Symbol Selection */}
        <div>
          <label
            htmlFor="trade-symbol"
            className="block text-sm font-medium text-slate-400 mb-2"
          >
            Symbol
          </label>
          <select
            id="trade-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-cyan-400"
          >
            {symbols.map((s) => (
              <option key={s} value={s} className="bg-slate-800">
                {s.replace("cmt_", "").toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {/* Side Selection */}
        <fieldset>
          <legend className="block text-sm font-medium text-slate-400 mb-2">
            Side
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setSide("BUY")}
              aria-pressed={side === "BUY"}
              className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                side === "BUY"
                  ? "bg-green-500/20 text-green-400 border border-green-500/50"
                  : "bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10"
              }`}
            >
              🟢 LONG
            </button>
            <button
              type="button"
              onClick={() => setSide("SELL")}
              aria-pressed={side === "SELL"}
              className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                side === "SELL"
                  ? "bg-red-500/20 text-red-400 border border-red-500/50"
                  : "bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10"
              }`}
            >
              🔴 SHORT
            </button>
          </div>
        </fieldset>

        {/* Size Input */}
        <div>
          <label
            htmlFor="trade-size"
            className="block text-sm font-medium text-slate-400 mb-2"
          >
            Size (USDT)
          </label>
          <input
            id="trade-size"
            type="number"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="Enter amount..."
            min="0.01"
            step="0.01"
            inputMode="decimal"
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>

        {/* Execute Button */}
        <button
          onClick={handleTrade}
          disabled={loading || !size}
          className={`w-full px-6 py-4 rounded-lg font-bold text-lg transition-all ${
            loading || !size
              ? "bg-slate-700 text-slate-500 cursor-not-allowed"
              : side === "BUY"
              ? "bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30"
              : "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
          }`}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Processing...
            </span>
          ) : (
            `${side === "BUY" ? "🟢 Open Long" : "🔴 Open Short"}`
          )}
        </button>

        {/* Result Message */}
        {result && (
          <div
            className={`p-4 rounded-lg ${
              result.success
                ? "bg-green-500/10 border border-green-500/30 text-green-400"
                : "bg-yellow-500/10 border border-yellow-500/30 text-yellow-400"
            }`}
          >
            <p className="text-sm">{result.message}</p>
          </div>
        )}

        {/* Info */}
        <div className="text-xs text-slate-500 text-center">
          <p>⚠️ Manual trades are separate from the AI tournament</p>
          <p className="mt-1">
            Trades execute on WEEX with your connected account
          </p>
        </div>
      </div>
    </motion.div>
  );
};

const LoadingState: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-16">
    <div className="w-16 h-16 rounded-full border-4 border-cyan-400/30 border-t-cyan-400 animate-spin mb-4" />
    <p className="text-slate-400">Loading tournament data...</p>
  </div>
);

// Main export with ErrorBoundary wrapper
export const LiveArena: React.FC = () => (
  <ErrorBoundary
    fallback={
      <div className="min-h-screen bg-arena-pattern text-white flex items-center justify-center">
        <div className="text-center p-8">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-2xl font-bold mb-2">Something went wrong</h2>
          <p className="text-slate-400 mb-4">
            The trading arena encountered an error.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-all font-semibold"
          >
            Reload Page
          </button>
        </div>
      </div>
    }
  >
    <LiveArenaInner />
  </ErrorBoundary>
);

export default LiveArena;
