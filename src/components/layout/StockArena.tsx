/**
 * Stock Arena - Main Orchestration Component
 * Strategic Arena Theme - Premium UI/UX
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  StockAnalysisData,
  InvestmentThesis,
  FinalRecommendation,
  StockArenaState,
  StockDebate,
} from "../../types/stock";
import {
  fetchAllStockData,
  generateAllTheses,
  runTournament,
  generateFinalRecommendation,
  TournamentResult,
} from "../../services/stock";
import {
  saveAnalysis,
  trackAnalysis,
  addToWatchlist,
  isInWatchlist,
  SavedAnalysis,
} from "../../services/storageService";
import { TickerInput } from "./TickerInput";
import { StockHeader } from "./StockHeader";
import { CompareStocks } from "./CompareStocks";
import { LiveArena } from "./LiveArena";
import { AnalystCard, RecommendationCard, DebateView } from "../analysis";
import { PriceChart, TechnicalsCard, NewsCard } from "../charts";
import { Watchlist, SavedAnalyses, AccuracyTracker } from "../sidebar";
import { TradingDashboard } from "../trading/TradingDashboard";
import { PostAnalysisTradingView } from "../trading/PostAnalysisTradingView";
import { tradingService } from "../../services/trading";
import { TradeDecision } from "../../types/trading";
import ErrorBoundary from "../common/ErrorBoundary";

interface StockArenaProps {
  apiKey: string;
  onShowSettings?: () => void;
}

type ActiveTab = "analysis" | "charts" | "technicals" | "news" | "trading";

const LOADING_STATES = {
  [StockArenaState.FETCHING_DATA]: {
    icon: "📡",
    title: "Gathering Intelligence",
    subtitle: "Connecting to market data sources...",
    progress: 25,
  },
  [StockArenaState.GENERATING_ANALYSTS]: {
    icon: "🧠",
    title: "Analysts Deliberating",
    subtitle: "Each strategist is forming their thesis...",
    progress: 50,
  },
  [StockArenaState.RUNNING_TOURNAMENT]: {
    icon: "⚔️",
    title: "Battle Commencing",
    subtitle: "Bulls and Bears clash in heated debate...",
    progress: 75,
  },
  [StockArenaState.GENERATING_RECOMMENDATION]: {
    icon: "🎯",
    title: "Forging Verdict",
    subtitle: "Synthesizing insights into final recommendation...",
    progress: 90,
  },
};

const pageTransition = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const },
  },
  exit: { opacity: 0, y: -20, transition: { duration: 0.3 } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const staggerItem = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const },
  },
};

export const StockArena: React.FC<StockArenaProps> = ({
  apiKey,
  onShowSettings,
}) => {
  const [state, setState] = useState<StockArenaState>(StockArenaState.IDLE);
  const [stockData, setStockData] = useState<StockAnalysisData | null>(null);
  const [theses, setTheses] = useState<InvestmentThesis[]>([]);
  const [tournamentResult, setTournamentResult] =
    useState<TournamentResult | null>(null);
  const [recommendation, setRecommendation] =
    useState<FinalRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("analysis");
  const [showCompare, setShowCompare] = useState(false);
  const [showTradingView, setShowTradingView] = useState(false);
  const [tradingDecisions, setTradingDecisions] = useState<
    Map<string, TradeDecision>
  >(new Map());
  const [inWatchlist, setInWatchlist] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [liveDebates, setLiveDebates] = useState<StockDebate[]>([]);
  const [currentDebate, setCurrentDebate] = useState<StockDebate | null>(null);
  const [tournamentProgress, setTournamentProgress] = useState<{
    round: string;
    matchNumber: number;
    totalMatches: number;
  } | null>(null);
  const [tradingPreviewError, setTradingPreviewError] = useState(false);

  const isMountedRef = useRef(true);
  const saveMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (saveMessageTimeoutRef.current)
        clearTimeout(saveMessageTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (stockData) setInWatchlist(isInWatchlist(stockData.ticker));
  }, [stockData]);

  const isAnalyzingRef = useRef(false);

  const generateTradingPreview = useCallback(
    async (
      theses: InvestmentThesis[],
      tournament: TournamentResult,
      data: StockAnalysisData
    ) => {
      // Reset error state at the start, before any async operations
      setTradingPreviewError(false);

      // Validate tournament has debates
      if (!tournament.allDebates || tournament.allDebates.length === 0) {
        // No debates found - silently skip trading preview
        return;
      }

      try {
        // Import statically to avoid dynamic import warning
        const state =
          tradingService.loadTradingState() ||
          tradingService.initializeTradingSystem();

        const decisions = new Map<string, TradeDecision>();
        for (const thesis of theses) {
          if (!isMountedRef.current) return;

          const portfolio = state.portfolios[thesis.agentId];
          if (!portfolio) continue;

          const debate = tournament.allDebates.find(
            (d) =>
              d.bullThesis.agentId === thesis.agentId ||
              d.bearThesis.agentId === thesis.agentId
          );
          if (!debate) continue;

          const decision = await tradingService.determineTradeDecision(
            thesis,
            debate,
            portfolio,
            data.quote.price,
            data.quote.timestamp || Date.now()
          );
          decisions.set(thesis.agentId, decision);
        }

        if (isMountedRef.current) {
          setTradingDecisions(decisions);
        }
      } catch (err) {
        if (process.env.NODE_ENV === "development") {
          console.error("Trading preview generation failed:", err);
        }
        if (isMountedRef.current) {
          setTradingPreviewError(true);
          setTradingDecisions(new Map());
        }
      }
    },
    []
  );

  const handleTickerSelect = useCallback(
    async (ticker: string) => {
      // Silently prevent duplicate analysis if already running
      if (isAnalyzingRef.current) return;

      isAnalyzingRef.current = true;

      setError(null);
      setStockData(null);
      setTheses([]);
      setTournamentResult(null);
      setRecommendation(null);
      setLiveDebates([]);
      setCurrentDebate(null);
      setTournamentProgress(null);

      try {
        if (!isMountedRef.current) return;
        setState(StockArenaState.FETCHING_DATA);
        setProgress("Connecting to data sources...");

        const data = await fetchAllStockData(ticker);
        if (!isMountedRef.current) return;
        setStockData(data);

        setState(StockArenaState.GENERATING_ANALYSTS);
        const { theses: generatedTheses, errors: thesisErrors } =
          await generateAllTheses(apiKey, data, {
            concurrency: 4, // Generate 4 analysts at once
            onProgress: (completed, total, analyst) => {
              if (isMountedRef.current) {
                // Handle long analyst names for better mobile UX
                const names = analyst.split(" & ");
                const displayText =
                  names.length > 2
                    ? `${names[0]} & ${names.length - 1} others`
                    : analyst;
                setProgress(`${displayText} (${completed}/${total})`);
              }
            },
            onThesisComplete: (thesis) => {
              if (isMountedRef.current) {
                setTheses((prev) => [...prev, thesis]);
              }
            },
          });

        // Log any thesis generation errors in development
        if (thesisErrors.length > 0 && process.env.NODE_ENV === "development") {
          console.warn(
            `[StockArena] ${thesisErrors.length} analyst(s) failed to generate theses:`,
            thesisErrors.map((e) => `${e.analyst}: ${e.error}`).join(", ")
          );
        }

        if (!isMountedRef.current) return;
        if (generatedTheses.length === 0)
          throw new Error("Failed to generate analyst theses");

        // Don't set theses again - already set incrementally via onThesisComplete
        // This prevents duplicate entries

        setState(StockArenaState.RUNNING_TOURNAMENT);
        const tournament = await runTournament(generatedTheses, data, {
          apiKey,
          turnsPerDebate: 2,
          onDebateStart: (round, num) => {
            if (isMountedRef.current) {
              setProgress(
                `${round.charAt(0).toUpperCase() + round.slice(1)} #${num}`
              );
              // Calculate total matches for this round
              const totalMatches =
                round === "quarterfinal" ? 4 : round === "semifinal" ? 2 : 1;
              setTournamentProgress({ round, matchNumber: num, totalMatches });
            }
          },
          onDebateComplete: (debate) => {
            if (!isMountedRef.current) return;
            // Clear current debate when it completes
            setCurrentDebate(null);
            setTournamentResult((prev) => {
              if (!prev)
                return {
                  quarterfinals:
                    debate.round === "quarterfinal" ? [debate] : [],
                  semifinals: debate.round === "semifinal" ? [debate] : [],
                  final: debate.round === "final" ? debate : null,
                  champion: null,
                  allDebates: [debate],
                };
              return {
                ...prev,
                quarterfinals:
                  debate.round === "quarterfinal"
                    ? [...prev.quarterfinals, debate]
                    : prev.quarterfinals,
                semifinals:
                  debate.round === "semifinal"
                    ? [...prev.semifinals, debate]
                    : prev.semifinals,
                final: debate.round === "final" ? debate : prev.final,
                allDebates: [...prev.allDebates, debate],
              };
            });
          },
          onTurnComplete: (debate) => {
            if (!isMountedRef.current) return;
            // Set as current debate
            setCurrentDebate(debate);
            // Update live debates with the new turn
            setLiveDebates((prev) => {
              const existing = prev.find((d) => d.matchId === debate.matchId);
              if (existing) {
                return prev.map((d) =>
                  d.matchId === debate.matchId ? debate : d
                );
              }
              return [...prev, debate];
            });
          },
        });
        if (!isMountedRef.current) return;
        setTournamentResult(tournament);

        setState(StockArenaState.GENERATING_RECOMMENDATION);
        setProgress("Calculating final verdict...");
        const finalRec = generateFinalRecommendation(
          data,
          generatedTheses,
          tournament
        );
        if (!isMountedRef.current) return;
        setRecommendation(finalRec);
        setState(StockArenaState.COMPLETE);
        setProgress("");
        // Note: isAnalyzingRef.current is cleared in finally block

        // Generate trading decisions for preview (fire and forget with error handling)
        generateTradingPreview(generatedTheses, tournament, data).catch(
          (err) => {
            // Error is already handled inside generateTradingPreview, this is just a safety net
            if (process.env.NODE_ENV === "development") {
              console.error("Unhandled trading preview error:", err);
            }
          }
        );
      } catch (err) {
        if (!isMountedRef.current) return;
        const errorMessage =
          err instanceof Error ? err.message : "An error occurred";
        setError(errorMessage);
        setState(StockArenaState.ERROR);
        setProgress("");
        // Clear all analysis state on error to prevent partial/stale data
        setTheses([]);
        setLiveDebates([]);
        setCurrentDebate(null);
        setTournamentProgress(null);
      } finally {
        isAnalyzingRef.current = false;
      }
    },
    [apiKey, generateTradingPreview]
  );

  const handleReset = () => {
    setState(StockArenaState.IDLE);
    setStockData(null);
    setTheses([]);
    setTournamentResult(null);
    setRecommendation(null);
    setError(null);
    setProgress("");
    setActiveTab("analysis");
    setSaveMessage(null);
    setLiveDebates([]);
    setCurrentDebate(null);
    setTournamentProgress(null);
    setTradingDecisions(new Map());
    setTradingPreviewError(false);
  };

  // Memoize trading preview to avoid recalculating on every render
  const tradingPreview = useMemo(() => {
    if (tradingDecisions.size === 0) return undefined;

    const decisionsArray = Array.from(tradingDecisions.values());
    const validTrades = decisionsArray.filter(
      (d) => d.isValid && d.action !== "HOLD"
    );

    return {
      buyCount: decisionsArray.filter((d) => d.action === "BUY" && d.isValid)
        .length,
      sellCount: decisionsArray.filter((d) => d.action === "SELL" && d.isValid)
        .length,
      holdCount: decisionsArray.filter((d) => d.action === "HOLD" || !d.isValid)
        .length,
      totalValue: validTrades.reduce((sum, d) => sum + d.estimatedValue, 0),
      avgConfidence:
        validTrades.length > 0
          ? validTrades.reduce((sum, d) => sum + d.confidence, 0) /
            validTrades.length
          : 0,
    };
  }, [tradingDecisions]);

  const showTemporaryMessage = (message: string) => {
    if (saveMessageTimeoutRef.current)
      clearTimeout(saveMessageTimeoutRef.current);
    setSaveMessage(message);
    saveMessageTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) setSaveMessage(null);
    }, 2000);
  };

  const handleSaveAnalysis = () => {
    if (!stockData || !tournamentResult || !recommendation) return;
    const saved = saveAnalysis(
      stockData,
      theses,
      tournamentResult,
      recommendation
    );
    if (saved) {
      trackAnalysis(recommendation);
      showTemporaryMessage("Analysis saved!");
      setSidebarRefreshKey((k) => k + 1);
    } else showTemporaryMessage("Failed to save");
  };

  const handleAddToWatchlist = () => {
    if (!stockData) return;
    const added = addToWatchlist(stockData.ticker, stockData.profile.name);
    if (added) {
      setInWatchlist(true);
      showTemporaryMessage("Added to watchlist!");
      setSidebarRefreshKey((k) => k + 1);
    }
  };

  const handleLoadAnalysis = (analysis: SavedAnalysis) => {
    setStockData(analysis.stockData);
    setTheses(analysis.theses);
    setTournamentResult(analysis.tournamentResult);
    setRecommendation(analysis.recommendation);
    setState(StockArenaState.COMPLETE);
    setActiveTab("analysis");
    setTradingDecisions(new Map()); // Reset trading decisions for loaded analysis
    setTradingPreviewError(false);
    // Clear live state from previous analysis
    setLiveDebates([]);
    setCurrentDebate(null);
    setTournamentProgress(null);
  };

  const isLoading =
    state !== StockArenaState.IDLE &&
    state !== StockArenaState.COMPLETE &&
    state !== StockArenaState.ERROR;
  const loadingInfo = LOADING_STATES[state as keyof typeof LOADING_STATES];
  const tabs = [
    { id: "analysis" as ActiveTab, label: "Analysis", icon: "🎯" },
    { id: "charts" as ActiveTab, label: "Charts", icon: "📊" },
    { id: "technicals" as ActiveTab, label: "Technicals", icon: "📉" },
    { id: "news" as ActiveTab, label: "News", icon: "📰" },
    { id: "trading" as ActiveTab, label: "Trading", icon: "🏆" },
  ];

  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-50 bg-arena-deep/90 backdrop-blur-xl"
        style={{ borderBottom: "1px solid rgba(0, 240, 255, 0.1)" }}
      >
        {/* Header glow accent */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan/20 to-transparent" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <motion.div
              className="flex items-center gap-2.5"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <span className="text-xl">⚔️</span>
              <span className="font-serif text-lg font-semibold text-white hidden sm:block">
                Hypothesis Arena
              </span>
            </motion.div>
            <div className="flex items-center gap-2">
              <AnimatePresence>
                {saveMessage && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.9, x: 10 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.9, x: 10 }}
                    className="text-xs text-cyan font-medium px-2.5 py-1 bg-cyan/10 rounded-lg"
                  >
                    {saveMessage}
                  </motion.span>
                )}
              </AnimatePresence>
              {state === StockArenaState.COMPLETE && (
                <>
                  <HeaderButton
                    onClick={handleSaveAnalysis}
                    icon="💾"
                    label="Save"
                  />
                  {!inWatchlist && (
                    <HeaderButton
                      onClick={handleAddToWatchlist}
                      icon="⭐"
                      label="Watch"
                    />
                  )}
                  <HeaderButton
                    onClick={() => setShowCompare(true)}
                    icon="⚖️"
                    label="Compare"
                  />
                  <HeaderButton
                    onClick={handleReset}
                    icon="←"
                    label="New"
                    variant="ghost"
                  />
                </>
              )}
              {onShowSettings && (
                <HeaderButton
                  onClick={onShowSettings}
                  icon="⚙️"
                  label="Settings"
                  variant="ghost"
                />
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AnimatePresence mode="wait">
          {(state === StockArenaState.IDLE ||
            state === StockArenaState.ERROR) && (
            <motion.div
              key="idle"
              variants={pageTransition}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="relative"
            >
              {/* Cinematic Background - Golden/Cyan Command Center */}
              <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
                {/* Base gradient */}
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(135deg, #080b0f 0%, #0d1117 50%, #080b0f 100%)",
                  }}
                />

                {/* Cyan glow - top left */}
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

                {/* Gold glow - bottom right */}
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

                {/* Diagonal accent lines */}
                <div
                  className="absolute top-0 right-0 w-[400px] h-[2px] opacity-30"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, #00f0ff 50%, transparent)",
                    transform:
                      "rotate(-45deg) translateX(100px) translateY(150px)",
                  }}
                />
                <div
                  className="absolute bottom-0 left-0 w-[300px] h-[1px] opacity-20"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, #ffd700 50%, transparent)",
                    transform:
                      "rotate(-45deg) translateX(-50px) translateY(-100px)",
                  }}
                />

                {/* Scanline overlay */}
                <div
                  className="absolute inset-0 opacity-[0.03]"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
                  }}
                />

                {/* Noise texture */}
                <div
                  className="absolute inset-0 opacity-[0.015]"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
                  }}
                />

                {/* Corner accents */}
                <div
                  className="absolute top-0 left-0 w-32 h-32"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(0, 240, 255, 0.08) 0%, transparent 50%)",
                  }}
                />
                <div
                  className="absolute bottom-0 right-0 w-48 h-48"
                  style={{
                    background:
                      "linear-gradient(-45deg, rgba(255, 215, 0, 0.06) 0%, transparent 50%)",
                  }}
                />
              </div>

              {/* Two Column Layout - Centered Vertically */}
              <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center min-h-[calc(100vh-140px)]">
                {/* Left - Hero */}
                <div className="flex flex-col justify-center py-8">
                  <motion.div
                    className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full mb-8 w-fit"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(0, 240, 255, 0.15) 0%, rgba(0, 240, 255, 0.05) 100%)",
                      border: "1px solid rgba(0, 240, 255, 0.3)",
                      boxShadow:
                        "0 0 20px rgba(0, 240, 255, 0.15), inset 0 1px 0 rgba(255,255,255,0.1)",
                    }}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan shadow-lg shadow-cyan/50"></span>
                    </span>
                    <span className="text-sm font-medium text-cyan tracking-wide">
                      Live AI Analysis
                    </span>
                  </motion.div>

                  <motion.h1
                    className="font-serif text-5xl sm:text-6xl lg:text-7xl font-bold text-white mb-6 leading-[1.05]"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 }}
                    style={{ textShadow: "0 0 40px rgba(0, 240, 255, 0.15)" }}
                  >
                    <span className="block mb-2">8 AI Analysts.</span>
                    <span
                      className="bg-clip-text text-transparent"
                      style={{
                        backgroundImage:
                          "linear-gradient(135deg, #00f0ff 0%, #00d4e8 30%, #ffd700 70%, #ffb800 100%)",
                        textShadow: "none",
                      }}
                    >
                      One Verdict.
                    </span>
                  </motion.h1>

                  <motion.p
                    className="text-lg sm:text-xl text-slate-400 mb-10 max-w-lg leading-relaxed"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    Watch AI strategists with unique methodologies debate any
                    stock in real-time. Each manages a{" "}
                    <span className="text-gold font-semibold">
                      $100K portfolio
                    </span>
                    . The best thesis wins.
                  </motion.p>

                  <motion.div
                    className="mb-5"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15 }}
                  >
                    <TickerInput
                      onSelect={handleTickerSelect}
                      disabled={isLoading}
                    />
                  </motion.div>

                  <motion.div
                    className="flex flex-wrap items-center gap-2 mb-8"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    <span className="text-sm text-slate-600 mr-1">Try:</span>
                    {["NVDA", "AAPL", "TSLA", "MSFT", "GOOGL", "META"].map(
                      (t) => (
                        <button
                          key={t}
                          onClick={() => handleTickerSelect(t)}
                          disabled={isLoading}
                          className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all border ${
                            isLoading
                              ? "text-slate-600 bg-white/[0.02] border-white/[0.04] cursor-not-allowed"
                              : "text-slate-400 hover:text-cyan bg-white/[0.03] hover:bg-cyan/[0.08] border-white/[0.08] hover:border-cyan/40 hover:shadow-[0_0_15px_rgba(0,240,255,0.15)]"
                          }`}
                        >
                          {t}
                        </button>
                      )
                    )}
                  </motion.div>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 rounded-xl bg-bear/[0.1] border border-bear/20 mb-6"
                    >
                      <div className="flex items-start gap-3">
                        <span className="text-lg">⚠️</span>
                        <div>
                          <p className="text-sm text-bear-light font-semibold">
                            Error
                          </p>
                          <p className="text-sm text-slate-400">{error}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Feature highlights */}
                  <motion.div
                    className="flex flex-wrap gap-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.25 }}
                  >
                    {[
                      { icon: "⚔️", text: "Live Debates", color: "#00f0ff" },
                      {
                        icon: "📊",
                        text: "Technical Analysis",
                        color: "#ffd700",
                      },
                      {
                        icon: "🏆",
                        text: "Portfolio Tracking",
                        color: "#22c55e",
                      },
                    ].map((f) => (
                      <div
                        key={f.text}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg"
                        style={{
                          background: "rgba(255,255,255,0.02)",
                          border: `1px solid ${f.color}20`,
                          boxShadow: `0 0 15px ${f.color}08`,
                        }}
                      >
                        <span className="text-base">{f.icon}</span>
                        <span className="text-sm text-slate-400">{f.text}</span>
                      </div>
                    ))}
                  </motion.div>
                </div>

                {/* Right - Dashboard */}
                <div className="space-y-4">
                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    <Watchlist
                      key={`watchlist-${sidebarRefreshKey}`}
                      onSelectTicker={handleTickerSelect}
                      currentTicker={stockData?.ticker}
                    />
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 }}
                  >
                    <SavedAnalyses
                      key={`saved-${sidebarRefreshKey}`}
                      onLoadAnalysis={handleLoadAnalysis}
                    />
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.4 }}
                  >
                    <AccuracyTracker key={`accuracy-${sidebarRefreshKey}`} />
                  </motion.div>
                </div>
              </div>
            </motion.div>
          )}

          {isLoading && loadingInfo && (
            <motion.div
              key="loading"
              variants={pageTransition}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="max-w-7xl mx-auto pt-8"
              role="status"
              aria-live="polite"
              aria-label={`${loadingInfo.title}: ${loadingInfo.subtitle}`}
            >
              <LiveArena
                state={state}
                theses={theses}
                liveDebates={liveDebates}
                currentDebate={currentDebate}
                progress={progress}
                totalAnalysts={8}
                tournamentProgress={tournamentProgress}
              />
            </motion.div>
          )}

          {state === StockArenaState.COMPLETE &&
            stockData &&
            recommendation && (
              <motion.div
                key="results"
                variants={pageTransition}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="space-y-6"
              >
                <StockHeader
                  quote={stockData.quote}
                  profile={stockData.profile}
                />

                <div
                  className="flex gap-1 p-1 bg-arena-card/50 rounded-xl border border-white/[0.06] overflow-x-auto"
                  role="tablist"
                  aria-label="Analysis sections"
                >
                  {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    const tabClasses = [
                      "flex-1 min-w-[90px] px-3 py-2.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap",
                      isActive
                        ? "bg-cyan/15 text-cyan border border-cyan/20"
                        : "text-slate-400 hover:text-white hover:bg-white/[0.04]",
                    ].join(" ");

                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        role="tab"
                        aria-selected={isActive}
                        aria-controls={`${tab.id}-panel`}
                        className={tabClasses}
                      >
                        <span className="mr-1.5" aria-hidden="true">
                          {tab.icon}
                        </span>
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
                <AnimatePresence mode="wait">
                  {activeTab === "analysis" && (
                    <motion.div
                      key="analysis-tab"
                      id="analysis-panel"
                      role="tabpanel"
                      aria-labelledby="analysis-tab"
                      variants={pageTransition}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      className="space-y-8"
                    >
                      <RecommendationCard
                        recommendation={recommendation}
                        onExecuteTrades={() => setShowTradingView(true)}
                        tradingPreview={tradingPreview}
                        tradingPreviewError={tradingPreviewError}
                      />
                      <div className="grid md:grid-cols-2 gap-6">
                        <ArgumentsPanel
                          title="Bull Case"
                          icon="📈"
                          arguments={recommendation.topBullArguments}
                          variant="bull"
                        />
                        <ArgumentsPanel
                          title="Bear Case"
                          icon="📉"
                          arguments={recommendation.topBearArguments}
                          variant="bear"
                        />
                      </div>
                      <section>
                        <SectionHeader
                          title="Analyst Perspectives"
                          count={theses.length}
                        />
                        <motion.div
                          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4"
                          variants={staggerContainer}
                          initial="hidden"
                          animate="visible"
                        >
                          {theses.map((thesis) => (
                            <motion.div
                              key={thesis.agentId}
                              variants={staggerItem}
                            >
                              <AnalystCard
                                thesis={thesis}
                                isWinner={
                                  tournamentResult?.champion?.agentId ===
                                  thesis.agentId
                                }
                              />
                            </motion.div>
                          ))}
                        </motion.div>
                      </section>
                      {tournamentResult &&
                        tournamentResult.allDebates.length > 0 && (
                          <section>
                            <SectionHeader
                              title="Debate Tournament"
                              count={tournamentResult.allDebates.length}
                            />
                            <div className="space-y-4">
                              {tournamentResult.allDebates.map((debate) => (
                                <DebateView
                                  key={debate.matchId}
                                  debate={debate}
                                />
                              ))}
                            </div>
                          </section>
                        )}
                      {recommendation.dissentingViews.length > 0 && (
                        <section>
                          <SectionHeader title="Dissenting Views" />
                          <div className="glass-card rounded-2xl p-6 border-l-4 border-gold">
                            <div className="space-y-4">
                              {recommendation.dissentingViews.map((view, i) => (
                                <div key={i} className="flex gap-4">
                                  <div className="w-1 bg-gold/50 rounded-full flex-shrink-0" />
                                  <div>
                                    <div className="text-gold font-semibold mb-1">
                                      {view.agentName} — {view.position}
                                    </div>
                                    <div className="text-slate-400 text-sm leading-relaxed">
                                      {view.reasoning}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </section>
                      )}
                    </motion.div>
                  )}
                  {activeTab === "charts" && (
                    <motion.div
                      key="charts-tab"
                      id="charts-panel"
                      role="tabpanel"
                      aria-labelledby="charts-tab"
                      variants={pageTransition}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <PriceChart
                        data={stockData.historicalData}
                        currentPrice={stockData.quote.price}
                      />
                    </motion.div>
                  )}
                  {activeTab === "technicals" && (
                    <motion.div
                      key="technicals-tab"
                      id="technicals-panel"
                      role="tabpanel"
                      aria-labelledby="technicals-tab"
                      variants={pageTransition}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <TechnicalsCard
                        technicals={stockData.technicals}
                        currentPrice={stockData.quote.price}
                      />
                    </motion.div>
                  )}
                  {activeTab === "news" && (
                    <motion.div
                      key="news-tab"
                      id="news-panel"
                      role="tabpanel"
                      aria-labelledby="news-tab"
                      variants={pageTransition}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <NewsCard sentiment={stockData.sentiment} />
                    </motion.div>
                  )}
                  {activeTab === "trading" && (
                    <motion.div
                      key="trading-tab"
                      id="trading-panel"
                      role="tabpanel"
                      aria-labelledby="trading-tab"
                      variants={pageTransition}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <TradingDashboard />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
        </AnimatePresence>

        {/* Modals */}
        <AnimatePresence>
          {showCompare && (
            <CompareStocks onClose={() => setShowCompare(false)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showTradingView && stockData && tournamentResult && (
            <ErrorBoundary>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
                onClick={(e) => {
                  // Use data attribute for more robust detection
                  const target = e.target as HTMLElement;
                  if (target.dataset.modalBackdrop === "true") {
                    setShowTradingView(false);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowTradingView(false);
                  }
                }}
                tabIndex={-1}
                data-modal-backdrop="true"
              >
                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  className="max-w-6xl w-full max-h-[90vh] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="trading-modal-title"
                >
                  <PostAnalysisTradingView
                    ticker={stockData.ticker}
                    currentPrice={stockData.quote.price}
                    priceTimestamp={stockData.quote.timestamp || Date.now()}
                    theses={theses}
                    debates={tournamentResult.allDebates}
                    onContinue={() => setShowTradingView(false)}
                    onViewPortfolios={() => {
                      setShowTradingView(false);
                      setActiveTab("trading");
                    }}
                  />
                </motion.div>
              </motion.div>
            </ErrorBoundary>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

const HeaderButton: React.FC<{
  onClick: () => void;
  icon: string;
  label: string;
  variant?: "default" | "ghost";
}> = ({ onClick, icon, label, variant = "default" }) => (
  <motion.button
    onClick={onClick}
    aria-label={label}
    className={`px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
      variant === "ghost"
        ? "text-slate-400 hover:text-white hover:bg-white/[0.06]"
        : "text-slate-300 hover:text-white border border-white/[0.08] hover:border-white/[0.15] bg-white/[0.03]"
    }`}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
  >
    <span aria-hidden="true" className="text-sm">
      {icon}
    </span>
    <span className="hidden sm:inline">{label}</span>
  </motion.button>
);

const SectionHeader: React.FC<{ title: string; count?: number }> = ({
  title,
  count,
}) => (
  <div className="flex items-center gap-3 mb-5">
    <h2 className="text-lg font-serif font-semibold text-white">{title}</h2>
    {count !== undefined && (
      <span className="px-2 py-0.5 text-[10px] font-semibold rounded-md bg-white/[0.06] text-slate-400 border border-white/[0.04]">
        {count}
      </span>
    )}
    <div className="flex-1 h-px bg-gradient-to-r from-white/[0.08] to-transparent" />
  </div>
);

const ArgumentsPanel: React.FC<{
  title: string;
  icon: string;
  arguments: string[];
  variant: "bull" | "bear";
}> = ({ title, icon, arguments: args, variant }) => {
  const styles = {
    bull: {
      bg: "bg-bull/[0.08]",
      border: "border-bull/20",
      text: "text-bull-light",
      dot: "bg-bull",
      iconBg: "bg-bull/20",
    },
    bear: {
      bg: "bg-bear/[0.08]",
      border: "border-bear/20",
      text: "text-bear-light",
      dot: "bg-bear",
      iconBg: "bg-bear/20",
    },
  };
  const s = styles[variant];
  return (
    <motion.div
      className={`${s.bg} ${s.border} border rounded-xl p-5`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className={`flex items-center gap-2.5 ${s.text} font-semibold mb-4`}>
        <span
          className={`w-8 h-8 rounded-lg ${s.iconBg} flex items-center justify-center text-base`}
        >
          {icon}
        </span>
        <span className="text-base">{title}</span>
      </div>
      <ul className="space-y-2.5">
        {args.map((arg, i) => (
          <li
            key={i}
            className="flex gap-2.5 text-sm text-slate-300 leading-relaxed"
          >
            <span
              className={`w-1.5 h-1.5 ${s.dot} rounded-full mt-1.5 flex-shrink-0 opacity-70`}
            />
            <span>{arg}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  );
};

export default StockArena;
