import { GoogleGenAI } from "@google/genai";
import { TournamentData, MatchResult, Agent } from "../types";
import { validateAndRepairTournament } from "./utils/validationUtils";
import { logger } from "./utils/logger";

// ═════════════════════════════════════════════════════════════════════════════
// PERFORMANCE MONITORING & HEALTH CHECKS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tests API connectivity and configuration without consuming significant quota.
 * 
 * @returns Object with health status and any configuration warnings
 * 
 * @example
 * ```typescript
 * const health = await checkAPIHealth();
 * if (!health.isHealthy) {
 *   console.error("API issues:", health.errors);
 * }
 * ```
 */
export const checkAPIHealth = async (): Promise<{
  isHealthy: boolean;
  geminiConfigured: boolean;
  errors: string[];
  warnings: string[];
}> => {
  const errors: string[] = [];
  const warnings: string[] = [];
  let geminiConfigured = false;

  // Check API key
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) {
    errors.push("API_KEY environment variable not set");
  } else if (apiKey.length < 20) {
    warnings.push("API_KEY appears too short—verify it's correct");
    geminiConfigured = true;
  } else {
    geminiConfigured = true;
  }

  // Try to instantiate client (doesn't consume quota)
  try {
    if (apiKey) {
      new GoogleGenAI({ apiKey });
    } else {
      // Only error if we try to instantiate without key
      // errors.push already handled missing key case
    }
  } catch (error: any) {
    errors.push(`Client instantiation failed: ${error.message}`);
  }

  const isHealthy = errors.length === 0;

  return {
    isHealthy,
    geminiConfigured,
    errors,
    warnings,
  };
};

/**
 * Validates tournament structure without running the full tournament.
 * Useful for testing data integrity and debugging malformed responses.
 * 
 * @param data - Tournament data object to validate
 * @returns true if valid, false if validation fails
 */
export const validateTournamentStructure = (data: TournamentData): boolean => {
  try {
    validateAndRepairTournament(data);
    return true;
  } catch (error: any) {
    logger.error("[validateTournamentStructure] Validation failed:", error);
    return false;
  }
};

/**
 * Extracts all unique agent IDs from tournament for consistency checking.
 * 
 * @param data - Tournament data object
 * @returns Array of agent ID strings
 */
export const extractAgentIds = (data: TournamentData): string[] => {
  if (!data || !Array.isArray(data.agents)) {
    return [];
  }
  return data.agents.map((agent: Agent) => agent.id);
};

/**
 * Analyzes match progression to ensure proper bracket structure.
 * Useful for debugging tournament logic issues.
 * 
 * @param data - Tournament data object
 * @returns Bracket structure analysis with warnings
 */
export const analyzeBracketStructure = (data: TournamentData): {
  isValid: boolean;
  roundCounts: Record<string, number>;
  warnings: string[];
} => {
  const roundCounts: Record<string, number> = {
    "Quarterfinal": 0,
    "Semifinal": 0,
    "Final": 0,
  };

  const warnings: string[] = [];

  if (!data || !Array.isArray(data.matches)) {
    return { isValid: false, roundCounts, warnings: ["No matches array found"] };
  }

  // Count matches per round
  data.matches.forEach((match: MatchResult) => {
    if (match.round in roundCounts) {
      roundCounts[match.round]++;
    } else {
      // It might be a valid round name but not one we initialized
      roundCounts[match.round] = (roundCounts[match.round] || 0) + 1;
      if (!["Quarterfinal", "Semifinal", "Final"].includes(match.round)) {
        warnings.push(`Unknown round type: ${match.round}`);
      }
    }
  });

  // Expected counts for 8-agent single elimination (4 QF, 2 SF, 1 Final)
  // Note: The previous monolithic code used "Round of 16" in some comments but "Quarterfinal" in types.
  // Our schema enforces: Quarterfinal, Semifinal, Final.
  const expectedCounts = {
    "Quarterfinal": 4,
    "Semifinal": 2,
    "Final": 1,
  };

  // Validate counts
  let isValid = true;
  Object.entries(expectedCounts).forEach(([round, expected]) => {
    if (roundCounts[round] !== expected) {
      warnings.push(`Expected ${expected} matches in ${round}, found ${roundCounts[round]}`);
      isValid = false;
    }
  });

  return { isValid, roundCounts, warnings };
};

/**
 * Calculates aggregate statistics across all matches in tournament.
 * 
 * @param data - Tournament data object
 * @returns Statistical summary of tournament quality
 */
export const calculateTournamentStats = (data: TournamentData): {
  avgNovelty: number;
  avgFeasibility: number;
  avgImpact: number;
  avgEthics: number;
  avgTotal: number;
  highestScoringMatch: string | null;
  lowestScoringMatch: string | null;
} => {
  if (!data || !Array.isArray(data.matches) || data.matches.length === 0) {
    return {
      avgNovelty: 0,
      avgFeasibility: 0,
      avgImpact: 0,
      avgEthics: 0,
      avgTotal: 0,
      highestScoringMatch: null,
      lowestScoringMatch: null,
    };
  }

  let sumNovelty = 0;
  let sumFeasibility = 0;
  let sumImpact = 0;
  let sumEthics = 0;
  let sumTotal = 0;
  let validMatchCount = 0;

  let highestScore = -Infinity;
  let lowestScore = Infinity;
  let highestMatch: string | null = null;
  let lowestMatch: string | null = null;

  data.matches.forEach((match: MatchResult) => {
    if (match.scores) {
      sumNovelty += match.scores.novelty || 0;
      sumFeasibility += match.scores.feasibility || 0;
      sumImpact += match.scores.impact || 0;
      sumEthics += match.scores.ethics || 0;
      sumTotal += match.scores.total || 0;
      validMatchCount++;

      const total = match.scores.total || 0;
      if (total > highestScore) {
        highestScore = total;
        highestMatch = match.matchId;
      }
      if (total < lowestScore) {
        lowestScore = total;
        lowestMatch = match.matchId;
      }
    }
  });

  // Prevent division by zero
  const count = validMatchCount > 0 ? validMatchCount : 1;

  return {
    avgNovelty: sumNovelty / count,
    avgFeasibility: sumFeasibility / count,
    avgImpact: sumImpact / count,
    avgEthics: sumEthics / count,
    avgTotal: sumTotal / count,
    highestScoringMatch: highestMatch,
    lowestScoringMatch: lowestMatch,
  };
};