/**
 * Stock Arena - Main Orchestration Component
 * Strategic Arena Theme - Premium UI/UX
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
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

interface StockArenaProps {
  apiKey: string;
}

type ActiveTab = "analysis" | "charts" | "technicals" | "news";

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

export const StockArena: React.FC<StockArenaProps> = ({ apiKey }) => {
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

  const handleTickerSelect = useCallback(
    async (ticker: string) => {
      setError(null);
      setStockData(null);
      setTheses([]);
      setTournamentResult(null);
      setRecommendation(null);

      try {
        if (!isMountedRef.current) return;
        setState(StockArenaState.FETCHING_DATA);
        setProgress("Connecting to data sources...");

        const data = await fetchAllStockData(ticker);
        if (!isMountedRef.current) return;
        setStockData(data);

        setState(StockArenaState.GENERATING_ANALYSTS);
        const { theses: generatedTheses, errors } = await generateAllTheses(
          apiKey,
          data,
          {
            onProgress: (completed, total, analyst) => {
              if (isMountedRef.current)
                setProgress(`${analyst} (${completed}/${total})`);
            },
            onThesisComplete: (thesis) => {
              if (isMountedRef.current) {
                setTheses((prev) => [...prev, thesis]);
              }
            },
          }
        );

        if (!isMountedRef.current) return;
        if (generatedTheses.length === 0)
          throw new Error("Failed to generate analyst theses");

        // Don't set theses again - already set incrementally via onThesisComplete
        // This prevents duplicate entries
        // setTheses(generatedTheses);
        if (errors.length > 0) console.warn("Analyst errors:", errors);

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
      } catch (err) {
        if (!isMountedRef.current) return;
        setError(err instanceof Error ? err.message : "An error occurred");
        setState(StockArenaState.ERROR);
        setProgress("");
        // Clear all analysis state on error to prevent partial/stale data
        setTheses([]);
        setLiveDebates([]);
        setCurrentDebate(null);
        setTournamentProgress(null);
      }
    },
    [apiKey]
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
  };

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
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-arena-deep/90 backdrop-blur-xl">
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
            </div>
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
      >
        <AnimatePresence mode="wait">
          {(state === StockArenaState.IDLE ||
            state === StockArenaState.ERROR) && (
            <motion.div
              key="idle"
              variants={pageTransition}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid lg:grid-cols-[1fr_340px] gap-8"
            >
              <div className="pt-8 lg:pt-16">
                <motion.div
                  className="text-center mb-12"
                  variants={staggerContainer}
                  initial="hidden"
                  animate="visible"
                >
                  <motion.h1
                    className="font-serif text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-4 tracking-tight"
                    variants={staggerItem}
                  >
                    Analyze Any Stock
                  </motion.h1>
                  <motion.p
                    className="text-lg sm:text-xl text-slate-400 max-w-xl mx-auto"
                    variants={staggerItem}
                  >
                    8 AI strategists will debate and deliver their verdict
                  </motion.p>
                </motion.div>
                <motion.div
                  className="max-w-2xl mx-auto"
                  variants={staggerItem}
                >
                  <TickerInput
                    onSelect={handleTickerSelect}
                    disabled={isLoading}
                  />
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 p-5 rounded-2xl bg-bear-muted border border-bear/20"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="text-2xl flex-shrink-0"
                          role="img"
                          aria-label="Error"
                        >
                          ⚠️
                        </span>
                        <div className="flex-1 text-left">
                          <h3 className="text-bear-light font-semibold mb-2">
                            Unable to Fetch Data
                          </h3>
                          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                            {error}
                          </p>
                          <div className="mt-4 pt-4 border-t border-bear/20">
                            <p className="text-xs text-slate-500 mb-2">
                              Quick troubleshooting:
                            </p>
                            <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                              <li>Verify the ticker symbol is correct</li>
                              <li>Try again in a few seconds (rate limits)</li>
                              <li>Check your internet connection</li>
                              <li>
                                Consider getting a free FMP API key for better
                                reliability
                              </li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                  <motion.div
                    className="mt-12 text-center"
                    variants={staggerItem}
                  >
                    <p className="text-sm text-slate-500 mb-4 font-medium tracking-wide">
                      POPULAR PICKS
                    </p>
                    <div className="flex justify-center gap-2 sm:gap-3 flex-wrap">
                      {["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL", "AMZN"].map(
                        (t, i) => (
                          <motion.button
                            key={t}
                            onClick={() => handleTickerSelect(t)}
                            className="px-4 py-2 text-sm text-slate-400 bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 hover:border-white/10 rounded-xl transition-all font-medium"
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.05 }}
                          >
                            {t}
                          </motion.button>
                        )
                      )}
                    </div>
                  </motion.div>
                </motion.div>
              </div>
              <motion.div
                className="space-y-4"
                variants={staggerContainer}
                initial="hidden"
                animate="visible"
              >
                <motion.div variants={staggerItem}>
                  <Watchlist
                    key={`watchlist-${sidebarRefreshKey}`}
                    onSelectTicker={handleTickerSelect}
                    currentTicker={stockData?.ticker}
                  />
                </motion.div>
                <motion.div variants={staggerItem}>
                  <SavedAnalyses
                    key={`saved-${sidebarRefreshKey}`}
                    onLoadAnalysis={handleLoadAnalysis}
                  />
                </motion.div>
                <motion.div variants={staggerItem}>
                  <AccuracyTracker key={`accuracy-${sidebarRefreshKey}`} />
                </motion.div>
              </motion.div>
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
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      aria-controls={`${tab.id}-panel`}
                      className={`flex-1 min-w-[90px] px-3 py-2.5 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                        activeTab === tab.id
                          ? "bg-cyan/15 text-cyan border border-cyan/20"
                          : "text-slate-400 hover:text-white hover:bg-white/[0.04]"
                      }`}
                    >
                      <span className="mr-1.5" aria-hidden="true">
                        {tab.icon}
                      </span>
                      {tab.label}
                    </button>
                  ))}
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
                      <RecommendationCard recommendation={recommendation} />
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
                </AnimatePresence>
              </motion.div>
            )}
        </AnimatePresence>
        <AnimatePresence>
          {showCompare && (
            <CompareStocks onClose={() => setShowCompare(false)} />
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
