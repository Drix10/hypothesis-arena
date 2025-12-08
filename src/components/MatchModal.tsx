import React, { useEffect, memo } from "react";
import { MatchResult, Agent } from "../types";
import {
  X,
  Award,
  AlertTriangle,
  MessageSquare,
  Microscope,
} from "lucide-react";
import ScoreRadar from "./RadarChart";

interface MatchModalProps {
  match: MatchResult | null;
  agents: Agent[];
  onClose: () => void;
}

const MatchModal: React.FC<MatchModalProps> = memo(
  ({ match, agents, onClose }) => {
    // Handle Escape key, Body Scroll Lock, and Focus Trap
    useEffect(() => {
      if (!match) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();

        // Basic focus trap: prevent Tab from leaving modal
        if (e.key === "Tab") {
          const modalElement = document.querySelector('[role="dialog"]');
          if (!modalElement) return;

          const focusableElements = modalElement.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          const firstElement = focusableElements[0] as HTMLElement;
          const lastElement = focusableElements[
            focusableElements.length - 1
          ] as HTMLElement;

          if (e.shiftKey && document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          } else if (!e.shiftKey && document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      };

      // Lock body scroll to prevent background scrolling
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;

      // Track timeout ID for cleanup
      let focusTimeoutId: NodeJS.Timeout | null = null;

      // Wrap in try-catch to ensure cleanup even if DOM manipulation fails
      try {
        // Prevent layout shift by adding padding for scrollbar
        const scrollbarWidth =
          window.innerWidth - document.documentElement.clientWidth;
        if (scrollbarWidth > 0) {
          document.body.style.paddingRight = `${scrollbarWidth}px`;
        }
        document.body.style.overflow = "hidden";

        window.addEventListener("keydown", handleKeyDown);

        // Auto-focus first focusable element for accessibility
        const MODAL_FOCUS_DELAY = 100; // Delay to ensure modal is fully rendered
        focusTimeoutId = setTimeout(() => {
          const modalElement = document.querySelector('[role="dialog"]');
          const firstFocusable = modalElement?.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          ) as HTMLElement;
          firstFocusable?.focus();
        }, MODAL_FOCUS_DELAY);
      } catch (error) {
        // If scroll lock fails, still add keyboard listener
        window.addEventListener("keydown", handleKeyDown);
      }

      return () => {
        // Clear focus timeout if component unmounts before it fires
        if (focusTimeoutId) {
          clearTimeout(focusTimeoutId);
        }

        // Always restore original styles, even if component unmounts unexpectedly
        // Wrap in try-catch to prevent cleanup errors from breaking app
        try {
          document.body.style.overflow = originalOverflow;
          document.body.style.paddingRight = originalPaddingRight;
        } catch (error) {
          // Fallback: force reset to default values
          document.body.style.overflow = "";
          document.body.style.paddingRight = "";
        }
        window.removeEventListener("keydown", handleKeyDown);
      };
    }, [match, onClose]);

    if (!match) return null;

    const agent1 = agents.find((a: Agent) => a.id === match.agent1Id);
    const agent2 = agents.find((a: Agent) => a.id === match.agent2Id);
    const winner = match.winnerId
      ? agents.find((a: Agent) => a.id === match.winnerId)
      : undefined;

    if (!agent1 || !agent2) return null;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-modal-title"
      >
        <div
          className="bg-slate-950 border border-slate-700 w-full max-w-5xl max-h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col ring-1 ring-white/10"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
            <div>
              <h2
                id="match-modal-title"
                className="text-xl font-bold text-white flex items-center gap-2 font-serif tracking-wide"
              >
                <span className="text-electric-cyan">{match.round}</span>
                <span className="text-slate-600">/</span>
                <span>Debate Analysis</span>
              </h2>
              <div className="flex items-center gap-2 text-sm text-slate-400 mt-1 font-mono">
                <span>{agent1.name}</span>
                <span className="text-slate-600">VS</span>
                <span>{agent2.name}</span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-electric-cyan/50"
              aria-label="Close modal"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="overflow-y-auto flex-1 p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 custom-scrollbar">
            {/* Left Col: Dialogue (7 cols) */}
            <div className="lg:col-span-7 space-y-6">
              <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800/50 shadow-inner">
                <h3 className="text-xs font-mono text-electric-cyan mb-4 flex items-center gap-2 uppercase tracking-widest">
                  <MessageSquare className="w-4 h-4" /> Debate Transcript
                </h3>
                <div className="font-mono text-xs md:text-sm leading-relaxed text-slate-300 border-l-2 border-slate-800 pl-4 space-y-3">
                  {(match.debateDialogue || "").split("\n\n").map((turn, i) => (
                    <p key={i} className="whitespace-pre-line">
                      {turn}
                    </p>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800/50">
                <h3 className="text-xs font-mono text-acid-purple mb-4 flex items-center gap-2 uppercase tracking-widest">
                  <Microscope className="w-4 h-4" /> Evolved Hypothesis
                </h3>
                <p className="text-slate-200 font-serif italic text-lg leading-relaxed border-l-2 border-acid-purple pl-4">
                  "{match.evolvedHypothesis}"
                </p>
              </div>

              {match.fatalFlaw && (
                <div className="bg-red-950/10 rounded-2xl p-6 border border-red-900/20">
                  <h3 className="text-xs font-mono text-red-400 mb-2 flex items-center gap-2 uppercase tracking-widest">
                    <AlertTriangle className="w-4 h-4" /> Identified
                    Vulnerability
                  </h3>
                  <p className="text-red-200/80 text-sm">{match.fatalFlaw}</p>
                </div>
              )}
            </div>

            {/* Right Col: Stats & Winner (5 cols) */}
            <div className="lg:col-span-5 space-y-6 flex flex-col">
              {/* Winner Card */}
              {winner && (
                <div className="bg-gradient-to-br from-slate-900 to-slate-950 rounded-2xl p-1 border border-yellow-500/20 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-yellow-500/5 group-hover:bg-yellow-500/10 transition-colors"></div>
                  <div className="absolute top-0 right-0 p-4 opacity-20">
                    <Award className="w-24 h-24 text-yellow-500" />
                  </div>

                  <div className="relative p-6 flex flex-col items-center text-center z-10">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-[10px] font-mono uppercase tracking-widest mb-4">
                      Match Victor
                    </div>
                    <div className="text-6xl mb-4 filter drop-shadow-2xl animate-float">
                      {winner.avatarEmoji}
                    </div>
                    <h3 className="text-2xl font-bold text-white font-serif">
                      {winner.name}
                    </h3>
                    <p className="text-sm text-slate-400 font-mono mt-1">
                      {winner.role}
                    </p>

                    <div className="mt-6 w-full h-px bg-gradient-to-r from-transparent via-yellow-500/20 to-transparent"></div>
                  </div>
                </div>
              )}

              {/* Scores */}
              {match.scores && (
                <div className="bg-slate-900/80 rounded-2xl p-6 border border-slate-800 flex flex-col">
                  <h3 className="text-xs font-mono text-slate-500 mb-2 uppercase tracking-widest text-center">
                    Performance Metrics
                  </h3>
                  <div className="h-[300px] -mx-2">
                    <ScoreRadar scores={match.scores} />
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div className="bg-black/40 p-3 rounded-lg border border-slate-800 text-center">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                        Total Score
                      </div>
                      <div className="text-2xl font-bold text-electric-cyan font-serif">
                        {match.scores.total.toFixed(1)}
                      </div>
                    </div>
                    <div className="bg-black/40 p-3 rounded-lg border border-slate-800 text-center">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                        Ethical Rating
                      </div>
                      <div className="text-2xl font-bold text-emerald-400 font-serif">
                        {match.scores.ethics.toFixed(1)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

MatchModal.displayName = "MatchModal";

export default MatchModal;
