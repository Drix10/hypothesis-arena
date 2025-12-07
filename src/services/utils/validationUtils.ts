import { TournamentData, Agent, MatchResult } from "../../types";

/**
 * Validates agent structure with comprehensive checks.
 */
const isValidAgent = (agent: any): agent is Agent => {
  // Validate ID format with strict rules:
  // - Must be non-empty string
  // - Must not be placeholder strings like "null", "undefined"
  // - Must not be whitespace-only
  // - Must match expected format (alphanumeric with hyphens/underscores)
  const hasValidId =
    agent &&
    typeof agent.id === "string" &&
    agent.id.length > 0 &&
    agent.id !== "null" &&
    agent.id !== "undefined" &&
    agent.id.trim().length > 0 &&
    /^[a-zA-Z0-9_-]+$/.test(agent.id); // Only alphanumeric, hyphens, underscores

  return (
    hasValidId &&
    typeof agent === "object" &&
    typeof agent.name === "string" &&
    agent.name.trim().length > 0 && // Name must not be whitespace-only
    typeof agent.role === "string" &&
    agent.role.trim().length > 0 && // Role must not be whitespace-only
    typeof agent.initialHypothesis === "string" &&
    agent.initialHypothesis.trim().length > 10 // Hypothesis must be substantial
  );
};

/**
 * Validates match result structure.
 */
const isValidMatch = (match: any): match is MatchResult => {
  return (
    match &&
    typeof match === "object" &&
    typeof match.matchId === "string" &&
    typeof match.round === "string" &&
    ["Quarterfinal", "Semifinal", "Final"].includes(match.round) &&
    typeof match.agent1Id === "string" &&
    typeof match.agent2Id === "string" &&
    typeof match.winnerId === "string" &&
    typeof match.evolvedHypothesis === "string" &&
    typeof match.debateDialogue === "string"
  );
};

/**
 * Validates scores object.
 */
const isValidScores = (scores: any): boolean => {
  // Check all scores are valid numbers (not NaN, not Infinity)
  const isValidNumber = (n: any): n is number =>
    typeof n === "number" &&
    !isNaN(n) &&
    isFinite(n);

  return (
    scores &&
    typeof scores === "object" &&
    isValidNumber(scores.novelty) &&
    isValidNumber(scores.feasibility) &&
    isValidNumber(scores.impact) &&
    isValidNumber(scores.ethics) &&
    scores.novelty >= 0 &&
    scores.novelty <= 10 &&
    scores.feasibility >= 0 &&
    scores.feasibility <= 10 &&
    scores.impact >= 0 &&
    scores.impact <= 10 &&
    scores.ethics >= 0 &&
    scores.ethics <= 10
  );
};

/**
 * Validates and repairs tournament data with comprehensive error handling.
 * Applies default values where optional fields are missing.
 * 
 * @param data - Raw object parsed from JSON
 * @returns Validated TournamentData object
 * @throws {Error} If critical data is missing or malformed
 */
export const validateAndRepairTournament = (data: any): TournamentData => {
  if (!data || typeof data !== "object") {
    throw new Error("Tournament data must be a non-null object");
  }

  // Generate tournament ID if missing
  data.tournamentId =
    data.tournamentId ||
    `arena-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  // Validate agents array
  if (!Array.isArray(data.agents)) {
    throw new Error("Tournament data missing 'agents' array");
  }

  if (data.agents.length !== 8) {
    throw new Error(
      `Tournament must contain exactly 8 agents, found ${data.agents.length}`
    );
  }

  // Validate and repair each agent
  const agentIds = new Set<string>();
  data.agents.forEach((agent: any, index: number) => {
    if (!isValidAgent(agent)) {
      throw new Error(
        `Agent at index ${index} is invalid. Must have: id, name, role, initialHypothesis`
      );
    }

    // Ensure ID is not null/undefined (additional safety check)
    if (!agent.id || agent.id === "null" || agent.id === "undefined") {
      throw new Error(`Agent at index ${index} has invalid ID: ${agent.id}`);
    }

    // Check for duplicate IDs
    if (agentIds.has(agent.id)) {
      throw new Error(`Duplicate agent ID detected: ${agent.id}`);
    }
    agentIds.add(agent.id);

    // Apply defaults for optional fields
    agent.avatarEmoji = agent.avatarEmoji || "🧪";
    agent.expertise = agent.expertise || "General Research";
    agent.voiceStyle = agent.voiceStyle || "Analytical";
  });

  // Validate matches array
  if (!Array.isArray(data.matches)) {
    throw new Error("Tournament data missing 'matches' array");
  }

  if (data.matches.length !== 7) {
    throw new Error(
      `Tournament must contain exactly 7 matches (single elimination), found ${data.matches.length}`
    );
  }

  // Validate each match
  data.matches.forEach((match: any, index: number) => {
    if (!isValidMatch(match)) {
      throw new Error(
        `Match at index ${index} is invalid (ID: ${match?.matchId}). Round name '${match?.round}' is likely invalid (Must be Quarterfinal, Semifinal, or Final). Check also: winnerId, debateDialogue.`
      );
    }

    // Verify agent IDs exist and are not null/undefined strings
    if (match.agent1Id && match.agent1Id !== "null" && match.agent1Id !== "undefined" && !agentIds.has(match.agent1Id)) {
      throw new Error(`Match ${match.matchId}: agent1Id '${match.agent1Id}' not found in agents array`);
    }
    if (match.agent2Id && match.agent2Id !== "null" && match.agent2Id !== "undefined" && !agentIds.has(match.agent2Id)) {
      throw new Error(`Match ${match.matchId}: agent2Id '${match.agent2Id}' not found in agents array`);
    }
    if (match.winnerId && match.winnerId !== "null" && match.winnerId !== "undefined" && !agentIds.has(match.winnerId)) {
      throw new Error(`Match ${match.matchId}: winnerId '${match.winnerId}' not found in agents array`);
    }

    // Validate scores
    if (!match.scores) {
      match.scores = {
        novelty: 0,
        feasibility: 0,
        impact: 0,
        ethics: 0,
        total: 0,
      };
    }

    if (!isValidScores(match.scores)) {
      throw new Error(
        `Match ${match.matchId}: scores invalid. Must have novelty, feasibility, impact, ethics (0-10)`
      );
    }

    // Recalculate total to ensure consistency
    match.scores.total =
      match.scores.novelty +
      match.scores.feasibility +
      match.scores.impact +
      match.scores.ethics;

    // Ensure fatalFlaw exists (optional field but good practice)
    match.fatalFlaw = match.fatalFlaw || "No critical flaw identified";
  });

  // Validate winning brief
  if (!data.winningBrief || typeof data.winningBrief !== "object") {
    throw new Error("Tournament data missing 'winningBrief' object");
  }

  const requiredBriefFields = ["title", "abstract", "oneSentenceTweet", "veoVideoPrompt"];
  for (const field of requiredBriefFields) {
    if (!data.winningBrief[field] || typeof data.winningBrief[field] !== "string") {
      throw new Error(`winningBrief missing required field: ${field}`);
    }
  }

  // Apply defaults for optional brief fields
  data.winningBrief.predictedImpact = data.winningBrief.predictedImpact || "";
  data.winningBrief.costAndTimeline = data.winningBrief.costAndTimeline || "";

  return data as TournamentData;
};