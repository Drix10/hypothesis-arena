import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import {
  GEMINI_MODEL,
  MAX_OUTPUT_TOKENS,
  AGENT_GENERATION_PROMPT,
  AGENTS_SCHEMA,
  MATCH_SIMULATION_PROMPT,
  MATCH_RESULT_SCHEMA,
  BRIEF_GENERATION_PROMPT,
  WINNING_BRIEF_SCHEMA
} from "../constants";
import { Agent, MatchResult, WinningBrief } from "../types";
import { extractCleanJson, safeJsonParse } from "./utils/jsonUtils";
import { retryWithBackoff } from "./utils/retryUtils";
import { logger } from "./utils/logger";

import { getApiKey } from "./apiKeyManager";

/**
 * Initialize AI client with API key from memory (BYOK)
 * @returns Configured AI client instance
 * @throws Error if API key is not configured
 */
const getAiClient = () => {
  const apiKey = getApiKey();

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("API key not configured. Please provide your Gemini API key.");
  }

  // Create new instance each time to ensure fresh API key is used
  // This prevents stale key issues if user changes key mid-session
  return new GoogleGenAI({ apiKey });
};

const SAFETY_SETTINGS = [
  // Allow academic debate that may touch on sensitive topics, but block explicit harassment
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  // Allow discussion of potentially dangerous research (e.g., gain-of-function, AI safety)
  // but rely on the GUARDIAN agent to raise ethical concerns
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/**
 * PHASE 1: Generate 8 specialized AI research agents based on user input
 * 
 * Creates diverse researcher archetypes with unique expertise, roles, and debate styles
 * tailored to the research topic. Each agent receives a unique ID (agent-0 through agent-7)
 * for consistent bracket logic.
 * 
 * @param userInput - Research hypothesis or topic to generate agents for
 * @param file - Optional file context (PDF, image, text) to inform agent generation
 * @returns Array of exactly 8 Agent objects with unique IDs and characteristics
 * @throws Error if agent generation fails or doesn't produce exactly 8 agents
 */
export const generateAgents = async (userInput: string, file?: { mimeType: string; data: string }): Promise<Agent[]> => {
  // Input validation
  if (!userInput || typeof userInput !== 'string' || userInput.trim().length === 0) {
    throw new Error("User input is required and must be a non-empty string");
  }

  if (userInput.trim().length > 10000) {
    throw new Error("User input exceeds maximum length of 10,000 characters");
  }

  return retryWithBackoff(async () => {
    const ai = getAiClient();

    const inputParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: AGENT_GENERATION_PROMPT },
      { text: `USER INPUT: "${userInput.trim()}"` }
    ];

    // Validate file before sending
    if (file && file.data && file.data.length > 0) {
      // Validate MIME type
      const validMimeTypes = ['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
      if (!validMimeTypes.includes(file.mimeType)) {
        logger.warn(`Invalid MIME type for file: ${file.mimeType}. Skipping file attachment.`);
      } else {
        inputParts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
      }
    }

    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: { parts: inputParts },
      config: {
        responseMimeType: "application/json",
        responseSchema: AGENTS_SCHEMA,
        temperature: 0.9,
        safetySettings: SAFETY_SETTINGS,
      }
    });

    const parsed = safeJsonParse(extractCleanJson(result.text || "{}"), "generateAgents");

    if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length !== 8) {
      throw new Error(`Failed to generate exactly 8 agents. Received ${parsed.agents?.length || 0}. Please try again.`);
    }

    // Ensure we map standard IDs 0-7 for easier bracket logic
    // Also validate and provide defaults for optional fields
    return parsed.agents.map((a: any, i: number) => ({
      ...a,
      id: `agent-${i}`, // Override ID to ensure consistency for bracket
      expertise: a.expertise || a.role || "General Research",
      voiceStyle: a.voiceStyle || "Analytical",
      avatarEmoji: a.avatarEmoji || "🧪",
    }));
  }, { maxRetries: 2 });
};

