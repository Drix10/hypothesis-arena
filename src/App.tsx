import React, {
  useState,
  useRef,
  useEffect,
  lazy,
  Suspense,
  Component,
  ErrorInfo,
  ReactNode,
} from "react";
import { TournamentData, AppState, MatchResult, Agent } from "./types";
import {
  generateAgents,
  simulateMatch,
  generateBrief,
} from "./services/tournamentService";
import InputSection from "./components/InputSection";
import { logger } from "./services/utils/logger";
import { validateWinnerId } from "./services/utils/agentLookup";

// Error boundary for lazy-loaded components
class LazyLoadErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error("Lazy load error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Lazy load TournamentView to reduce initial bundle size
const TournamentView = lazy(() => import("./components/TournamentView"));

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [loadingStatus, setLoadingStatus] = useState<string>("");
  const [tournamentData, setTournamentData] = useState<TournamentData | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  // Track mount status to prevent state updates after unmount
  const isMounted = useRef(true);

  // Track active tournament's hypothesis map for cleanup
  const activeHypothesisMapRef = useRef<Map<string, string> | null>(null);

  // Load saved tournament on mount
  useEffect(() => {
    isMounted.current = true;

    // Try to load saved tournament from localStorage
    const loadSavedTournament = async () => {
      try {
        const { loadTournament } = await import(
          "./services/utils/persistenceUtils"
        );
        const saved = loadTournament();
        if (saved && isMounted.current) {
          setTournamentData(saved);
          // Determine app state based on tournament progress
          if (saved.winningBrief) {
            setAppState(AppState.COMPLETE);
          } else if (saved.matches.some((m) => m.status === "running")) {
            setAppState(AppState.RUNNING_TOURNAMENT);
          } else if (saved.matches.some((m) => m.status === "completed")) {
            setAppState(AppState.RUNNING_TOURNAMENT);
          } else {
            setAppState(AppState.IDLE);
          }
          logger.info("Restored previous tournament from storage");
        }
      } catch (error) {
        logger.error("Failed to load saved tournament:", error);
      }
    };

    loadSavedTournament();

    return () => {
      isMounted.current = false;

      // Clear active hypothesis map to prevent memory leaks
      if (activeHypothesisMapRef.current) {
        activeHypothesisMapRef.current.clear();
        activeHypothesisMapRef.current = null;
      }

      // Note: Gemini SDK doesn't support AbortSignal
      // We rely on isMounted checks to prevent state updates after unmount
    };
  }, []);

  // Auto-save tournament data whenever it changes
  // Use ref to prevent concurrent saves
  const saveInProgress = useRef(false);

  useEffect(() => {
    if (tournamentData && appState !== AppState.IDLE) {
      // Debounce saves to avoid excessive writes
      const saveTimer = setTimeout(async () => {
        // Prevent concurrent saves
        if (saveInProgress.current) {
          logger.warn("Save already in progress, skipping");
          return;
        }

        saveInProgress.current = true;
        try {
          const { saveTournament } = await import(
            "./services/utils/persistenceUtils"
          );
          saveTournament(tournamentData);
        } catch (error) {
          logger.error("Failed to auto-save tournament:", error);
        } finally {
          saveInProgress.current = false;
        }
      }, 1000); // Save 1 second after last change (AUTO_SAVE_DEBOUNCE)

      return () => clearTimeout(saveTimer);
    }
    return undefined;
  }, [tournamentData, appState]);

  // Orchestration Helper to update match state
  // Includes memory optimization: truncate very large debate dialogues
  const updateMatch = (matchId: string, updates: Partial<MatchResult>) => {
    setTournamentData((prev: TournamentData | null) => {
      if (!prev) return null;

      // Truncate debate dialogue if it exceeds reasonable size (50KB)
      const MAX_DIALOGUE_LENGTH = 50000; // DEBATE_MAX_LENGTH constant
      if (
        updates.debateDialogue &&
        updates.debateDialogue.length > MAX_DIALOGUE_LENGTH
      ) {
        logger.warn(
          `Debate dialogue for ${matchId} truncated from ${updates.debateDialogue.length} to ${MAX_DIALOGUE_LENGTH} chars`
        );
        updates.debateDialogue =
          updates.debateDialogue.substring(0, MAX_DIALOGUE_LENGTH) +
          "\n\n[... Debate truncated for memory optimization ...]";
      }

      return {
        ...prev,
        matches: prev.matches.map((m: MatchResult) =>
          m.matchId === matchId ? { ...m, ...updates } : m
        ),
      };
    });
  };

  /**
   * Orchestrates the entire tournament flow:
   * 1. Generates 8 AI research agents
   * 2. Runs quarterfinal matches in parallel
   * 3. Runs semifinal matches
   * 4. Runs final match
   * 5. Generates winning brief
   *
   * MEMORY OPTIMIZATION: File data is NOT stored in React state.
   * Instead, it's passed through function closures to avoid keeping
   * 20-27MB of base64 data in memory throughout the tournament.
   *
   * @param userInput - Research hypothesis or topic
   * @param file - Optional file attachment (PDF, image, or text)
   */
  const startTournament = async (
    userInput: string,
    file?: { mimeType: string; data: string }
  ) => {
    // Guard against concurrent tournament starts
    if (appState !== AppState.IDLE) {
      logger.warn("Tournament already in progress");
      return;
    }

    // Initialize agent hypothesis map for this tournament
    // (Clear any stale data from previous tournaments in same session)
    const agentHypothesisMap = new Map<string, string>();

    // Track this map for cleanup on unmount
    activeHypothesisMapRef.current = agentHypothesisMap;

    // Validate file size if provided (defense in depth)
    if (file && file.data) {
      const fileSizeBytes = (file.data.length * 3) / 4; // Approximate original size from base64
      const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
      if (fileSizeBytes > MAX_FILE_SIZE) {
        setError(
          `File too large (${(fileSizeBytes / 1024 / 1024).toFixed(
            1
          )}MB). Maximum 20MB.`
        );
        return;
      }
    }

    setAppState(AppState.GENERATING_AGENTS);
    setError(null);
    setLoadingStatus("Synthesizing...");

    try {
      // 1. Generate Agents
      const agents = await generateAgents(userInput, file);

      if (!isMounted.current) return;

      // Validate agent count (defense in depth)
      if (!agents || !Array.isArray(agents) || agents.length === 0) {
        throw new Error("Agent generation failed: No agents returned");
      }

      if (agents.length !== 8) {
        throw new Error(
          `Expected 8 agents, got ${agents.length}. Cannot create tournament bracket.`
        );
      }

      // Validate all agents have required fields
      const invalidAgents = agents.filter(
        (a) => !a || !a.id || !a.name || !a.initialHypothesis
      );
      if (invalidAgents.length > 0) {
        throw new Error(
          `${invalidAgents.length} agents have missing required fields`
        );
      }

      // Initialize Empty Bracket Structure
      const initialMatches: MatchResult[] = [
        // Quarterfinals (0-3) - Fixed seeds: 0v1, 2v3, 4v5, 6v7
        {
          matchId: "m1",
          round: "Quarterfinal",
          agent1Id: agents[0].id,
          agent2Id: agents[1].id,
          status: "pending",
        },
        {
          matchId: "m2",
          round: "Quarterfinal",
          agent1Id: agents[2].id,
          agent2Id: agents[3].id,
          status: "pending",
        },
        {
          matchId: "m3",
          round: "Quarterfinal",
          agent1Id: agents[4].id,
          agent2Id: agents[5].id,
          status: "pending",
        },
        {
          matchId: "m4",
          round: "Quarterfinal",
          agent1Id: agents[6].id,
          agent2Id: agents[7].id,
          status: "pending",
        },
        // Semifinals (4-5) - Placeholders
        {
          matchId: "m5",
          round: "Semifinal",
          agent1Id: null,
          agent2Id: null,
          status: "pending",
        },
        {
          matchId: "m6",
          round: "Semifinal",
          agent1Id: null,
          agent2Id: null,
          status: "pending",
        },
        // Final (6)
        {
          matchId: "m7",
          round: "Final",
          agent1Id: null,
          agent2Id: null,
          status: "pending",
        },
      ];

      setTournamentData({
        tournamentId: `tourney-${Date.now()}`,
        agents,
        matches: initialMatches,
        // Store original context (file reference only, not data to save memory)
        // File data is passed directly from closure, not stored in state
        originalContext: {
          userInput,
          // Don't store file data in state to prevent memory bloat
          // File is available in closure and passed to functions
          file: undefined,
        },
      });

      // Switch to View immediately so user sees agents
      setAppState(AppState.RUNNING_TOURNAMENT);

      // 2. Run Quarterfinals (Parallel-ish)
      // Validate we have exactly 8 agents before proceeding
      if (agents.length !== 8) {
        throw new Error(`Expected 8 agents, got ${agents.length}`);
      }

      const runMatchSafe = async (m: MatchResult) => {
        if (!isMounted.current) return m; // Abort if unmounted
        updateMatch(m.matchId, { status: "running" });
        try {
          if (!m.agent1Id || !m.agent2Id) throw new Error("Missing agents");
          const agent1 = agents.find((a) => a.id === m.agent1Id);
          const agent2 = agents.find((a) => a.id === m.agent2Id);

          if (!agent1 || !agent2) {
            throw new Error(`Agents not found for match ${m.matchId}`);
          }

          // Update agents with their current evolved hypotheses if they've won before
          const agent1WithEvolution = {
            ...agent1,
            currentHypothesis:
              agentHypothesisMap.get(agent1.id) || agent1.initialHypothesis,
          };
          const agent2WithEvolution = {
            ...agent2,
            currentHypothesis:
              agentHypothesisMap.get(agent2.id) || agent2.initialHypothesis,
          };

          const result = await simulateMatch(
            userInput,
            agent1WithEvolution,
            agent2WithEvolution,
            m.round,
            file // Pass file context to every match
          );

          // Store the evolved hypothesis for the winner
          // Validate and fix winnerId using utility function
          if (result.winnerId && result.evolvedHypothesis) {
            try {
              const validWinnerId = validateWinnerId(
                result.winnerId,
                agent1,
                agent2,
                agents
              );
              result.winnerId = validWinnerId;
              agentHypothesisMap.set(validWinnerId, result.evolvedHypothesis);
            } catch (error: any) {
              logger.error(
                `Winner validation failed for match ${m.matchId}:`,
                error.message
              );
              throw error;
            }
          }

          if (isMounted.current) {
            updateMatch(m.matchId, { ...result, status: "completed" });
          }
          return { ...m, ...result, status: "completed" } as MatchResult;
        } catch (e) {
          logger.error(`Match ${m.matchId} failed`, e);
          throw e; // Propagate error to stop the chain
        }
      };

      const qfPromises = initialMatches.slice(0, 4).map((m) => runMatchSafe(m));

      // Use Promise.allSettled to handle partial failures gracefully
      const qfSettled = await Promise.allSettled(qfPromises);

      if (!isMounted.current) return;

      // Check if any matches failed
      const qfFailures = qfSettled.filter((r) => r.status === "rejected");
      if (qfFailures.length > 0) {
        const failureReasons = qfFailures
          .map((f: any) => f.reason?.message || "Unknown error")
          .join("; ");

        // Surface error to user with actionable message
        const errorMsg = `${qfFailures.length} of 4 quarterfinal matches failed. ${failureReasons}`;
        logger.error("Quarterfinal failures:", errorMsg);
        throw new Error(errorMsg);
      }

      // Extract successful results
      const qfResults = qfSettled
        .filter(
          (r): r is PromiseFulfilledResult<MatchResult> =>
            r.status === "fulfilled"
        )
        .map((r) => r.value);

      if (!isMounted.current) return;

      // 3. Setup Semifinals
      const sf1Agents = [qfResults[0].winnerId, qfResults[1].winnerId];
      const sf2Agents = [qfResults[2].winnerId, qfResults[3].winnerId];

      // Validate all winners exist
      if (!sf1Agents[0] || !sf1Agents[1] || !sf2Agents[0] || !sf2Agents[1]) {
        throw new Error("Quarterfinal matches did not produce valid winners");
      }

      // Update SF slots and create match objects with correct agent IDs
      updateMatch("m5", { agent1Id: sf1Agents[0], agent2Id: sf1Agents[1] });
      updateMatch("m6", { agent1Id: sf2Agents[0], agent2Id: sf2Agents[1] });

      // Run Semifinals - use fresh match objects with populated agent IDs
      const m5: MatchResult = {
        matchId: "m5",
        round: "Semifinal",
        agent1Id: sf1Agents[0],
        agent2Id: sf1Agents[1],
        status: "pending",
      };
      const m6: MatchResult = {
        matchId: "m6",
        round: "Semifinal",
        agent1Id: sf2Agents[0],
        agent2Id: sf2Agents[1],
        status: "pending",
      };

      // Use Promise.allSettled for semifinals too
      const sfSettled = await Promise.allSettled([
        runMatchSafe(m5),
        runMatchSafe(m6),
      ]);

      // Check for failures
      const sfFailures = sfSettled.filter((r) => r.status === "rejected");
      if (sfFailures.length > 0) {
        const failureReasons = sfFailures
          .map((f: any) => f.reason?.message || "Unknown error")
          .join("; ");

        // Surface error to user with actionable message
        const errorMsg = `${sfFailures.length} of 2 semifinal matches failed. ${failureReasons}`;
        logger.error("Semifinal failures:", errorMsg);
        throw new Error(errorMsg);
      }

      // Extract successful results
      const sfResults = sfSettled
        .filter(
          (r): r is PromiseFulfilledResult<MatchResult> =>
            r.status === "fulfilled"
        )
        .map((r) => r.value);

      if (!isMounted.current) return;

      // 4. Setup Final
      const finalAgents = [sfResults[0].winnerId, sfResults[1].winnerId];

      // Validate semifinal winners exist
      if (!finalAgents[0] || !finalAgents[1]) {
        throw new Error("Semifinal matches did not produce valid winners");
      }

      updateMatch("m7", {
        agent1Id: finalAgents[0],
        agent2Id: finalAgents[1],
      });

      // Run Final - use fresh match object with populated agent IDs
      const m7: MatchResult = {
        matchId: "m7",
        round: "Final",
        agent1Id: finalAgents[0],
        agent2Id: finalAgents[1],
        status: "pending",
      };
      const finalResult = await runMatchSafe(m7);

      if (!isMounted.current) return;

      // 5. Generate Winning Brief with full tournament context
      setAppState(AppState.GENERATING_BRIEF);

      // Validate final result has winner
      if (!finalResult.winnerId) {
        throw new Error("Final match completed but no winner was determined");
      }

      const winner = agents.find((a) => a.id === finalResult.winnerId);

      if (!winner) {
        throw new Error(
          `Winner with ID ${finalResult.winnerId} not found in agents array`
        );
      }

      if (!finalResult.evolvedHypothesis) {
        throw new Error("Final match missing evolved hypothesis");
      }

      // Collect defeated agents for context
      const allMatches = [...qfResults, ...sfResults, finalResult];
      const defeatedAgentIds = new Set<string>();
      allMatches.forEach((match) => {
        if (match.agent1Id && match.agent1Id !== match.winnerId) {
          defeatedAgentIds.add(match.agent1Id);
        }
        if (match.agent2Id && match.agent2Id !== match.winnerId) {
          defeatedAgentIds.add(match.agent2Id);
        }
      });

      const defeatedAgents = Array.from(defeatedAgentIds)
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is Agent => a !== undefined)
        .map((a) => `${a.name} (${a.role})`);

      // Build evolution path
      const qfMatch = qfResults.find((m) => m.winnerId === winner.id);
      const sfMatch = sfResults.find((m) => m.winnerId === winner.id);
      const evolutionPath = `Quarterfinal (defeated ${
        qfMatch
          ? agents.find(
              (a) =>
                a.id ===
                (qfMatch.agent1Id === winner.id
                  ? qfMatch.agent2Id
                  : qfMatch.agent1Id)
            )?.name || "opponent"
          : "opponent"
      }) → Semifinal (defeated ${
        sfMatch
          ? agents.find(
              (a) =>
                a.id ===
                (sfMatch.agent1Id === winner.id
                  ? sfMatch.agent2Id
                  : sfMatch.agent1Id)
            )?.name || "opponent"
          : "opponent"
      }) → Final (defeated ${
        agents.find(
          (a) =>
            a.id ===
            (finalResult.agent1Id === winner.id
              ? finalResult.agent2Id
              : finalResult.agent1Id)
        )?.name || "opponent"
      })`;

      // Collect key debates with arguments for rich context
      // Type-safe construction matching TournamentContext interface
      const keyDebates: Array<{
        round: string;
        opponent: string;
        fatalFlaw: string;
        evolvedHypothesis: string;
        scores?: {
          novelty: number;
          feasibility: number;
          impact: number;
          ethics: number;
        };
      }> = [
        qfMatch && {
          round: "Quarterfinal",
          opponent: qfMatch
            ? agents.find(
                (a) =>
                  a.id ===
                  (qfMatch.agent1Id === winner.id
                    ? qfMatch.agent2Id
                    : qfMatch.agent1Id)
              )?.name || "opponent"
            : "opponent",
          fatalFlaw: qfMatch.fatalFlaw || "Not specified",
          evolvedHypothesis: qfMatch.evolvedHypothesis || "",
          scores: qfMatch.scores,
        },
        sfMatch && {
          round: "Semifinal",
          opponent: sfMatch
            ? agents.find(
                (a) =>
                  a.id ===
                  (sfMatch.agent1Id === winner.id
                    ? sfMatch.agent2Id
                    : sfMatch.agent1Id)
              )?.name || "opponent"
            : "opponent",
          fatalFlaw: sfMatch.fatalFlaw || "Not specified",
          evolvedHypothesis: sfMatch.evolvedHypothesis || "",
          scores: sfMatch.scores,
        },
        {
          round: "Final",
          opponent:
            agents.find(
              (a) =>
                a.id ===
                (finalResult.agent1Id === winner.id
                  ? finalResult.agent2Id
                  : finalResult.agent1Id)
            )?.name || "opponent",
          fatalFlaw: finalResult.fatalFlaw || "Not specified",
          evolvedHypothesis: finalResult.evolvedHypothesis || "",
          scores: finalResult.scores,
        },
      ].filter(
        (d): d is NonNullable<typeof d> => d !== null && d !== undefined
      );

      const brief = await generateBrief(
        winner,
        finalResult.evolvedHypothesis,
        {
          initialHypothesis: winner.initialHypothesis,
          defeatedAgents,
          finalScore: finalResult.scores?.total || 0,
          evolutionPath,
          keyDebates,
        },
        file // Pass file context to brief generation
      );

      if (isMounted.current) {
        setTournamentData((prev: TournamentData | null) =>
          prev ? { ...prev, winningBrief: brief } : null
        );
        setAppState(AppState.COMPLETE);
      }
    } catch (e: any) {
      logger.error("Tournament error:", e);
      if (isMounted.current) {
        setError(e.message || "Simulation failed. Please try again.");
        setAppState(AppState.IDLE);
        // Clear tournament data on error to prevent stale state
        setTournamentData(null);
      }
    } finally {
      // Cleanup: Clear hypothesis map to prevent memory leaks
      agentHypothesisMap.clear();

      // Clear ref if this is still the active map
      if (activeHypothesisMapRef.current === agentHypothesisMap) {
        activeHypothesisMapRef.current = null;
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
      <div className="relative z-10">
        {appState === AppState.IDLE ||
        appState === AppState.GENERATING_AGENTS ? (
          <div className="flex flex-col min-h-screen">
            <div className="flex-1 flex flex-col justify-center">
              <InputSection
                onSubmit={startTournament}
                isLoading={appState === AppState.GENERATING_AGENTS}
                loadingStatus={loadingStatus}
              />

              {error && (
                <div className="max-w-md mx-auto mt-4 p-4 bg-red-950/50 border border-red-900 rounded-lg text-red-200 text-sm text-center animate-pulse">
                  {error}
                </div>
              )}
            </div>
          </div>
        ) : (
          tournamentData && (
            <LazyLoadErrorBoundary
              fallback={
                <div className="min-h-screen bg-void flex items-center justify-center">
                  <div className="max-w-md text-center space-y-4 p-6">
                    <div className="text-4xl">⚠️</div>
                    <h2 className="text-xl font-bold text-white">
                      Failed to Load Tournament View
                    </h2>
                    <p className="text-slate-400 text-sm">
                      There was an error loading the tournament interface.
                      Please refresh the page.
                    </p>
                    <button
                      onClick={() => window.location.reload()}
                      className="mt-4 px-6 py-3 bg-white text-black font-bold text-sm rounded-lg hover:bg-slate-200 transition-colors"
                    >
                      Reload Page
                    </button>
                  </div>
                </div>
              }
            >
              <Suspense
                fallback={
                  <div className="min-h-screen bg-void flex items-center justify-center">
                    <div className="text-center space-y-4">
                      <div className="text-4xl animate-spin">⚛️</div>
                      <p className="text-slate-400 font-mono text-sm">
                        Loading Tournament View...
                      </p>
                    </div>
                  </div>
                }
              >
                <TournamentView
                  data={tournamentData}
                  onNewTournament={async () => {
                    // Clear from localStorage before clearing state
                    try {
                      const { clearTournament } = await import(
                        "./services/utils/persistenceUtils"
                      );
                      clearTournament();
                    } catch (error) {
                      logger.error("Failed to clear storage:", error);
                    }

                    // Then clear React state
                    setTournamentData(null);
                    setAppState(AppState.IDLE);
                    setError(null);
                  }}
                />
              </Suspense>
            </LazyLoadErrorBoundary>
          )
        )}
      </div>
    </div>
  );
};

export default App;
