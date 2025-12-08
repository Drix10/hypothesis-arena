import React, { useState, lazy, Suspense, useCallback } from "react";
import Icon from "./Icon";
import { TournamentData, MatchResult, Agent } from "../types";
import MatchCard from "./MatchCard";
import MatchModal from "./MatchModal";

// Lazy load WinningBriefView to reduce bundle size
const WinningBriefView = lazy(() => import("./WinningBriefView"));

interface Props {
  data: TournamentData;
  onNewTournament?: () => void;
}

const TournamentView: React.FC<Props> = ({ data, onNewTournament }) => {
  const [selectedMatch, setSelectedMatch] = useState<MatchResult | null>(null);
  const [showBrief, setShowBrief] = useState(false);

  // Memoize onClose to prevent MatchModal re-renders
  const handleCloseModal = useCallback(() => {
    setSelectedMatch(null);
  }, []);

  // Use refs to avoid recreating keyboard listener on every state change
  const selectedMatchRef = React.useRef(selectedMatch);
  const dataRef = React.useRef(data);

  // Keep refs in sync with state
  React.useEffect(() => {
    selectedMatchRef.current = selectedMatch;
    dataRef.current = data;
  }, [selectedMatch, data]);

  // Keyboard navigation - listener created once, uses refs
  React.useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      const currentMatch = selectedMatchRef.current;
      const currentData = dataRef.current;

      // Close modal with Escape
      if (e.key === "Escape" && currentMatch) {
        setSelectedMatch(null);
        return;
      }

      // Navigate matches with arrow keys (only when no modal is open)
      if (!currentMatch) {
        const completedMatches = currentData.matches.filter(
          (m) => m.status === "completed"
        );
        if (completedMatches.length === 0) return;

        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          // Start from first match
          setSelectedMatch(completedMatches[0]);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          // Start from last match
          setSelectedMatch(completedMatches[completedMatches.length - 1]);
        }
      } else {
        // Navigate between matches when one is selected
        const completedMatches = currentData.matches.filter(
          (m) => m.status === "completed"
        );
        if (completedMatches.length === 0) return;

        const currentIndex = completedMatches.findIndex(
          (m) => m.matchId === currentMatch.matchId
        );

        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          const nextIndex = (currentIndex + 1) % completedMatches.length;
          setSelectedMatch(completedMatches[nextIndex]);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          const prevIndex =
            currentIndex <= 0 ? completedMatches.length - 1 : currentIndex - 1;
          setSelectedMatch(completedMatches[prevIndex]);
        }
      }

      // Open brief with 'B' key
      if (e.key === "b" || e.key === "B") {
        if (currentData.winningBrief && !currentMatch) {
          setShowBrief(true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, []); // Empty deps - listener never recreated

  const handleExport = async () => {
    try {
      const { exportTournament } = await import(
        "../services/utils/persistenceUtils"
      );
      exportTournament(data);
    } catch (error) {
      // Use logger instead of console.error
      const { logger } = await import("../services/utils/logger");
      logger.error("Failed to export:", error);
    }
  };

  const handleNewTournament = () => {
    if (onNewTournament) {
      // Confirm before clearing tournament
      const hasProgress = data.matches.some(
        (m) => m.status === "completed" || m.status === "running"
      );
      if (hasProgress) {
        const confirmed = window.confirm(
          "Are you sure you want to start a new tournament? Current progress will be lost unless you export it first."
        );
        if (!confirmed) return;
      }
      onNewTournament();
    }
  };

  const handleImport = async () => {
    // Create file input element
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      // Confirm before importing (will overwrite current tournament)
      const hasProgress = data.matches.some(
        (m) => m.status === "completed" || m.status === "running"
      );
      if (hasProgress) {
        const confirmed = window.confirm(
          "Importing will replace the current tournament. Export first to save your progress?"
        );
        if (!confirmed) return;
      }

      try {
        const { importTournament, saveTournament } = await import(
          "../services/utils/persistenceUtils"
        );
        const imported = await importTournament(file);
        if (imported) {
          // Save imported data BEFORE reload to prevent race with auto-save
          saveTournament(imported);

          // Small delay to ensure save completes
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Reload page with imported data
          window.location.reload();
        } else {
          alert("Failed to import tournament. File may be corrupted.");
        }
      } catch (error) {
        const { logger } = await import("../services/utils/logger");
        logger.error("Failed to import:", error);
        alert("Failed to import tournament. Please check the file format.");
      }
    };

    input.click();
  };

  // Safely extract matches with bounds checking
  const quarterfinals = data.matches.slice(0, 4);
  const semifinals = data.matches.slice(4, 6);
  const final = data.matches.length > 6 ? data.matches[6] : null;

  const winner =
    final?.status === "completed" && final.winnerId
      ? data.agents.find((a: Agent) => a.id === final.winnerId)
      : null;

  if (showBrief && data.winningBrief) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-void flex items-center justify-center">
            <div className="text-center space-y-4">
              <div className="text-4xl animate-spin">📄</div>
              <p className="text-slate-400 font-mono text-sm">
                Loading Research Brief...
              </p>
            </div>
          </div>
        }
      >
        <WinningBriefView data={data} onBack={() => setShowBrief(false)} />
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen bg-void text-slate-200 selection:bg-electric-cyan/30 relative">
      {/* Background Grid */}
      <div className="absolute inset-0 z-0 bg-grid fixed pointer-events-none opacity-40"></div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-12 flex flex-col">
        {/* Header */}
        <header className="mb-16 flex justify-between items-end border-b border-white/5 pb-8">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-2 w-2 rounded-full bg-electric-cyan"></span>
              <span className="text-[10px] font-mono uppercase tracking-widest text-electric-cyan">
                Tournament Active
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-serif italic text-white">
              Hypothesis Arena
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Import Button */}
            <button
              onClick={handleImport}
              className="p-2.5 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors"
              title="Import Tournament"
            >
              <Icon
                icon="solar:upload-minimalistic-bold-duotone"
                width="20"
              ></Icon>
            </button>

            {/* Export Button */}
            <button
              onClick={handleExport}
              className="p-2.5 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors"
              title="Export Tournament"
            >
              <Icon
                icon="solar:download-minimalistic-bold-duotone"
                width="20"
              ></Icon>
            </button>

            {/* New Tournament Button */}
            {onNewTournament && (
              <button
                onClick={handleNewTournament}
                className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors text-xs font-mono uppercase tracking-widest"
                title="Start New Tournament"
              >
                <Icon icon="solar:add-circle-bold" width="16"></Icon>
                New
              </button>
            )}

            {/* View Brief Button */}
            {winner && (
              <button
                onClick={() => data.winningBrief && setShowBrief(true)}
                disabled={!data.winningBrief}
                className={`
                  group flex items-center gap-3 px-6 py-2.5 rounded-full font-bold text-sm transition-all
                  ${
                    data.winningBrief
                      ? "bg-white text-black hover:scale-105 cursor-pointer"
                      : "bg-white/10 text-slate-400 cursor-wait"
                  }
               `}
              >
                {data.winningBrief ? (
                  <>
                    <Icon
                      icon="solar:document-text-bold-duotone"
                      width="18"
                    ></Icon>
                    View Final Brief
                    <Icon
                      icon="solar:arrow-right-broken"
                      className="group-hover:translate-x-1 transition-transform"
                    ></Icon>
                  </>
                ) : (
                  <>
                    <Icon
                      icon="solar:refresh-circle-broken"
                      class="animate-spin text-lg"
                    ></Icon>
                    Drafting Brief...
                  </>
                )}
              </button>
            )}
          </div>
        </header>

        {/* The Grid Layout */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 relative">
          {/* Quarterfinals (Cols 1-4) */}
          <div className="lg:col-span-4 flex flex-col justify-between gap-6 relative">
            <div className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/5 to-transparent -ml-6 hidden lg:block"></div>
            <h3 className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-4 sticky top-0 bg-void/80 backdrop-blur py-2 z-10">
              01. Quarterfinals
            </h3>
            <div className="space-y-6">
              {quarterfinals.map((match: MatchResult) => (
                <div key={match.matchId} className="relative">
                  <MatchCard
                    match={match}
                    agents={data.agents}
                    onClick={setSelectedMatch}
                  />
                  {/* Noodle Connector Right */}
                  <div className="absolute top-1/2 -right-8 w-8 h-px bg-white/10 hidden lg:block"></div>
                </div>
              ))}
            </div>
          </div>

          {/* Semifinals (Cols 5-8) */}
          <div className="lg:col-span-4 flex flex-col justify-center gap-12 relative py-12">
            <div className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/5 to-transparent -ml-6 hidden lg:block"></div>
            <h3 className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-4 absolute top-0 left-0">
              02. Semifinals
            </h3>
            <div className="space-y-12">
              {semifinals.map((match: MatchResult) => (
                <div key={match.matchId} className="relative">
                  <MatchCard
                    match={match}
                    agents={data.agents}
                    onClick={setSelectedMatch}
                  />
                  {/* Noodle Connector Right */}
                  <div className="absolute top-1/2 -right-8 w-8 h-px bg-white/10 hidden lg:block"></div>
                </div>
              ))}
            </div>
          </div>

          {/* Final (Cols 9-12) */}
          <div className="lg:col-span-4 flex flex-col justify-center items-center relative">
            <div className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/5 to-transparent -ml-6 hidden lg:block"></div>
            <h3 className="text-xs font-mono uppercase tracking-widest text-yellow-500 mb-4 absolute top-0 left-0">
              03. Championship
            </h3>

            <div className="w-full relative">
              {final && (
                <MatchCard
                  match={final}
                  agents={data.agents}
                  onClick={setSelectedMatch}
                  isFinal
                />
              )}
            </div>

            {/* Winner Pedestal */}
            {winner && (
              <div className="mt-12 text-center animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <div className="inline-block relative">
                  <div className="absolute -inset-4 bg-electric-cyan/20 blur-xl rounded-full"></div>
                  <div className="relative p-6 bg-surface border border-white/10 rounded-2xl">
                    <div className="text-5xl mb-3 animate-float">
                      {winner.avatarEmoji}
                    </div>
                    <div className="font-serif italic text-2xl text-white mb-1">
                      {winner.name}
                    </div>
                    <div className="text-xs font-mono text-slate-400 uppercase">
                      {winner.role}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <MatchModal
        match={selectedMatch}
        agents={data.agents}
        onClose={handleCloseModal}
      />
    </div>
  );
};

export default TournamentView;
