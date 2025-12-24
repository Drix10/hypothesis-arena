/**
 * Debate Card - Epic battle visualization between analysts
 * Cinematic VS screen with dramatic lighting
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DebateMatch, ROUND_CONFIG } from "./types";
import { ScoreBar } from "../ui";

interface DebateCardProps {
  debate: DebateMatch;
}

export const DebateCard: React.FC<DebateCardProps> = ({ debate }) => {
  const [expanded, setExpanded] = useState(false);

  // Guard against missing data
  if (!debate || !debate.bullAnalyst || !debate.bearAnalyst) return null;

  const bullWon = debate.winner === "bull";
  const roundConfig = ROUND_CONFIG[debate.round] || ROUND_CONFIG.quarterfinal;
  const bullScore = debate.bullScore || 0;
  const bearScore = debate.bearScore || 0;

  return (
    <div className="relative group">
      {/* Main container */}
      <div
        className="relative rounded-xl overflow-hidden"
        style={{
          background:
            "linear-gradient(165deg, rgba(20,31,50,0.95) 0%, rgba(10,18,32,0.9) 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
        }}
      >
        {/* Diagonal battle stripe */}
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{
            background:
              "linear-gradient(135deg, #4ADE80 0%, transparent 50%, #F43F5E 100%)",
          }}
        />

        {/* Scanlines */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        {/* Header - Battle Card */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full relative z-10 text-left"
          aria-expanded={expanded}
        >
          <div className="p-4 pb-6 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            {/* Bull Fighter */}
            <div
              className={`flex items-center gap-3 transition-opacity ${
                bullWon ? "opacity-100" : "opacity-50"
              }`}
            >
              <div className="relative">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                  style={{
                    background:
                      "linear-gradient(145deg, rgba(74,222,128,0.2) 0%, rgba(74,222,128,0.05) 100%)",
                    border: "1px solid rgba(74,222,128,0.3)",
                    boxShadow: bullWon
                      ? "0 0 30px rgba(74,222,128,0.3)"
                      : "none",
                  }}
                >
                  {debate.bullAnalyst.analystEmoji}
                </div>
                {bullWon && (
                  <div className="absolute -top-2 -right-2 text-lg drop-shadow-lg">
                    🏆
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-bold text-green-400">
                  {debate.bullAnalyst.analystName}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-green-400/60">BULL</span>
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: "rgba(74,222,128,0.15)",
                      color: "#4ADE80",
                    }}
                  >
                    {bullScore} PTS
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
                  background:
                    "linear-gradient(135deg, #4ADE80 0%, #F43F5E 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                VS
              </div>
            </div>

            {/* Bear Fighter */}
            <div
              className={`flex items-center gap-3 flex-row-reverse justify-start transition-opacity ${
                !bullWon ? "opacity-100" : "opacity-50"
              }`}
            >
              <div className="relative">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                  style={{
                    background:
                      "linear-gradient(145deg, rgba(244,63,94,0.2) 0%, rgba(244,63,94,0.05) 100%)",
                    border: "1px solid rgba(244,63,94,0.3)",
                    boxShadow: !bullWon
                      ? "0 0 30px rgba(244,63,94,0.3)"
                      : "none",
                  }}
                >
                  {debate.bearAnalyst.analystEmoji}
                </div>
                {!bullWon && (
                  <div className="absolute -top-2 -left-2 text-lg drop-shadow-lg">
                    🏆
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-rose-400">
                  {debate.bearAnalyst.analystName}
                </div>
                <div className="flex items-center gap-2 mt-1 justify-end">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      background: "rgba(244,63,94,0.15)",
                      color: "#F43F5E",
                    }}
                  >
                    {bearScore} PTS
                  </span>
                  <span className="text-xs text-rose-400/60">BEAR</span>
                </div>
              </div>
            </div>

            {/* Expand indicator */}
            <div
              className="absolute left-1/2 bottom-1 transition-transform duration-200"
              style={{
                transform: `translateX(-50%) ${
                  expanded ? "rotate(180deg)" : "rotate(0deg)"
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
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
            >
              <div className="border-t border-white/5">
                {/* Score Breakdown */}
                <div className="p-4">
                  <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
                    SCORE BREAKDOWN
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <ScoreBar
                      label="Data Quality"
                      bull={Math.round(bullScore * 0.3)}
                      bear={Math.round(bearScore * 0.3)}
                    />
                    <ScoreBar
                      label="Logic"
                      bull={Math.round(bullScore * 0.25)}
                      bear={Math.round(bearScore * 0.25)}
                    />
                    <ScoreBar
                      label="Risk Awareness"
                      bull={Math.round(bullScore * 0.25)}
                      bear={Math.round(bearScore * 0.25)}
                    />
                    <ScoreBar
                      label="Catalysts"
                      bull={Math.round(bullScore * 0.2)}
                      bear={Math.round(bearScore * 0.2)}
                    />
                  </div>
                </div>

                {/* Winning Arguments */}
                {debate.winningArguments &&
                  Array.isArray(debate.winningArguments) &&
                  debate.winningArguments.length > 0 && (
                    <div className="p-4 border-t border-white/5">
                      <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
                        KEY WINNING ARGUMENTS
                      </div>
                      <div className="space-y-2">
                        {debate.winningArguments.map((arg, i) => (
                          <div
                            key={i}
                            className="flex gap-3 p-3 rounded-lg"
                            style={{
                              background: bullWon
                                ? "rgba(74,222,128,0.05)"
                                : "rgba(244,63,94,0.05)",
                              border: `1px solid ${
                                bullWon
                                  ? "rgba(74,222,128,0.15)"
                                  : "rgba(244,63,94,0.15)"
                              }`,
                            }}
                          >
                            <div
                              className="w-1 rounded-full flex-shrink-0"
                              style={{
                                background: bullWon ? "#4ADE80" : "#F43F5E",
                              }}
                            />
                            <p
                              className={`text-xs leading-relaxed ${
                                bullWon ? "text-green-300" : "text-rose-300"
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
