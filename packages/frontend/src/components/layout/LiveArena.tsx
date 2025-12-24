/**
 * Live Arena - Main Crypto Trading Dashboard
 * Cinematic Command Center with glass morphism design
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  weexApi,
  WeexTicker,
  WeexAssets,
  WeexPosition,
} from "../../services/api/weex";
import { apiClient } from "../../services/api/client";
import { wsClient } from "../../services/api/websocket";

// Components
import { EmptyState } from "../ui";
import {
  AnalystCard,
  ChampionCard,
  DebateCard,
  AnalysisSummary,
  AIAnalysis,
  DebateMatch,
} from "../arena";
import { OrderBook, PositionsPanel, TradingPanel } from "../trading";
import { AuthModal } from "./AuthModal";
import { MarketSidebar } from "./MarketSidebar";
import { Header } from "./Header";

type TabType = "market" | "positions" | "analysis" | "debate" | "trade";

export const LiveArena: React.FC = () => {
  // Market State
  const [tickers, setTickers] = useState<WeexTicker[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState("cmt_btcusdt");

  // Account State
  const [assets, setAssets] = useState<WeexAssets | null>(null);
  const [positions, setPositions] = useState<WeexPosition[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // UI State
  const [activeTab, setActiveTab] = useState<TabType>("market");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Analysis State
  const [analyses, setAnalyses] = useState<AIAnalysis[]>([]);
  const [debates, setDebates] = useState<DebateMatch[]>([]);
  const [champion, setChampion] = useState<AIAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const selectedTicker = useMemo(
    () => tickers.find((t) => t.symbol === selectedSymbol),
    [tickers, selectedSymbol]
  );

  // Auth handlers
  const checkAuth = useCallback(() => {
    const authed = apiClient.isAuthenticated();
    setIsAuthenticated(authed);
    return authed;
  }, []);

  const handleLogout = useCallback(() => {
    apiClient.logout();
    setIsAuthenticated(false);
    setAssets(null);
    setPositions([]);
  }, []);

  // WebSocket connection
  useEffect(() => {
    setWsConnected(wsClient.isConnected());
    const unsubConnect = wsClient.onConnect(() => setWsConnected(true));
    const unsubDisconnect = wsClient.onDisconnect(() => setWsConnected(false));
    return () => {
      unsubConnect();
      unsubDisconnect();
    };
  }, []);

  // Auth check
  useEffect(() => {
    checkAuth();
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "auth_token") checkAuth();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") checkAuth();
    };
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [checkAuth]);

  // Fetch market data
  useEffect(() => {
    let cancelled = false;
    const fetchMarket = async () => {
      try {
        const data = await weexApi.getTickers();
        if (!cancelled) {
          setTickers(data);
          setMarketLoading(false);
        }
      } catch {
        if (!cancelled) setMarketLoading(false);
      }
    };
    fetchMarket();
    const unsubscribe = wsClient.subscribe("tickers", (data: WeexTicker[]) => {
      if (!cancelled && Array.isArray(data)) setTickers(data);
    });
    const pollInterval = setInterval(() => {
      if (!wsClient.isConnected()) fetchMarket();
    }, 10000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(pollInterval);
    };
  }, []);

  // Fetch account data
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const fetchAccount = async () => {
      try {
        const [assetsData, positionsData] = await Promise.all([
          weexApi.getAssets().catch(() => null),
          weexApi.getPositions().catch(() => []),
        ]);
        if (!cancelled) {
          setAssets(assetsData);
          setPositions(positionsData);
        }
      } catch {
        /* ignore */
      }
    };
    fetchAccount();
    const interval = setInterval(fetchAccount, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  // AI Analysis
  const analysisAbortRef = React.useRef<AbortController | null>(null);

  const runAIAnalysis = useCallback(async () => {
    if (!selectedSymbol) return;
    if (analysisAbortRef.current) analysisAbortRef.current.abort();

    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalysisLoading(true);
    setAnalyses([]);
    setDebates([]);
    setChampion(null);
    setAnalysisError(null);

    try {
      const result = await apiClient.post<{
        analyses: AIAnalysis[];
        debates?: DebateMatch[];
        champion?: AIAnalysis;
      }>(
        `/analysis/generate-all`,
        { symbol: selectedSymbol },
        { timeout: 120000, signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        setAnalyses(result.analyses || []);
        setDebates(result.debates || []);
        setChampion(result.champion || null);
        setActiveTab("analysis");
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setAnalysisError(
          err instanceof Error ? err.message : "Analysis failed"
        );
      }
    } finally {
      if (!controller.signal.aborted) setAnalysisLoading(false);
      if (analysisAbortRef.current === controller)
        analysisAbortRef.current = null;
    }
  }, [selectedSymbol]);

  useEffect(
    () => () => {
      analysisAbortRef.current?.abort();
    },
    []
  );

  const tabs = [
    { id: "market" as TabType, label: "Order Book", icon: "📊" },
    { id: "positions" as TabType, label: "Positions", icon: "📈", auth: true },
    {
      id: "analysis" as TabType,
      label: "AI Analysis",
      icon: "🤖",
      badge: analyses.length,
    },
    {
      id: "debate" as TabType,
      label: "Battle Arena",
      icon: "⚔️",
      badge: debates.length,
    },
    { id: "trade" as TabType, label: "Trade", icon: "⚡", auth: true },
  ];

  return (
    <div className="min-h-screen bg-arena-pattern text-white flex flex-col">
      <div className="bg-noise" />

      <Header
        wsConnected={wsConnected}
        isAuthenticated={isAuthenticated}
        assets={assets}
        onLogin={() => setShowAuthModal(true)}
        onLogout={handleLogout}
      />

      <div className="flex-1 flex overflow-hidden">
        <MarketSidebar
          tickers={tickers}
          loading={marketLoading}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
          isOpen={sidebarOpen}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Symbol Header */}
          {selectedTicker && (
            <SymbolHeader
              ticker={selectedTicker}
              symbol={selectedSymbol}
              onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
              onRunAnalysis={runAIAnalysis}
              analysisLoading={analysisLoading}
              isAuthenticated={isAuthenticated}
            />
          )}

          {/* Tabs */}
          <div className="border-b border-white/10 px-4 bg-grid">
            <div className="flex gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  disabled={tab.auth && !isAuthenticated}
                  className={`px-4 py-3 text-sm font-medium transition-all relative ${
                    activeTab === tab.id
                      ? "text-cyan-400 border-b-2 border-cyan-400"
                      : tab.auth && !isAuthenticated
                      ? "text-slate-600 cursor-not-allowed"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <span className="mr-1.5">{tab.icon}</span>
                  {tab.label}
                  {tab.badge ? (
                    <span className="ml-1.5 badge badge-cyan !py-0 !px-1.5 !text-[9px]">
                      {tab.badge}
                    </span>
                  ) : null}
                  {tab.auth && !isAuthenticated && (
                    <span className="ml-1 text-[10px]">🔒</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <AnimatePresence mode="wait">
              {activeTab === "market" && (
                <TabContent key="market">
                  <OrderBook symbol={selectedSymbol} />
                </TabContent>
              )}

              {activeTab === "positions" && (
                <TabContent key="positions">
                  {!isAuthenticated ? (
                    <EmptyState
                      icon="🔐"
                      title="Login Required"
                      description="Connect your account to view positions"
                      action={
                        <button
                          onClick={() => setShowAuthModal(true)}
                          className="btn-primary px-4 py-2 rounded-lg"
                        >
                          Connect
                        </button>
                      }
                    />
                  ) : positions.length === 0 ? (
                    <EmptyState
                      icon="📭"
                      title="No Open Positions"
                      description="You don't have any open positions yet"
                    />
                  ) : (
                    <PositionsPanel positions={positions} />
                  )}
                </TabContent>
              )}

              {activeTab === "analysis" && (
                <TabContent key="analysis">
                  {analysisLoading ? (
                    <AnalysisLoading symbol={selectedSymbol} />
                  ) : analysisError ? (
                    <EmptyState
                      icon="⚠️"
                      title="Analysis Failed"
                      description={analysisError}
                      action={
                        <button
                          onClick={runAIAnalysis}
                          className="btn-primary px-4 py-2 rounded-lg"
                        >
                          Try Again
                        </button>
                      }
                    />
                  ) : analyses.length === 0 ? (
                    <EmptyState
                      icon="🤖"
                      title="No Analysis Yet"
                      description="Click 'AI Analysis' to get insights from 8 AI analysts"
                      action={
                        <button
                          onClick={runAIAnalysis}
                          className="btn-primary px-4 py-2 rounded-lg"
                        >
                          Run Analysis
                        </button>
                      }
                    />
                  ) : (
                    <div className="space-y-6">
                      {champion && <ChampionCard champion={champion} />}
                      <AnalysisSummary
                        analyses={analyses}
                        symbol={selectedSymbol}
                      />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {analyses.map((a, i) => (
                          <motion.div
                            key={a.analystId}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.05 }}
                          >
                            <AnalystCard
                              analysis={a}
                              isChampion={champion?.analystId === a.analystId}
                            />
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  )}
                </TabContent>
              )}

              {activeTab === "debate" && (
                <TabContent key="debate">
                  {debates.length === 0 ? (
                    <EmptyState
                      icon="⚔️"
                      title="No Debates Yet"
                      description="Run AI Analysis to see analysts battle it out"
                      action={
                        <button
                          onClick={runAIAnalysis}
                          disabled={analysisLoading}
                          className="btn-primary px-4 py-2 rounded-lg disabled:opacity-50"
                        >
                          {analysisLoading ? "Analyzing..." : "Start Battle"}
                        </button>
                      }
                    />
                  ) : (
                    <DebateArena debates={debates} />
                  )}
                </TabContent>
              )}

              {activeTab === "trade" && (
                <TabContent key="trade">
                  {!isAuthenticated ? (
                    <EmptyState
                      icon="🔐"
                      title="Login Required"
                      description="Connect your account to trade"
                      action={
                        <button
                          onClick={() => setShowAuthModal(true)}
                          className="btn-primary px-4 py-2 rounded-lg"
                        >
                          Connect
                        </button>
                      }
                    />
                  ) : (
                    <TradingPanel
                      symbol={selectedSymbol}
                      ticker={selectedTicker}
                      balance={assets?.available || "0"}
                    />
                  )}
                </TabContent>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>

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

// Sub-components
const TabContent: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
  >
    {children}
  </motion.div>
);

const AnalysisLoading: React.FC<{ symbol: string }> = ({ symbol }) => (
  <div className="flex flex-col items-center justify-center py-16">
    <div className="w-16 h-16 rounded-full border-4 border-cyan-400/30 border-t-cyan-400 animate-spin mb-4" />
    <p className="text-slate-400">
      8 AI analysts are reviewing{" "}
      {symbol.replace("cmt_", "").replace("usdt", "").toUpperCase()}...
    </p>
    <p className="text-xs text-slate-600 mt-2">
      This may take up to 60 seconds
    </p>
  </div>
);

const DebateArena: React.FC<{ debates: DebateMatch[] }> = ({ debates }) => {
  const quarterfinals = debates.filter((d) => d.round === "quarterfinal");
  const semifinals = debates.filter((d) => d.round === "semifinal");
  const finals = debates.filter((d) => d.round === "final");

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-2">
          <span className="text-gradient-cyan">⚔️ ANALYST BATTLE ARENA ⚔️</span>
        </h2>
        <p className="text-slate-500 text-sm">
          8 AI analysts compete in tournament-style debates
        </p>
      </div>

      {finals.length > 0 && (
        <RoundSection
          title="CHAMPIONSHIP FINAL"
          icon="👑"
          color="text-yellow-400"
          debates={finals}
        />
      )}
      {semifinals.length > 0 && (
        <RoundSection
          title="SEMI FINALS"
          icon="🔥"
          color="text-amber-400"
          debates={semifinals}
        />
      )}
      {quarterfinals.length > 0 && (
        <RoundSection
          title="QUARTER FINALS"
          icon="⚔️"
          color="text-slate-400"
          debates={quarterfinals}
        />
      )}
    </div>
  );
};

const RoundSection: React.FC<{
  title: string;
  icon: string;
  color: string;
  debates: DebateMatch[];
}> = ({ title, icon, color, debates }) => (
  <div className="space-y-4">
    <div className="flex items-center gap-3">
      <span className="text-2xl">{icon}</span>
      <h3 className={`text-lg font-bold ${color}`}>{title}</h3>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {debates.map((debate) => (
        <DebateCard key={debate.id} debate={debate} />
      ))}
    </div>
  </div>
);

const SymbolHeader: React.FC<{
  ticker: WeexTicker;
  symbol: string;
  onToggleSidebar: () => void;
  onRunAnalysis: () => void;
  analysisLoading: boolean;
  isAuthenticated: boolean;
}> = ({
  ticker,
  symbol,
  onToggleSidebar,
  onRunAnalysis,
  analysisLoading,
  isAuthenticated,
}) => {
  const displaySymbol = symbol
    .replace("cmt_", "")
    .replace("usdt", "")
    .toUpperCase();
  const price = parseFloat(ticker.last) || 0;
  const change = parseFloat(ticker.priceChangePercent || "0") * 100;
  const isPositive = change >= 0;

  const formatPrice = (p: number) =>
    p >= 1000
      ? p.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : p >= 1
      ? p.toFixed(2)
      : p.toFixed(4);
  const formatVolume = (v: number) =>
    v >= 1e9
      ? `${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
      ? `${(v / 1e3).toFixed(2)}K`
      : v.toFixed(2);

  return (
    <div className="p-4 border-b border-white/10 glass-card rounded-none">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors lg:hidden"
          >
            ☰
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold">
                {displaySymbol}
                <span className="text-slate-500 text-lg ml-1">/USDT</span>
              </h2>
              <span
                className={`badge ${isPositive ? "badge-bull" : "badge-bear"}`}
              >
                {isPositive ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            </div>
            <p className="font-mono text-3xl font-bold mt-1">
              ${formatPrice(price)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <div>
            <p className="text-slate-500 text-xs">24h High</p>
            <p className="font-mono text-green-400">
              ${formatPrice(parseFloat(ticker.high_24h) || 0)}
            </p>
          </div>
          <div>
            <p className="text-slate-500 text-xs">24h Low</p>
            <p className="font-mono text-rose-400">
              ${formatPrice(parseFloat(ticker.low_24h) || 0)}
            </p>
          </div>
          <div>
            <p className="text-slate-500 text-xs">24h Volume</p>
            <p className="font-mono">
              {formatVolume(parseFloat(ticker.volume_24h) || 0)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRunAnalysis}
            disabled={analysisLoading}
            className="btn-primary btn-lift px-4 py-2 rounded-lg flex items-center gap-2 disabled:opacity-50"
          >
            {analysisLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Analyzing...
              </>
            ) : (
              <>🤖 AI Analysis</>
            )}
          </button>
          {isAuthenticated && (
            <button className="px-4 py-2 rounded-lg font-semibold bg-green-500 text-white hover:bg-green-600 transition-all">
              Long
            </button>
          )}
          {isAuthenticated && (
            <button className="px-4 py-2 rounded-lg font-semibold bg-rose-500 text-white hover:bg-rose-600 transition-all">
              Short
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiveArena;
