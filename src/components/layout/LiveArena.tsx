/**
 * Live Arena Component - Cinematic Live Streaming Experience
 * Premium real-time visualization of thesis generation and debates
 */

import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  InvestmentThesis,
  StockDebate,
  StockArenaState,
} from "../../types/stock";
import { AnalystCard } from "../analysis";

interface LiveArenaProps {
  state: StockArenaState;
  theses: InvestmentThesis[];
  liveDebates: StockDebate[];
  currentDebate: StockDebate | null;
  progress: string;
  totalAnalysts: number;
  tournamentProgress: {
    round: string;
    matchNumber: number;
    totalMatches: number;
  } | null;
}

export const LiveArena: React.FC<LiveArenaProps> = ({
  state,
  theses,
  liveDebates,
  currentDebate,
  progress,
  totalAnalysts,
  tournamentProgress,
}) => {
  const debateRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Detect reduced motion preference
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Keyboard shortcuts - memoized to avoid re-creating on every render
  useEffect(() => {
    // Only add listener if we're in tournament phase
    if (state !== StockArenaState.RUNNING_TOURNAMENT) {
      return;
    }

    const handleKeyPress = (e: KeyboardEvent) => {
      // Space to pause/resume auto-scroll (future enhancement)
      if (e.code === "Space" && currentDebate) {
        e.preventDefault();
        // Could add pause functionality here
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [state, currentDebate]);

  // Auto-scroll to current debate with debounce
  useEffect(() => {
    // Clear any pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Debounce scroll to avoid excessive scrolling
    if (debateRef.current && currentDebate) {
      scrollTimeoutRef.current = setTimeout(() => {
        debateRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 300);
    }

    // Cleanup
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [currentDebate?.matchId]);

  return (
    <div className="relative" role="region" aria-label="Live Analysis Arena">
      {/* Phase 0: Data Fetching */}
      {state === StockArenaState.FETCHING_DATA && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="max-w-lg mx-auto pt-24 sm:pt-32 text-center"
        >
          <motion.div
            className="relative inline-block mb-8"
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-arena-card to-arena-surface border border-white/10 flex items-center justify-center shadow-glow-cyan">
              <span className="text-6xl" role="img" aria-label="Satellite">
                📡
              </span>
            </div>
            <div className="absolute -inset-6 border border-cyan/20 rounded-[2rem] animate-ping opacity-20" />
          </motion.div>
          <h2 className="text-2xl sm:text-3xl font-serif font-bold text-white mb-3">
            Gathering Intelligence
          </h2>
          <p className="text-slate-400 mb-6">
            Connecting to market data sources...
          </p>
          <motion.div
            className="inline-block px-5 py-2.5 rounded-full bg-gradient-to-r from-cyan/10 to-cyan/5 border border-cyan/20 text-sm text-cyan font-medium shadow-lg shadow-cyan/10"
            animate={{ opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            {progress || "Fetching stock data..."}
          </motion.div>
        </motion.div>
      )}

      {/* Phase 1: Analyst Generation Stage */}
      {state === StockArenaState.GENERATING_ANALYSTS && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="space-y-8"
        >
          {/* Stage Header */}
          <div className="text-center">
            <motion.div
              className="inline-flex items-center gap-3 px-6 py-3 rounded-2xl bg-gradient-to-r from-cyan/10 via-cyan/5 to-cyan/10 border border-cyan/20 mb-4"
              animate={{
                boxShadow: [
                  "0 0 20px rgba(6, 182, 212, 0.2)",
                  "0 0 40px rgba(6, 182, 212, 0.4)",
                  "0 0 20px rgba(6, 182, 212, 0.2)",
                ],
              }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <span className="text-2xl" role="img" aria-label="Brain">
                🧠
              </span>
              <div className="text-left">
                <div className="text-sm font-bold text-cyan">
                  Analysts Entering Arena
                </div>
                <div className="text-xs text-slate-400">
                  {theses.length} of {totalAnalysts} strategists ready
                </div>
              </div>
            </motion.div>
            {/* Estimated time remaining */}
            {theses.length > 0 && theses.length < totalAnalysts && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-xs text-slate-500 mt-2"
                key={`time-${theses.length}`}
              >
                Estimated time: ~
                {Math.max(
                  0,
                  Math.ceil((totalAnalysts - theses.length) / 4) * 3
                )}
                s remaining
              </motion.p>
            )}
          </div>

          {/* Completion message - only show briefly before tournament starts */}
          {theses.length === totalAnalysts &&
            state === StockArenaState.GENERATING_ANALYSTS && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="text-center mb-4"
              >
                <div
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-bull/10 border border-bull/20"
                  role="status"
                  aria-live="polite"
                >
                  <span className="text-lg" role="img" aria-label="Check mark">
                    ✅
                  </span>
                  <span className="text-sm font-semibold text-bull-light">
                    All analysts ready! Starting tournament...
                  </span>
                </div>
              </motion.div>
            )}

          {/* Analyst Grid - 8 Slots */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-5xl mx-auto">
            {Array.from({ length: totalAnalysts }).map((_, index) => {
              const thesis = theses[index];
              // Calculate how many are currently being generated (concurrency=4)
              const remainingSlots = totalAnalysts - theses.length;
              const loadingCount = Math.min(remainingSlots, 4);
              const isActive =
                index >= theses.length && index < theses.length + loadingCount;
              const isEmpty = !thesis;

              return (
                <motion.div
                  key={index}
                  className="relative"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  {isEmpty ? (
                    // Empty Slot
                    <div
                      className={`aspect-square rounded-2xl border-2 border-dashed flex items-center justify-center relative overflow-hidden ${
                        isActive
                          ? "border-cyan/40 bg-cyan/5"
                          : "border-white/10 bg-white/[0.02]"
                      }`}
                    >
                      {isActive && (
                        <>
                          {/* Pulsing Spotlight */}
                          <motion.div
                            className="absolute inset-0 bg-gradient-radial from-cyan/20 to-transparent"
                            animate={{
                              opacity: [0.3, 0.6, 0.3],
                              scale: [0.8, 1.2, 0.8],
                            }}
                            transition={{ duration: 2, repeat: Infinity }}
                          />
                          {/* Loading Ring */}
                          <motion.div
                            className="w-16 h-16 rounded-full border-4 border-cyan/20 border-t-cyan"
                            animate={{ rotate: 360 }}
                            transition={{
                              duration: 1,
                              repeat: Infinity,
                              ease: "linear",
                            }}
                          />
                        </>
                      )}
                      {!isActive && (
                        <div
                          className="text-4xl opacity-20"
                          role="img"
                          aria-label="Waiting"
                        >
                          💭
                        </div>
                      )}
                    </div>
                  ) : (
                    // Filled Slot with Simple Entrance Animation
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.4,
                        ease: "easeOut",
                      }}
                    >
                      <AnalystCard thesis={thesis} isWinner={false} />
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>

          {/* Current Analyst Being Generated */}
          {progress && (
            <motion.div
              className="text-center space-y-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-white/10"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <motion.div
                  className="w-2 h-2 bg-cyan rounded-full"
                  animate={
                    prefersReducedMotion
                      ? {}
                      : { scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }
                  }
                  transition={{ duration: 1, repeat: Infinity }}
                />
                <span className="text-sm text-slate-300">{progress}</span>
              </div>
              {/* Helpful tip */}
              <p className="text-xs text-slate-600 max-w-md mx-auto">
                Each analyst is analyzing market data, fundamentals, and
                technicals to form their unique perspective
              </p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* Phase 2 & 3: Tournament Bracket + Live Debate */}
      {state === StockArenaState.RUNNING_TOURNAMENT && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="space-y-8"
        >
          {/* Tournament Progress Header */}
          {tournamentProgress && (
            <div className="text-center">
              <motion.div
                className="inline-flex items-center gap-3 px-6 py-3 rounded-2xl bg-gradient-to-r from-bear/10 via-gold/10 to-bull/10 border border-gold/30 mb-4"
                animate={{
                  boxShadow: [
                    "0 0 20px rgba(251, 191, 36, 0.2)",
                    "0 0 40px rgba(251, 191, 36, 0.4)",
                    "0 0 20px rgba(251, 191, 36, 0.2)",
                  ],
                }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <span
                  className="text-2xl"
                  role="img"
                  aria-label="Crossed swords"
                >
                  ⚔️
                </span>
                <div className="text-left">
                  <div className="text-sm font-bold text-gold-light">
                    {tournamentProgress.round.charAt(0).toUpperCase() +
                      tournamentProgress.round.slice(1)}{" "}
                    - Match {tournamentProgress.matchNumber}/
                    {tournamentProgress.totalMatches}
                  </div>
                  <div className="text-xs text-slate-400">
                    Battle in progress...
                  </div>
                </div>
              </motion.div>
              {/* Progress indicator */}
              <div
                className="flex justify-center gap-2 mt-3"
                role="progressbar"
                aria-valuenow={tournamentProgress.matchNumber}
                aria-valuemin={1}
                aria-valuemax={tournamentProgress.totalMatches}
                aria-label={`Match ${tournamentProgress.matchNumber} of ${tournamentProgress.totalMatches}`}
              >
                {Array.from({ length: tournamentProgress.totalMatches }).map(
                  (_, i) => (
                    <div
                      key={i}
                      className={`h-1 rounded-full transition-all duration-300 ${
                        i < tournamentProgress.matchNumber
                          ? "w-8 bg-gold"
                          : i === tournamentProgress.matchNumber - 1
                          ? "w-12 bg-gold animate-pulse"
                          : "w-6 bg-white/20"
                      }`}
                      aria-hidden="true"
                    />
                  )
                )}
              </div>
            </div>
          )}

          {/* Tournament Bracket Visualization */}
          <TournamentBracket
            debates={liveDebates}
            currentDebate={currentDebate}
          />

          {/* Live Debate Arena - Full Focus */}
          {currentDebate && (
            <motion.div
              ref={debateRef}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.5 }}
              className="max-w-4xl mx-auto"
            >
              <LiveDebateCard debate={currentDebate} />
            </motion.div>
          )}

          {/* Completed Debates - Minimized */}
          {liveDebates.length > 1 && currentDebate && (
            <motion.div
              className="max-w-4xl mx-auto"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              <div className="text-xs text-slate-500 font-semibold mb-3 text-center flex items-center justify-center gap-2">
                <span>COMPLETED MATCHES</span>
                <span className="px-2 py-0.5 rounded-full bg-white/[0.05] text-[10px]">
                  {
                    liveDebates.filter(
                      (d) => d.matchId !== currentDebate.matchId
                    ).length
                  }
                </span>
              </div>
              <div className="space-y-2">
                {liveDebates
                  .filter((d) => d.matchId !== currentDebate.matchId)
                  .map((debate) => (
                    <CompletedDebateCard key={debate.matchId} debate={debate} />
                  ))}
              </div>
            </motion.div>
          )}
        </motion.div>
      )}
    </div>
  );
};

// Tournament Bracket Visualization
const TournamentBracket: React.FC<{
  debates: StockDebate[];
  currentDebate: StockDebate | null;
}> = ({ debates, currentDebate }) => {
  const quarters = debates.filter((d) => d.round === "quarterfinal");
  const semis = debates.filter((d) => d.round === "semifinal");
  const final = debates.find((d) => d.round === "final");

  // Don't render bracket if no debates yet
  if (debates.length === 0) {
    return null;
  }

  return (
    <motion.div
      className="max-w-6xl mx-auto mb-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="glass-card rounded-2xl p-6 border border-white/10">
        <div className="text-center mb-6">
          <h3 className="text-lg font-serif font-bold text-white mb-1">
            Tournament Bracket
          </h3>
          <p className="text-xs text-slate-500 mb-2">
            Live progression through the arena
          </p>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <span className="text-[10px] text-slate-600">
              💡 Active match is highlighted in cyan
            </span>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-4 items-center">
          {/* Quarterfinals */}
          <div className="space-y-2">
            <div className="text-[10px] text-slate-500 font-bold text-center mb-2">
              QUARTERS
            </div>
            {quarters.length > 0 ? (
              quarters.map((debate) => (
                <BracketMatch
                  key={debate.matchId}
                  debate={debate}
                  isActive={currentDebate?.matchId === debate.matchId}
                  size="sm"
                />
              ))
            ) : (
              <div className="text-xs text-slate-600 text-center py-4">
                Waiting for matches...
              </div>
            )}
          </div>

          {/* Connector Lines */}
          <div className="flex flex-col gap-8 items-center">
            {quarters.length >= 2 &&
              [0, 1].map((i) => (
                <svg
                  key={i}
                  width="40"
                  height="60"
                  className="text-white/20"
                  viewBox="0 0 40 60"
                >
                  <path
                    d="M 0 15 L 20 15 L 20 45 L 40 45"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                  />
                </svg>
              ))}
          </div>

          {/* Semifinals */}
          <div className="space-y-8">
            <div className="text-[10px] text-slate-500 font-bold text-center mb-2">
              SEMIS
            </div>
            {semis.length > 0 ? (
              semis.map((debate) => (
                <BracketMatch
                  key={debate.matchId}
                  debate={debate}
                  isActive={currentDebate?.matchId === debate.matchId}
                  size="md"
                />
              ))
            ) : (
              <div className="h-20 rounded-lg border-2 border-dashed border-white/10 flex items-center justify-center">
                <span className="text-xs text-slate-600">TBD</span>
              </div>
            )}
          </div>

          {/* Connector to Final */}
          <div className="flex items-center">
            <svg width="40" height="100" className="text-white/20">
              <path
                d="M 0 25 L 20 25 L 20 75 L 40 75"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
              />
            </svg>
          </div>

          {/* Final */}
          <div className="space-y-2">
            <div className="text-[10px] text-gold font-bold text-center mb-2">
              🏆 FINAL
            </div>
            {final ? (
              <BracketMatch
                debate={final}
                isActive={currentDebate?.matchId === final.matchId}
                size="lg"
              />
            ) : (
              <div className="h-20 rounded-lg border-2 border-dashed border-white/10 flex items-center justify-center">
                <span className="text-xs text-slate-600">TBD</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

// Bracket Match Card
const BracketMatch: React.FC<{
  debate: StockDebate;
  isActive: boolean;
  size: "sm" | "md" | "lg";
}> = ({ debate, isActive, size }) => {
  const sizeClasses = {
    sm: "p-2 text-[10px]",
    md: "p-2.5 text-xs",
    lg: "p-3 text-sm",
  };

  const bullWon = debate.winner === "bull";

  return (
    <motion.div
      className={`rounded-lg border ${sizeClasses[size]} ${
        isActive
          ? "border-cyan bg-cyan/10 shadow-lg shadow-cyan/20"
          : "border-white/10 bg-white/[0.02]"
      }`}
      animate={
        isActive
          ? {
              boxShadow: [
                "0 0 10px rgba(6, 182, 212, 0.3)",
                "0 0 20px rgba(6, 182, 212, 0.5)",
                "0 0 10px rgba(6, 182, 212, 0.3)",
              ],
            }
          : {}
      }
      transition={{ duration: 1.5, repeat: Infinity }}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={`flex items-center gap-1 ${
            bullWon ? "opacity-100" : "opacity-40"
          }`}
        >
          <span>{debate.bullAnalyst.avatarEmoji}</span>
          {bullWon && <span className="text-[8px]">🏆</span>}
        </div>
        <span className="text-[8px] text-slate-600">VS</span>
        <div
          className={`flex items-center gap-1 ${
            !bullWon ? "opacity-100" : "opacity-40"
          }`}
        >
          {!bullWon && <span className="text-[8px]">🏆</span>}
          <span>{debate.bearAnalyst.avatarEmoji}</span>
        </div>
      </div>
    </motion.div>
  );
};

// Live Debate Card - Full Featured
const LiveDebateCard: React.FC<{ debate: StockDebate }> = ({ debate }) => {
  const bullWon = debate.winner === "bull";
  const dialogueRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to latest message with debounce
  useEffect(() => {
    // Clear pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Debounce to avoid excessive scrolling during rapid updates
    scrollTimeoutRef.current = setTimeout(() => {
      if (dialogueRef.current) {
        dialogueRef.current.scrollTop = dialogueRef.current.scrollHeight;
      }
    }, 100);

    // Cleanup
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [debate.dialogue.length]);

  return (
    <motion.div
      className="glass-card rounded-2xl overflow-hidden border-2 border-cyan/30"
      layout
    >
      {/* Debate Header */}
      <div className="bg-gradient-to-r from-cyan/10 via-cyan/5 to-cyan/10 border-b border-cyan/20 p-4">
        <div className="flex items-center justify-between">
          {/* Bull Side */}
          <div className="flex items-center gap-3">
            <motion.div
              className="w-14 h-14 rounded-xl bg-bull/20 border-2 border-bull/40 flex items-center justify-center text-2xl relative"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              {debate.bullAnalyst.avatarEmoji}
              {bullWon && (
                <motion.div
                  className="absolute -top-2 -right-2 text-lg"
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring" }}
                >
                  🏆
                </motion.div>
              )}
            </motion.div>
            <div>
              <div className="font-bold text-bull-light">
                {debate.bullAnalyst.name}
              </div>
              <div className="text-xs text-slate-500">
                {debate.scores.bullScore} points
              </div>
            </div>
          </div>

          {/* VS Badge */}
          <motion.div
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-bear/20 via-gold/20 to-bull/20 border border-gold/30"
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <span className="text-sm font-bold text-gold-light">VS</span>
          </motion.div>

          {/* Bear Side */}
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-bold text-bear-light">
                {debate.bearAnalyst.name}
              </div>
              <div className="text-xs text-slate-500">
                {debate.scores.bearScore} points
              </div>
            </div>
            <motion.div
              className="w-14 h-14 rounded-xl bg-bear/20 border-2 border-bear/40 flex items-center justify-center text-2xl relative"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2, repeat: Infinity, delay: 0.5 }}
            >
              {debate.bearAnalyst.avatarEmoji}
              {!bullWon && (
                <motion.div
                  className="absolute -top-2 -right-2 text-lg"
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring" }}
                >
                  🏆
                </motion.div>
              )}
            </motion.div>
          </div>
        </div>
      </div>

      {/* Live Dialogue Stream */}
      <div
        ref={dialogueRef}
        className="p-4 space-y-3 max-h-96 overflow-y-auto bg-gradient-to-b from-transparent to-white/[0.01] scroll-smooth"
        style={{ scrollBehavior: "smooth" }}
      >
        <AnimatePresence mode="popLayout">
          {debate.dialogue.map((turn, index) => {
            const isBull = turn.position === "bull";
            return (
              <motion.div
                key={`${debate.matchId}-${index}`}
                className={`flex ${isBull ? "justify-start" : "justify-end"}`}
                initial={{ opacity: 0, y: 20, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{
                  type: "spring",
                  stiffness: 200,
                  damping: 20,
                }}
              >
                <div className="max-w-[80%]">
                  <div
                    className={`rounded-2xl px-4 py-3 ${
                      isBull
                        ? "bg-bull/10 border border-bull/20 rounded-tl-sm"
                        : "bg-bear/10 border border-bear/20 rounded-tr-sm"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span
                        className="text-lg"
                        role="img"
                        aria-label={
                          isBull
                            ? debate.bullAnalyst.name
                            : debate.bearAnalyst.name
                        }
                      >
                        {isBull
                          ? debate.bullAnalyst.avatarEmoji
                          : debate.bearAnalyst.avatarEmoji}
                      </span>
                      <span
                        className={`text-xs font-bold ${
                          isBull ? "text-bull-light" : "text-bear-light"
                        }`}
                      >
                        {isBull
                          ? debate.bullAnalyst.name
                          : debate.bearAnalyst.name}
                      </span>
                      <span
                        className="text-[10px] text-slate-600 px-2 py-0.5 bg-white/[0.05] rounded"
                        title="Argument strength"
                      >
                        💪 {turn.argumentStrength}
                      </span>
                      <span className="text-[9px] text-slate-700">
                        Turn {index + 1}
                      </span>
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed">
                      {turn.content}
                    </p>
                    {turn.dataPointsReferenced.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {turn.dataPointsReferenced.map((dp, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 text-[10px] bg-white/[0.06] rounded-md text-slate-500 font-medium"
                          >
                            📊 {dp}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Typing Indicator (if debate is ongoing) */}
        {debate.dialogue.length < 4 && (
          <motion.div
            className="flex flex-col items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-white/10">
              <motion.div
                className="flex gap-1"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                <div className="w-2 h-2 bg-cyan rounded-full" />
                <div className="w-2 h-2 bg-cyan rounded-full" />
                <div className="w-2 h-2 bg-cyan rounded-full" />
              </motion.div>
              <span className="text-xs text-slate-500">
                Analysts thinking...
              </span>
            </div>
            <p className="text-[10px] text-slate-600">
              Turn {debate.dialogue.length + 1} of 4
            </p>
          </motion.div>
        )}
      </div>

      {/* Score Breakdown */}
      <div className="p-4 border-t border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-4 gap-3">
          <ScoreMeter
            label="Data"
            bull={debate.scores.dataQuality.bull}
            bear={debate.scores.dataQuality.bear}
          />
          <ScoreMeter
            label="Logic"
            bull={debate.scores.logicCoherence.bull}
            bear={debate.scores.logicCoherence.bear}
          />
          <ScoreMeter
            label="Risk"
            bull={debate.scores.riskAcknowledgment.bull}
            bear={debate.scores.riskAcknowledgment.bear}
          />
          <ScoreMeter
            label="Catalysts"
            bull={debate.scores.catalystIdentification.bull}
            bear={debate.scores.catalystIdentification.bear}
          />
        </div>
      </div>
    </motion.div>
  );
};

// Score Meter Component
const ScoreMeter: React.FC<{
  label: string;
  bull: number;
  bear: number;
}> = ({ label, bull, bear }) => {
  // Safe calculation with explicit zero handling
  const total = bull + bear;
  const bullPercent =
    total > 0 ? (bull / total) * 100 : bull === 0 && bear === 0 ? 50 : 0;
  const winner =
    bull > bear ? "bull" : bear > bull ? "bear" : total === 0 ? "none" : "tie";

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-slate-500 font-bold">{label}</div>
        {winner !== "tie" && winner !== "none" && (
          <span
            className="text-[8px]"
            role="img"
            aria-label={`${winner} winning`}
          >
            {winner === "bull" ? "📈" : "📉"}
          </span>
        )}
      </div>
      <div className="h-2 bg-bear/30 rounded-full overflow-hidden relative">
        <motion.div
          className="h-full bg-gradient-to-r from-bull to-bull-light rounded-full relative"
          initial={{ width: 0 }}
          animate={{ width: `${bullPercent}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          {/* Glow effect for winner */}
          {winner === "bull" && (
            <div className="absolute inset-0 bg-bull/30 blur-sm" />
          )}
        </motion.div>
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20" />
      </div>
      <div className="flex justify-between mt-1 text-[10px] font-bold">
        <span
          className={`${
            bull > bear ? "text-bull-light" : "text-bull-light/50"
          }`}
        >
          {bull}
        </span>
        <span
          className={`${
            bear > bull ? "text-bear-light" : "text-bear-light/50"
          }`}
        >
          {bear}
        </span>
      </div>
    </div>
  );
};

// Completed Debate Card - Minimized
const CompletedDebateCard: React.FC<{ debate: StockDebate }> = ({ debate }) => {
  const bullWon = debate.winner === "bull";

  return (
    <motion.div
      className="glass-card rounded-lg p-3 border border-white/5 opacity-60 hover:opacity-100 transition-all cursor-pointer hover:border-white/10"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 0.6, height: "auto" }}
      transition={{ duration: 0.3 }}
      whileHover={{ scale: 1.01 }}
      title="Click to view full debate details"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="text-lg opacity-50"
            role="img"
            aria-label={debate.bullAnalyst.name}
          >
            {debate.bullAnalyst.avatarEmoji}
          </span>
          <span className="text-xs text-slate-600">vs</span>
          <span
            className="text-lg opacity-50"
            role="img"
            aria-label={debate.bearAnalyst.name}
          >
            {debate.bearAnalyst.avatarEmoji}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {debate.round === "quarterfinal"
              ? "Quarter"
              : debate.round === "semifinal"
              ? "Semi"
              : "Final"}
          </span>
          <div className="flex items-center gap-1">
            <span className="text-sm">
              {bullWon
                ? debate.bullAnalyst.avatarEmoji
                : debate.bearAnalyst.avatarEmoji}
            </span>
            <span className="text-xs" role="img" aria-label="Winner">
              🏆
            </span>
          </div>
          <span className="text-[10px] text-slate-600 bg-white/[0.03] px-1.5 py-0.5 rounded">
            {debate.scores.bullScore}-{debate.scores.bearScore}
          </span>
        </div>
      </div>
    </motion.div>
  );
};

export default LiveArena;
