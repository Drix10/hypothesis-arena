/**
 * Debate View Component - Dark Theme
 */

import React, { useState } from "react";
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

  const roundLabels: Record<string, string> = {
    quarterfinal: "Quarter",
    semifinal: "Semi",
    final: "Final",
  };

  return (
    <div className="bg-surface border border-white/5 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-6">
          {/* Bull */}
          <div
            className={`flex items-center gap-3 ${
              bullWon ? "opacity-100" : "opacity-50"
            }`}
          >
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-xl">
              {debate.bullAnalyst.avatarEmoji}
            </div>
            <div className="text-left">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-emerald-400 text-sm">
                  {debate.bullAnalyst.name}
                </span>
                {bullWon && <span className="text-xs">🏆</span>}
              </div>
              <div className="text-xs text-slate-500">
                {debate.scores.bullScore} pts
              </div>
            </div>
          </div>

          {/* VS */}
          <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-slate-500 font-bold">
            VS
          </div>

          {/* Bear */}
          <div
            className={`flex items-center gap-3 ${
              !bullWon ? "opacity-100" : "opacity-50"
            }`}
          >
            <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center text-xl">
              {debate.bearAnalyst.avatarEmoji}
            </div>
            <div className="text-left">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-red-400 text-sm">
                  {debate.bearAnalyst.name}
                </span>
                {!bullWon && <span className="text-xs">🏆</span>}
              </div>
              <div className="text-xs text-slate-500">
                {debate.scores.bearScore} pts
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="px-3 py-1 rounded-full bg-white/5 text-xs text-slate-400 capitalize">
            {roundLabels[debate.round] || debate.round}
          </span>
          <svg
            className={`w-5 h-5 text-slate-500 transition-transform ${
              isExpanded ? "rotate-180" : ""
            }`}
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
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-white/5">
          {/* Dialogue */}
          <div className="p-5 space-y-4">
            {debate.dialogue.map((turn, index) => {
              const isBull = turn.position === "bull";
              return (
                <div
                  key={index}
                  className={`flex ${isBull ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[75%] ${isBull ? "order-1" : "order-1"}`}
                  >
                    <div
                      className={`rounded-2xl px-4 py-3 ${
                        isBull
                          ? "bg-emerald-500/10 border border-emerald-500/20 rounded-tl-sm"
                          : "bg-red-500/10 border border-red-500/20 rounded-tr-sm"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`text-xs font-semibold ${
                            isBull ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {isBull
                            ? debate.bullAnalyst.name
                            : debate.bearAnalyst.name}
                        </span>
                        <span className="text-[10px] text-slate-600">
                          Strength: {turn.argumentStrength}
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
                              className="px-2 py-0.5 text-[10px] bg-white/5 rounded text-slate-500"
                            >
                              {dp}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Score Breakdown */}
          <div className="px-5 pb-5">
            <div className="bg-white/[0.02] rounded-xl p-4">
              <div className="text-xs text-slate-500 font-semibold mb-4">
                Score Breakdown
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            <div className="px-5 pb-5">
              <div className="text-xs text-slate-500 font-semibold mb-3">
                Key Winning Arguments
              </div>
              <div className="space-y-2">
                {debate.winningArguments.map((arg, i) => (
                  <div
                    key={i}
                    className={`flex gap-3 p-3 rounded-lg ${
                      bullWon
                        ? "bg-emerald-500/5 border border-emerald-500/10"
                        : "bg-red-500/5 border border-red-500/10"
                    }`}
                  >
                    <span
                      className={`w-1 rounded-full ${
                        bullWon ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <p
                      className={`text-sm ${
                        bullWon ? "text-emerald-300" : "text-red-300"
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
      )}
    </div>
  );
};

const ScoreBar: React.FC<{ label: string; bull: number; bear: number }> = ({
  label,
  bull,
  bear,
}) => {
  // Safe division - ensure we never divide by zero
  const total = bull + bear;
  const bullPercent = total > 0 ? (bull / total) * 100 : 50;

  return (
    <div>
      <div className="text-[10px] text-slate-500 mb-2">{label}</div>
      <div className="h-2 bg-red-500/30 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all"
          style={{ width: `${bullPercent}%` }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[10px]">
        <span className="text-emerald-400">{bull}</span>
        <span className="text-red-400">{bear}</span>
      </div>
    </div>
  );
};

export default DebateView;