/**
 * PHASE 2: Simulate a debate match between two agents
 * 
 * Orchestrates a structured debate with 12+ exchanges where agents critique each other's
 * hypotheses. The AI judges the debate and produces:
 * - Full debate dialogue transcript
 * - Winner determination
 * - Evolved hypothesis (refined version of winner's hypothesis)
 * - Multi-dimensional scores (novelty, feasibility, impact, ethics)
 * - Fatal flaw identified in losing hypothesis
 * 
 * Uses currentHypothesis if available (for evolved hypotheses in later rounds),
 * otherwise falls back to initialHypothesis.
 * 
 * @param topic - Original user input topic
 * @param agent1 - First agent with their current hypothesis
 * @param agent2 - Second agent with their current hypothesis
 * @param round - Current round name (Quarterfinal, Semifinal, Final)
 * @param file - Optional file context (PDF, image, text) to include in debate
 * @returns Partial MatchResult with debate outcome, scores, and evolved hypothesis
 * @throws Error if debate quality is insufficient or required fields are missing
 */
export const simulateMatch = async (
  topic: string,
  agent1: Agent,
  agent2: Agent,
  round: string,
  file?: { mimeType: string; data: string }
): Promise<Partial<MatchResult>> => {
  // Input validation
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    throw new Error("Topic is required for match simulation");
  }

  if (!agent1 || !agent2) {
    throw new Error("Both agents are required for match simulation");
  }

  if (!agent1.initialHypothesis || !agent2.initialHypothesis) {
    throw new Error("Both agents must have initial hypotheses");
  }

  // Wrap in retry logic for debate quality issues
  return retryWithBackoff(async () => {
    const ai = getAiClient();

    // Use evolved hypothesis if available, otherwise use initial
    const agent1Hypothesis = agent1.currentHypothesis || agent1.initialHypothesis;
    const agent2Hypothesis = agent2.currentHypothesis || agent2.initialHypothesis;

    // Sanitize inputs to prevent prompt injection
    // Comprehensive sanitization to prevent various injection attacks
    const sanitize = (text: string): string => {
      if (!text || typeof text !== 'string') return '';

      return text
        // Break template markers (both {{ and }})
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }')
        // Escape other potential injection vectors
        .replace(/\$\{/g, '$ {')  // Template literals
        .replace(/`/g, "'")        // Backticks
        // Remove control characters (except newlines and tabs)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Limit consecutive newlines to prevent prompt flooding
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
    };

    const prompt = MATCH_SIMULATION_PROMPT
      .replace(/\{\{AGENT_A_ID\}\}/g, agent1.id)
      .replace(/\{\{AGENT_B_ID\}\}/g, agent2.id)
      .replace('{{TOPIC}}', sanitize(topic))
      .replace('{{ROUND}}', sanitize(round))
      .replace('{{AGENT_A_NAME}}', sanitize(agent1.name))
      .replace('{{AGENT_A_ROLE}}', sanitize(agent1.role))
      .replace('{{AGENT_A_HYPOTHESIS}}', sanitize(agent1Hypothesis))
      .replace('{{AGENT_B_NAME}}', sanitize(agent2.name))
      .replace('{{AGENT_B_ROLE}}', sanitize(agent2.role))
      .replace('{{AGENT_B_HYPOTHESIS}}', sanitize(agent2Hypothesis));

    // Build input parts with file context if available
    const inputParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];

    // Validate file before sending
    if (file && file.data && file.data.length > 0) {
      // Validate MIME type
      const validMimeTypes = ['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
      if (!validMimeTypes.includes(file.mimeType)) {
        logger.warn(`Invalid MIME type for file in match: ${file.mimeType}. Skipping file attachment.`);
      } else {
        // Add explicit instruction to reference the file
        inputParts.push({
          text: "\n\nIMPORTANT: The attached file contains critical context for this debate. " +
            "Both agents MUST reference specific details, data, figures, or arguments from this document. " +
            "Debates should cite page numbers, sections, or specific claims from the provided material."
        });
        inputParts.push({
          inlineData: {
            mimeType: file.mimeType,
            data: file.data
          }
        });
      }
    }

    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: { parts: inputParts },
      config: {
        responseMimeType: "application/json",
        responseSchema: MATCH_RESULT_SCHEMA,
        temperature: 1.0, // High temperature for dynamic debate
        maxOutputTokens: MAX_OUTPUT_TOKENS, // Ensure enough length for dialogue
        safetySettings: SAFETY_SETTINGS,
      }
    });

    const parsed = safeJsonParse(extractCleanJson(result.text || "{}"), "simulateMatch");

    // Validate debate quality
    if (!parsed.debateDialogue || typeof parsed.debateDialogue !== 'string') {
      throw new Error("Match simulation failed: No debate dialogue generated");
    }

    // Check for minimum debate length (rough heuristic: 12 exchanges ≈ 2000+ characters)
    const DEBATE_MIN_LENGTH = 1500; // Minimum characters for debate quality
    if (parsed.debateDialogue.length < DEBATE_MIN_LENGTH) {
      logger.warn(`Match debate seems short (${parsed.debateDialogue.length} chars). Expected 2000+`);
    }

    // Validate minimum turn count (12 exchanges = 24 turns minimum)
    // Count turns by looking for double newlines (turn separators)
    const turns = (parsed.debateDialogue.match(/\n\n/g) || []).length + 1;
    const MIN_TURNS = 10; // Reduced from 12 to be more lenient
    if (turns < MIN_TURNS) {
      throw new Error(
        `Debate has only ${turns} exchanges, minimum ${MIN_TURNS} required. ` +
        `This indicates poor debate quality. Retrying...`
      );
    }

    // Warn if debate is short but acceptable
    if (turns < 12) {
      logger.warn(`Debate has ${turns} exchanges (recommended: 12+). Proceeding anyway.`);
    }

    // Validate required fields
    if (!parsed.winnerId || !parsed.evolvedHypothesis || !parsed.scores) {
      throw new Error("Match simulation incomplete: Missing winnerId, evolvedHypothesis, or scores");
    }

    // Validate score bounds (0-10 for each dimension)
    const { novelty, feasibility, impact, ethics } = parsed.scores;

    // Check for NaN or invalid numbers first
    const isValidNumber = (n: number): boolean => typeof n === 'number' && !isNaN(n) && isFinite(n);

    if (!isValidNumber(novelty) || !isValidNumber(feasibility) ||
      !isValidNumber(impact) || !isValidNumber(ethics)) {
      throw new Error(
        `Match simulation returned invalid scores (NaN or Infinity): ` +
        `novelty=${novelty}, feasibility=${feasibility}, impact=${impact}, ethics=${ethics}`
      );
    }

    // Clamp scores to valid range if out of bounds
    if (novelty < 0 || novelty > 10 || feasibility < 0 || feasibility > 10 ||
      impact < 0 || impact > 10 || ethics < 0 || ethics > 10) {
      logger.warn(`Scores out of bounds: novelty=${novelty}, feasibility=${feasibility}, impact=${impact}, ethics=${ethics}`);
      parsed.scores.novelty = Math.max(0, Math.min(10, novelty));
      parsed.scores.feasibility = Math.max(0, Math.min(10, feasibility));
      parsed.scores.impact = Math.max(0, Math.min(10, impact));
      parsed.scores.ethics = Math.max(0, Math.min(10, ethics));
      // Recalculate total
      parsed.scores.total = parsed.scores.novelty + parsed.scores.feasibility +
        parsed.scores.impact + parsed.scores.ethics;
    }

    return parsed;
  }, { maxRetries: 2, initialDelay: 1000 }); // Retry up to 2 times with 1s delay
};

/**
 * Tournament context for brief generation
 */
export interface TournamentContext {
  initialHypothesis: string;
  defeatedAgents: string[];
  finalScore: number;
  evolutionPath: string;
  keyDebates?: Array<{
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
  }>;
}

/**
 * PHASE 3: Generate publication-ready research brief from tournament winner
 * 
 * Creates a comprehensive research brief that includes:
 * - Title and abstract
 * - Predicted impact and significance
 * - Cost and timeline estimates
 * - One-sentence tweet summary
 * 
 * The brief incorporates the full tournament journey, including defeated perspectives
 * and how the hypothesis evolved through each debate round.
 * 
 * Includes retry logic for robustness.
 * 
 * @param winner - The winning agent with their profile and expertise
 * @param evolvedHypothesis - The final evolved hypothesis after all debates
 * @param tournamentContext - Optional context about tournament journey (evolution path, defeated agents, key debates)
 * @param file - Optional file context to reference in the brief
 * @returns WinningBrief object with all required fields populated
 * @throws Error if brief generation fails or required fields are missing
 */
export const generateBrief = async (
  winner: Agent,
  evolvedHypothesis: string,
  tournamentContext?: TournamentContext,
  file?: { mimeType: string; data: string }
): Promise<WinningBrief> => {
  // Input validation
  if (!winner || !winner.name || !winner.role) {
    throw new Error("Valid winner agent is required for brief generation");
  }

  if (!evolvedHypothesis || typeof evolvedHypothesis !== 'string' || evolvedHypothesis.trim().length === 0) {
    throw new Error("Evolved hypothesis is required for brief generation");
  }

  return retryWithBackoff(async () => {
    const ai = getAiClient();

    // Sanitize inputs (reuse sanitize function logic)
    const sanitize = (text: string): string => {
      const templateVars = ['WINNER_NAME', 'WINNER_ROLE', 'HYPOTHESIS'];
      let sanitized = text;
      templateVars.forEach(varName => {
        const pattern = new RegExp(`\\{\\{\\s*${varName}\\s*\\}\\}`, 'g');
        sanitized = sanitized.replace(pattern, `{ { ${varName} } }`);
      });
      return sanitized.trim();
    };

    // Format key debates for context
    const keyDebatesText = tournamentContext?.keyDebates && Array.isArray(tournamentContext.keyDebates)
      ? tournamentContext.keyDebates.map(debate =>
        `${debate.round} vs ${debate.opponent}:
- Evolved Hypothesis: "${debate.evolvedHypothesis.substring(0, 200)}${debate.evolvedHypothesis.length > 200 ? '...' : ''}"
- Fatal Flaw Identified in Opponent: ${debate.fatalFlaw}
- Scores: Novelty=${debate.scores?.novelty || 0}, Feasibility=${debate.scores?.feasibility || 0}, Impact=${debate.scores?.impact || 0}, Ethics=${debate.scores?.ethics || 0}`
      ).join('\n\n')
      : 'Evolution details not available';

    const prompt = BRIEF_GENERATION_PROMPT
      .replace('{{WINNER_NAME}}', sanitize(winner.name))
      .replace('{{WINNER_ROLE}}', sanitize(winner.role))
      .replace('{{INITIAL_HYPOTHESIS}}', sanitize(tournamentContext?.initialHypothesis || winner.initialHypothesis))
      .replace('{{HYPOTHESIS}}', sanitize(evolvedHypothesis))
      .replace('{{EVOLUTION_PATH}}', sanitize(tournamentContext?.evolutionPath || 'Quarterfinal → Semifinal → Final'))
      .replace('{{DEFEATED_AGENTS}}', sanitize(tournamentContext?.defeatedAgents.join(', ') || 'Multiple competing perspectives'))
      .replace('{{FINAL_SCORE}}', String(tournamentContext?.finalScore || 0))
      .replace('{{KEY_DEBATES}}', sanitize(keyDebatesText));

    // Build input parts with file context if available
    const inputParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];

    // Validate file before sending
    if (file && file.data && file.data.length > 0) {
      // Validate MIME type
      const validMimeTypes = ['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
      if (!validMimeTypes.includes(file.mimeType)) {
        logger.warn(`Invalid MIME type for file in brief: ${file.mimeType}. Skipping file attachment.`);
      } else {
        inputParts.push({
          text: "\n\nIMPORTANT: The attached file was the original source material for this tournament. " +
            "The research brief MUST reference specific data, findings, or claims from this document. " +
            "Cite page numbers, figures, tables, or sections where relevant."
        });
        inputParts.push({
          inlineData: {
            mimeType: file.mimeType,
            data: file.data
          }
        });
      }
    }

    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: { parts: inputParts },
      config: {
        responseMimeType: "application/json",
        responseSchema: WINNING_BRIEF_SCHEMA,
        temperature: 0.8,
        safetySettings: SAFETY_SETTINGS,
      }
    });

    const parsed = safeJsonParse(extractCleanJson(result.text || "{}"), "generateBrief");

    // Validate required fields
    const requiredFields = ['title', 'abstract', 'predictedImpact', 'costAndTimeline', 'oneSentenceTweet'];
    for (const field of requiredFields) {
      if (!parsed[field] || typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
        throw new Error(`Brief generation incomplete: Missing or empty field '${field}'`);
      }
    }

    return parsed;
  }, { maxRetries: 2 });
};