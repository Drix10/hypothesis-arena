/**
 * Debate View Component - Strategic Arena Theme
 * Premium debate visualization with chat-style interface
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { StockDebate } from "../../types/stock";

interface DebateViewProps {
  debate: StockDebate;
  expanded?: boolean;
}

export const DebateView: React.FC<DebateViewProps> = ({
  debate,
  expanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(expanded);
  const bullWon = debate.winner === "bull";

  const roundLabels: Record<string, { label: string; icon: string }> = {
    quarterfinal: { label: "Quarter Final", icon: "🏟️" },
    semifinal: { label: "Semi Final", icon: "⚔️" },
    final: { label: "Championship", icon: "🏆" },
  };

  const roundInfo = roundLabels[debate.round] || {
    label: debate.round,
    icon: "🎯",
  };

  return (
    <motion.div
      className="glass-card rounded-xl overflow-hidden"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      layout
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        aria-expanded={isExpanded}
        aria-controls={`debate-content-${debate.matchId}`}
      >
        <div className="flex items-center gap-3 sm:gap-5">
          {/* Bull Analyst */}
          <div
            className={`flex items-center gap-2.5 ${
              bullWon ? "opacity-100" : "opacity-50"
            }`}
          >
            <div className="relative">
              <div className="w-10 h-10 rounded-lg bg-bull/[0.12] flex items-center justify-center text-lg border border-bull/20">
                {debate.bullAnalyst.avatarEmoji}
              </div>
              {bullWon && (
                <motion.div
                  className="absolute -top-1 -right-1 text-xs"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring" }}
                >
                  🏆
                </motion.div>
              )}
            </div>
            <div className="text-left hidden sm:block">
              <div className="font-semibold text-bull-light text-xs">
                {debate.bullAnalyst.name}
              </div>
              <div className="text-[10px] text-slate-500">
                {debate.scores.bullScore} pts
              </div>
            </div>
          </div>

          {/* VS Badge */}
          <div className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06]">
            <span className="text-[10px] font-bold text-slate-500">VS</span>
          </div>

          {/* Bear Analyst */}
          <div
            className={`flex items-center gap-2.5 ${
              !bullWon ? "opacity-100" : "opacity-50"
            }`}
          >
            <div className="relative">
              <div className="w-10 h-10 rounded-lg bg-bear/[0.12] flex items-center justify-center text-lg border border-bear/20">
                {debate.bearAnalyst.avatarEmoji}
              </div>
              {!bullWon && (
                <motion.div
                  className="absolute -top-1 -right-1 text-xs"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring" }}
                >
                  🏆
                </motion.div>
              )}
            </div>
            <div className="text-left hidden sm:block">
              <div className="font-semibold text-bear-light text-xs">
                {debate.bearAnalyst.name}
              </div>
              <div className="text-[10px] text-slate-500">
                {debate.scores.bearScore} pts
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-md bg-white/[0.04] text-[10px] text-slate-400 font-medium flex items-center gap-1.5">
            <span>{roundInfo.icon}</span>
            <span className="hidden sm:inline">{roundInfo.label}</span>
          </span>
          <motion.svg
            className="w-4 h-4 text-slate-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </motion.svg>
        </div>
      </button>

      {/* Expanded Content */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="border-t border-white/[0.05] overflow-hidden"
            id={`debate-content-${debate.matchId}`}
          >
            {/* Dialogue */}
            <div className="p-4 space-y-3 max-h-80 overflow-y-auto">
              {debate.dialogue.map((turn, index) => {
                const isBull = turn.position === "bull";
                return (
                  <motion.div
                    key={index}
                    className={`flex ${
                      isBull ? "justify-start" : "justify-end"
                    }`}
                    initial={{ opacity: 0, x: isBull ? -20 : 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.08 }}
                  >
                    <div className="max-w-[85%]">
                      <div
                        className={`rounded-xl px-3.5 py-2.5 ${
                          isBull
                            ? "bg-bull/[0.08] border border-bull/15 rounded-tl-sm"
                            : "bg-bear/[0.08] border border-bear/15 rounded-tr-sm"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <span
                            className={`text-[11px] font-semibold ${
                              isBull ? "text-bull-light" : "text-bear-light"
                            }`}
                          >
                            {isBull
                              ? debate.bullAnalyst.name
                              : debate.bearAnalyst.name}
                          </span>
                          <span className="text-[9px] text-slate-600 px-1.5 py-0.5 bg-white/[0.04] rounded">
                            Strength: {turn.argumentStrength}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          {turn.content}
                        </p>
                        {turn.dataPointsReferenced.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {turn.dataPointsReferenced.map((dp, i) => (
                              <span
                                key={i}
                                className="px-1.5 py-0.5 text-[9px] bg-white/[0.04] rounded text-slate-500 font-medium"
                              >
                                {dp}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Score Breakdown */}
            <div className="px-4 pb-4">
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <div className="text-[10px] text-slate-500 font-semibold mb-3 tracking-wider uppercase">
                  Score Breakdown
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <ScoreBar
                    label="Data Quality"
                    bull={debate.scores.dataQuality.bull}
                    bear={debate.scores.dataQuality.bear}
                  />
                  <ScoreBar
                    label="Logic"
                    bull={debate.scores.logicCoherence.bull}
                    bear={debate.scores.logicCoherence.bear}
                  />
                  <ScoreBar
                    label="Risk Awareness"
                    bull={debate.scores.riskAcknowledgment.bull}
                    bear={debate.scores.riskAcknowledgment.bear}
                  />
                  <ScoreBar
                    label="Catalysts"
                    bull={debate.scores.catalystIdentification.bull}
                    bear={debate.scores.catalystIdentification.bear}
                  />
                </div>
              </div>
            </div>

            {/* Winning Arguments */}
            {debate.winningArguments.length > 0 && (
              <div className="px-4 pb-4">
                <div className="text-[10px] text-slate-500 font-semibold mb-2 tracking-wider uppercase">
                  Key Winning Arguments
                </div>
                <div className="space-y-1.5">
                  {debate.winningArguments.map((arg, i) => (
                    <motion.div
                      key={i}
                      className={`flex gap-2.5 p-2.5 rounded-lg ${
                        bullWon
                          ? "bg-bull/[0.06] border border-bull/10"
                          : "bg-bear/[0.06] border border-bear/10"
                      }`}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.08 }}
                    >
                      <span
                        className={`w-0.5 rounded-full flex-shrink-0 ${
                          bullWon ? "bg-bull" : "bg-bear"
                        }`}
                      />
                      <p
                        className={`text-xs leading-relaxed ${
                          bullWon ? "text-bull-light" : "text-bear-light"
                        }`}
                      >
                        {arg}
                      </p>
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

const ScoreBar: React.FC<{ label: string; bull: number; bear: number }> = ({
  label,
  bull,
  bear,
}) => {
  const total = bull + bear;
  const bullPercent = total > 0 ? (bull / total) * 100 : 50;

  return (
    <div>
      <div className="text-[9px] text-slate-500 mb-1.5 font-medium">
        {label}
      </div>
      <div className="h-1.5 bg-bear/25 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-bull rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${bullPercent}%` }}
          transition={{ duration: 0.5, delay: 0.2 }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[9px] font-medium">
        <span className="text-bull-light">{bull}</span>
        <span className="text-bear-light">{bear}</span>
      </div>
    </div>
  );
};

export default DebateView;
