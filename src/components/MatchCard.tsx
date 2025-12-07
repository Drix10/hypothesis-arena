import React from "react";
import Icon from "./Icon";
import { MatchResult, Agent } from "../types";

interface MatchCardProps {
  match: MatchResult;
  agents: Agent[];
  onClick: (match: MatchResult) => void;
  isFinal?: boolean;
}

const MatchCard: React.FC<MatchCardProps> = React.memo(
  ({ match, agents, onClick, isFinal = false }) => {
    const agent1 = agents.find((a: Agent) => a.id === match.agent1Id);
    const agent2 = agents.find((a: Agent) => a.id === match.agent2Id);

    // Status-based Styles
    const isPending = match.status === "pending";
    const isRunning = match.status === "running";
    const isCompleted = match.status === "completed";

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (isCompleted && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onClick(match);
      }
    };

    if (!agent1 || !agent2) {
      // Render Pending Slot if agents not yet assigned (e.g. waiting for previous winners)
      return (
        <div
          className={`
            relative overflow-hidden bg-white/5 border border-white/5 rounded-2xl p-5
            flex items-center justify-center min-h-[140px]
            ${isFinal ? "border-yellow-500/10" : ""}
        `}
        >
          <div className="text-center space-y-2 opacity-30">
            <div className="text-2xl">⏳</div>
            <div className="text-[10px] font-mono uppercase tracking-widest">
              {isFinal ? "Championship" : "Waiting for Matchup"}
            </div>
          </div>
        </div>
      );
    }

    // Active or Completed Card
    return (
      <div
        onClick={() => isCompleted && onClick(match)}
        onKeyDown={handleKeyDown}
        tabIndex={isCompleted ? 0 : -1}
        role={isCompleted ? "button" : undefined}
        aria-disabled={!isCompleted}
        className={`
        group relative overflow-hidden transition-all duration-500 rounded-2xl p-0
        ${
          isCompleted
            ? "cursor-pointer bg-surface/50 backdrop-blur-sm border border-white/5 hover:border-electric-cyan/30 hover:shadow-2xl hover:shadow-black/50 focus:outline-none focus:ring-2 focus:ring-electric-cyan/50 focus:border-electric-cyan/50"
            : ""
        }
        ${
          isRunning
            ? "border border-electric-cyan/50 shadow-[0_0_30px_rgba(0,240,255,0.1)]"
            : ""
        }
        ${isPending ? "opacity-50 grayscale" : ""}
        ${isFinal && isCompleted ? "shadow-[0_0_50px_rgba(0,240,255,0.1)]" : ""}
      `}
      >
        {/* Background Pulse for Running State */}
        {isRunning && (
          <div className="absolute inset-0 z-0">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-electric-cyan/5 to-transparent animate-beam"></div>
          </div>
        )}

        {/* Hover Gradient Overlay (Completed only) */}
        {isCompleted && (
          <div className="absolute inset-0 bg-gradient-to-br from-electric-cyan/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"></div>
        )}

        {isFinal && (
          <div className="absolute top-0 right-0 p-3 text-yellow-400">
            <Icon icon="solar:cup-star-bold" width="24"></Icon>
          </div>
        )}

        <div className="relative z-10 p-5 flex flex-col gap-4">
          {/* Header Metadata */}
          <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-widest text-slate-500">
            <span>Match {match.matchId.split("-").pop()}</span>

            {isRunning && (
              <div className="flex items-center gap-2 text-electric-cyan">
                <span className="w-1.5 h-1.5 bg-electric-cyan rounded-full animate-pulse"></span>
                <span>Live Debate</span>
              </div>
            )}

            {isCompleted && match.scores && (
              <div className="flex items-center gap-1 group-hover:text-electric-cyan transition-colors">
                <Icon icon="solar:chart-square-bold-duotone" width="12"></Icon>
                <span
                  className={`${
                    match.scores.total > 30
                      ? "text-emerald-400"
                      : "text-slate-400"
                  }`}
                >
                  {match.scores.total.toFixed(1)}/40
                </span>
              </div>
            )}
          </div>

          {/* Agents Container */}
          <div className="space-y-3">
            {/* Agent 1 */}
            <div
              className={`flex items-center gap-4 p-3 rounded-xl transition-all duration-300 ${
                match.winnerId === agent1.id
                  ? "bg-white/5 border border-white/10"
                  : "opacity-60"
              }`}
            >
              <div className="text-2xl filter drop-shadow-lg">
                {agent1.avatarEmoji}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-400 font-mono mb-0.5">
                  {agent1.role}
                </p>
                <p className="text-sm font-bold text-slate-200 font-sans truncate">
                  {agent1.name}
                </p>
              </div>
              {match.winnerId === agent1.id && (
                <Icon
                  icon="solar:check-circle-bold"
                  class="text-emerald-400"
                  width="16"
                ></Icon>
              )}
            </div>

            {/* VS Noodle */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
            </div>

            {/* Agent 2 */}
            <div
              className={`flex items-center gap-4 p-3 rounded-xl transition-all duration-300 ${
                match.winnerId === agent2.id
                  ? "bg-white/5 border border-white/10"
                  : "opacity-60"
              }`}
            >
              <div className="text-2xl filter drop-shadow-lg">
                {agent2.avatarEmoji}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-400 font-mono mb-0.5">
                  {agent2.role}
                </p>
                <p className="text-sm font-bold text-slate-200 font-sans truncate">
                  {agent2.name}
                </p>
              </div>
              {match.winnerId === agent2.id && (
                <Icon
                  icon="solar:check-circle-bold"
                  class="text-emerald-400"
                  width="16"
                ></Icon>
              )}
            </div>
          </div>

          {isCompleted && (
            <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300 transform translate-y-2 group-hover:translate-y-0">
              <div className="bg-electric-cyan text-black text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1 shadow-[0_0_15px_rgba(0,240,255,0.5)]">
                <span>Analyze</span>
                <Icon icon="solar:arrow-right-linear"></Icon>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison to prevent unnecessary re-renders
    return (
      prevProps.match.matchId === nextProps.match.matchId &&
      prevProps.match.status === nextProps.match.status &&
      prevProps.match.winnerId === nextProps.match.winnerId &&
      prevProps.isFinal === nextProps.isFinal
    );
  }
);

export default MatchCard;
