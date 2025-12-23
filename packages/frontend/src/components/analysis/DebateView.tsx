/**
 * Debate View Component - Cinematic Command Center
 * Epic battle visualization with dramatic chat interface
 */

import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StockDebate } from "../../types/stock";

interface DebateViewProps {
  debate: StockDebate;
  expanded?: boolean;
}

const ROUND_CONFIG: Record<
  string,
  { label: string; icon: string; color: string }
> = {
  quarterfinal: { label: "QUARTER FINAL", icon: "⚔️", color: "#64748b" },
  semifinal: { label: "SEMI FINAL", icon: "🔥", color: "#f59e0b" },
  final: { label: "CHAMPIONSHIP", icon: "👑", color: "#ffd700" },
};

export const DebateView: React.FC<DebateViewProps> = ({
  debate,
  expanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(expanded);
  const bullWon = debate.winner === "bull";
  const roundConfig = ROUND_CONFIG[debate.round] || ROUND_CONFIG.quarterfinal;

  // Safe access to nested properties with defaults
  const bullAnalyst = debate.bullAnalyst || { avatarEmoji: "🐂", name: "Bull" };
  const bearAnalyst = debate.bearAnalyst || { avatarEmoji: "🐻", name: "Bear" };
  const scores = debate.scores || {
    bullScore: 0,
    bearScore: 0,
    dataQuality: { bull: 0, bear: 0 },
    logicCoherence: { bull: 0, bear: 0 },
    riskAcknowledgment: { bull: 0, bear: 0 },
    catalystIdentification: { bull: 0, bear: 0 },
  };
  const dialogue = debate.dialogue || [];
  const winningArguments = debate.winningArguments || [];

  return (
    <div className="relative group">
      {/* Main container */}
      <div
        className="relative rounded-xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
        }}
      >
        {/* Diagonal battle stripe */}
        <div
          className="absolute inset-0 opacity-10 rounded-xl overflow-hidden pointer-events-none"
          style={{
            background: `linear-gradient(135deg, #22c55e 0%, transparent 50%, #ef4444 100%)`,
          }}
        />

        {/* Scanlines */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none rounded-xl overflow-hidden"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        {/* Header - Battle Card */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full relative z-10"
          aria-expanded={isExpanded}
        >
          <div className="p-4 pb-6 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            {/* Bull Fighter */}
            <div
              className={`flex items-center gap-3 ${
                bullWon ? "opacity-100" : "opacity-50"
              }`}
            >
              <div className="relative">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                  style={{
                    background:
                      "linear-gradient(145deg, rgba(34,197,94,0.2) 0%, rgba(34,197,94,0.05) 100%)",
                    border: "1px solid rgba(34,197,94,0.3)",
                    boxShadow: bullWon
                      ? "0 0 30px rgba(34,197,94,0.3)"
                      : "none",
                  }}
                >
                  {bullAnalyst.avatarEmoji}
                </div>
                {bullWon && (
                  <div className="absolute -top-2 -right-2 text-lg">🏆</div>
                )}
              </div>
              <div className="text-left">
                <div
                  className="text-sm font-bold text-green-400"
                  style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  {bullAnalyst.name}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-green-400/60">BULL</span>
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: "rgba(34,197,94,0.15)",
                      color: "#22c55e",
                    }}
                  >
                    {scores.bullScore} PTS
                  </span>
                </div>
              </div>
            </div>

            {/* VS Badge */}
            <div className="flex flex-col items-center gap-2">
              <div
                className="px-4 py-2 rounded-lg hover:scale-105 transition-transform"
                style={{
                  background: `${roundConfig.color}15`,
                  border: `1px solid ${roundConfig.color}40`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span>{roundConfig.icon}</span>
                  <span
                    className="text-[10px] font-black tracking-widest"
                    style={{ color: roundConfig.color }}
                  >
                    {roundConfig.label}
                  </span>
                </div>
              </div>
              <div
                className="text-2xl font-black"
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  background:
                    "linear-gradient(135deg, #22c55e 0%, #ef4444 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                VS
              </div>
            </div>

            {/* Bear Fighter */}
            <div
              className={`flex items-center gap-3 flex-row-reverse justify-start ${
                !bullWon ? "opacity-100" : "opacity-50"
              }`}
            >
              <div className="relative">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                  style={{
                    background:
                      "linear-gradient(145deg, rgba(239,68,68,0.2) 0%, rgba(239,68,68,0.05) 100%)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    boxShadow: !bullWon
                      ? "0 0 30px rgba(239,68,68,0.3)"
                      : "none",
                  }}
                >
                  {bearAnalyst.avatarEmoji}
                </div>
                {!bullWon && (
                  <div className="absolute -top-2 -left-2 text-lg">🏆</div>
                )}
              </div>
              <div className="text-right">
                <div
                  className="text-sm font-bold text-red-400"
                  style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  {bearAnalyst.name}
                </div>
                <div className="flex items-center gap-2 mt-1 justify-end">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: "rgba(239,68,68,0.15)",
                      color: "#ef4444",
                    }}
                  >
                    {scores.bearScore} PTS
                  </span>
                  <span className="text-xs text-red-400/60">BEAR</span>
                </div>
              </div>
            </div>

            {/* Expand indicator - centered at bottom */}
            <div
              className="absolute left-1/2 bottom-1 transition-transform duration-200"
              style={{
                transform: `translateX(-50%) ${
                  isExpanded ? "rotate(180deg)" : "rotate(0deg)"
                }`,
              }}
            >
              <svg
                className="w-5 h-5 text-slate-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          </div>
        </button>

        {/* Expanded Content */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
            >
              <div className="border-t border-white/5">
                {/* Dialogue */}
                <div
                  className="p-4 space-y-3 max-h-80 overflow-y-auto scrollbar-thin"
                  style={{
                    scrollbarWidth: "thin",
                    scrollbarColor: "rgba(255,255,255,0.2) transparent",
                  }}
                >
                  {dialogue.map((turn, index) => {
                    const isBull = turn.position === "bull";
                    return (
                      <div
                        key={index}
                        className={`flex ${
                          isBull ? "justify-start" : "justify-end"
                        }`}
                      >
                        <div
                          className="max-w-[80%] p-4 rounded-xl"
                          style={{
                            background: isBull
                              ? "linear-gradient(135deg, rgba(34,197,94,0.1) 0%, rgba(34,197,94,0.02) 100%)"
                              : "linear-gradient(135deg, rgba(239,68,68,0.1) 0%, rgba(239,68,68,0.02) 100%)",
                            border: `1px solid ${
                              isBull
                                ? "rgba(34,197,94,0.2)"
                                : "rgba(239,68,68,0.2)"
                            }`,
                            borderRadius: isBull
                              ? "4px 16px 16px 16px"
                              : "16px 4px 16px 16px",
                          }}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className={`text-xs font-bold ${
                                isBull ? "text-green-400" : "text-red-400"
                              }`}
                            >
                              {isBull ? bullAnalyst.name : bearAnalyst.name}
                            </span>
                            <span
                              className="px-1.5 py-0.5 rounded text-[9px] font-mono"
                              style={{
                                background: "rgba(255,255,255,0.05)",
                                color: "#64748b",
                              }}
                            >
                              STR: {turn.argumentStrength}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 leading-relaxed">
                            {turn.content}
                          </p>
                          {turn.dataPointsReferenced &&
                            turn.dataPointsReferenced.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {turn.dataPointsReferenced.map((dp, i) => (
                                  <span
                                    key={i}
                                    className="px-1.5 py-0.5 rounded text-[9px] font-mono"
                                    style={{
                                      background: "rgba(0,240,255,0.1)",
                                      color: "#00f0ff",
                                      border: "1px solid rgba(0,240,255,0.2)",
                                    }}
                                  >
                                    {dp}
                                  </span>
                                ))}
                              </div>
                            )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Score Breakdown */}
                <div className="p-4 border-t border-white/5">
                  <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
                    SCORE BREAKDOWN
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <ScoreBar
                      label="Data Quality"
                      bull={scores.dataQuality?.bull ?? 0}
                      bear={scores.dataQuality?.bear ?? 0}
                    />
                    <ScoreBar
                      label="Logic"
                      bull={scores.logicCoherence?.bull ?? 0}
                      bear={scores.logicCoherence?.bear ?? 0}
                    />
                    <ScoreBar
                      label="Risk Awareness"
                      bull={scores.riskAcknowledgment?.bull ?? 0}
                      bear={scores.riskAcknowledgment?.bear ?? 0}
                    />
                    <ScoreBar
                      label="Catalysts"
                      bull={scores.catalystIdentification?.bull ?? 0}
                      bear={scores.catalystIdentification?.bear ?? 0}
                    />
                  </div>
                </div>

                {/* Winning Arguments */}
                {winningArguments.length > 0 && (
                  <div className="p-4 border-t border-white/5">
                    <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
                      KEY WINNING ARGUMENTS
                    </div>
                    <div className="space-y-2">
                      {winningArguments.map((arg, i) => (
                        <div
                          key={i}
                          className="flex gap-3 p-3 rounded-lg"
                          style={{
                            background: bullWon
                              ? "rgba(34,197,94,0.05)"
                              : "rgba(239,68,68,0.05)",
                            border: `1px solid ${
                              bullWon
                                ? "rgba(34,197,94,0.15)"
                                : "rgba(239,68,68,0.15)"
                            }`,
                          }}
                        >
                          <div
                            className="w-1 rounded-full flex-shrink-0"
                            style={{
                              background: bullWon ? "#22c55e" : "#ef4444",
                            }}
                          />
                          <p
                            className={`text-xs leading-relaxed ${
                              bullWon ? "text-green-300" : "text-red-300"
                            }`}
                          >
                            {arg}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
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
      <div className="text-[9px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            background: "linear-gradient(90deg, #22c55e 0%, #22c55e 100%)",
            width: `${bullPercent}%`,
          }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[9px] font-mono">
        <span className="text-green-400">{bull}</span>
        <span className="text-red-400">{bear}</span>
      </div>
    </div>
  );
};

export default DebateView;
