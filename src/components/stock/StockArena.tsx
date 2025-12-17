/**
 * Stock Arena - Main Component
 * Premium dark theme orchestration
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  StockAnalysisData,
  InvestmentThesis,
  FinalRecommendation,
  StockArenaState,
} from "../../types/stock";
import {
  fetchAllStockData,
  generateAllTheses,
  runTournament,
  generateFinalRecommendation,
  TournamentResult,
} from "../../services/stock";
import { TickerInput } from "./TickerInput";
import { StockHeader } from "./StockHeader";
import { AnalystCard } from "./AnalystCard";
import { RecommendationCard } from "./RecommendationCard";
import { DebateView } from "./DebateView";

interface StockArenaProps {
  apiKey: string;
}

const LOADING_STATES = {
  [StockArenaState.FETCHING_DATA]: {
    icon: "📡",
    title: "Fetching Market Data",
    subtitle: "Connecting to financial data sources...",
  },
  [StockArenaState.GENERATING_ANALYSTS]: {
    icon: "🧠",
    title: "Analysts Forming Opinions",
    subtitle: "Each analyst is studying the data...",
  },
  [StockArenaState.RUNNING_TOURNAMENT]: {
    icon: "⚔️",
    title: "Debate Tournament",
    subtitle: "Bulls vs Bears in heated discussion...",
  },
  [StockArenaState.GENERATING_RECOMMENDATION]: {
    icon: "🎯",
    title: "Synthesizing Verdict",
    subtitle: "Combining insights into final recommendation...",
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

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
        setProgress("Connecting to Yahoo Finance...");

        const data = await fetchAllStockData(ticker);
        if (!isMountedRef.current) return;
        setStockData(data);

        setState(StockArenaState.GENERATING_ANALYSTS);
        const { theses: generatedTheses, errors } = await generateAllTheses(
          apiKey,
          data,
          {
            onProgress: (completed, total, analyst) => {
              if (isMountedRef.current) {
                setProgress(`${analyst} (${completed}/${total})`);
              }
            },
          }
        );

        if (!isMountedRef.current) return;
        if (generatedTheses.length === 0) {
          throw new Error("Failed to generate analyst theses");
        }

        setTheses(generatedTheses);
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
            }
          },
          onDebateComplete: (debate) => {
            if (!isMountedRef.current) return;
            setTournamentResult((prev) => {
              if (!prev) {
                return {
                  quarterfinals:
                    debate.round === "quarterfinal" ? [debate] : [],
                  semifinals: debate.round === "semifinal" ? [debate] : [],
                  final: debate.round === "final" ? debate : null,
                  champion: null,
                  allDebates: [debate],
                };
              }
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
  };

  const isLoading =
    state !== StockArenaState.IDLE &&
    state !== StockArenaState.COMPLETE &&
    state !== StockArenaState.ERROR;
  const loadingInfo = LOADING_STATES[state as keyof typeof LOADING_STATES];

  return (
    <div className="min-h-screen bg-void">
      <div className="absolute inset-0 bg-grid opacity-30" />

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-surface/50 backdrop-blur-xl sticky top-0">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚔️</span>
            <span className="font-serif text-xl font-semibold text-white">
              Hypothesis Arena
            </span>
          </div>
          {state === StockArenaState.COMPLETE && (
            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white border border-white/10 hover:border-white/20 rounded-lg transition-all"
            >
              ← New Analysis
            </button>
          )}
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-8">
        {/* Idle State - Ticker Input */}
        {(state === StockArenaState.IDLE ||
          state === StockArenaState.ERROR) && (
          <div className="max-w-2xl mx-auto pt-20">
            <div className="text-center mb-12">
              <h1 className="font-serif text-5xl font-bold text-white mb-4">
                Analyze Any Stock
              </h1>
              <p className="text-xl text-slate-400">
                8 AI analysts will debate and deliver a verdict
              </p>
            </div>

            <TickerInput onSelect={handleTickerSelect} disabled={isLoading} />

            {error && (
              <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-center">
                {error}
              </div>
            )}

            {/* Popular tickers */}
            <div className="mt-12 text-center">
              <p className="text-sm text-slate-600 mb-4">Popular picks</p>
              <div className="flex justify-center gap-3 flex-wrap">
                {["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL", "AMZN"].map((t) => (
                  <button
                    key={t}
                    onClick={() => handleTickerSelect(t)}
                    className="px-4 py-2 text-sm text-slate-400 bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 rounded-lg transition-all"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Loading State */}
        {isLoading && loadingInfo && (
          <div className="max-w-lg mx-auto pt-32 text-center">
            <div className="relative inline-block mb-8">
              <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-electric-cyan/20 to-acid-purple/20 border border-white/10 flex items-center justify-center">
                <span className="text-5xl animate-pulse">
                  {loadingInfo.icon}
                </span>
              </div>
              <div className="absolute -inset-4 border border-electric-cyan/20 rounded-3xl animate-ping opacity-20" />
            </div>
            <h2 className="text-2xl font-semibold text-white mb-2">
              {loadingInfo.title}
            </h2>
            <p className="text-slate-500 mb-4">{loadingInfo.subtitle}</p>
            <div className="inline-block px-4 py-2 rounded-full bg-white/5 text-sm text-electric-cyan">
              {progress}
            </div>
          </div>
        )}

        {/* Results */}
        {state === StockArenaState.COMPLETE && stockData && recommendation && (
          <div className="space-y-8">
            <StockHeader quote={stockData.quote} profile={stockData.profile} />

            <RecommendationCard recommendation={recommendation} />

            {/* Bull vs Bear Arguments */}
            <div className="grid md:grid-cols-2 gap-6">
              <ArgumentsPanel
                title="Bull Case"
                icon="📈"
                arguments={recommendation.topBullArguments}
                accentColor="emerald"
              />
              <ArgumentsPanel
                title="Bear Case"
                icon="📉"
                arguments={recommendation.topBearArguments}
                accentColor="red"
              />
            </div>

            {/* Analysts */}
            <section>
              <SectionHeader
                title="Analyst Perspectives"
                count={theses.length}
              />
              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                {theses.map((thesis) => (
                  <AnalystCard
                    key={thesis.agentId}
                    thesis={thesis}
                    isWinner={
                      tournamentResult?.champion?.agentId === thesis.agentId
                    }
                  />
                ))}
              </div>
            </section>

            {/* Debates */}
            {tournamentResult && tournamentResult.allDebates.length > 0 && (
              <section>
                <SectionHeader
                  title="Debate Tournament"
                  count={tournamentResult.allDebates.length}
                />
                <div className="space-y-4">
                  {tournamentResult.allDebates.map((debate) => (
                    <DebateView key={debate.matchId} debate={debate} />
                  ))}
                </div>
              </section>
            )}

            {/* Dissenting Views */}
            {recommendation.dissentingViews.length > 0 && (
              <section>
                <SectionHeader title="Dissenting Views" />
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-6">
                  <div className="space-y-4">
                    {recommendation.dissentingViews.map((view, i) => (
                      <div key={i} className="flex gap-4">
                        <div className="w-1 bg-amber-500/50 rounded-full" />
                        <div>
                          <div className="text-amber-400 font-medium mb-1">
                            {view.agentName} — {view.position}
                          </div>
                          <div className="text-slate-400 text-sm">
                            {view.reasoning}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

const SectionHeader: React.FC<{ title: string; count?: number }> = ({
  title,
  count,
}) => (
  <div className="flex items-center gap-3 mb-6">
    <h2 className="text-xl font-semibold text-white">{title}</h2>
    {count !== undefined && (
      <span className="px-2 py-0.5 text-xs rounded-full bg-white/5 text-slate-500">
        {count}
      </span>
    )}
    <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
  </div>
);

const ArgumentsPanel: React.FC<{
  title: string;
  icon: string;
  arguments: string[];
  accentColor: "emerald" | "red";
}> = ({ title, icon, arguments: args, accentColor }) => {
  const colors = {
    emerald: {
      bg: "bg-emerald-500/5",
      border: "border-emerald-500/20",
      text: "text-emerald-400",
      dot: "bg-emerald-500",
    },
    red: {
      bg: "bg-red-500/5",
      border: "border-red-500/20",
      text: "text-red-400",
      dot: "bg-red-500",
    },
  };
  const c = colors[accentColor];

  return (
    <div className={`${c.bg} ${c.border} border rounded-2xl p-6`}>
      <div className={`flex items-center gap-2 ${c.text} font-semibold mb-4`}>
        <span>{icon}</span>
        <span>{title}</span>
      </div>
      <ul className="space-y-3">
        {args.map((arg, i) => (
          <li key={i} className="flex gap-3 text-sm text-slate-300">
            <span
              className={`w-1.5 h-1.5 ${c.dot} rounded-full mt-2 flex-shrink-0`}
            />
            <span>{arg}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default StockArena;
