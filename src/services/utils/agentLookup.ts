/**
 * Agent Lookup Utility
 * 
 * Centralized utility for finding agents by ID or name with fuzzy matching.
 * Extracted from App.tsx for better code organization.
 */

import { Agent } from '../../types';
import { logger } from './logger';

/**
 * Find an agent by ID with fallback to name matching
 * 
 * @param identifier - Agent ID or name
 * @param agents - Array of agents to search
 * @returns Agent if found, undefined otherwise
 */
export function findAgent(identifier: string, agents: Agent[]): Agent | undefined {
    // Try exact ID match first
    let agent = agents.find(a => a.id === identifier);

    if (agent) {
        return agent;
    }

    // Try name matching (case-insensitive, partial match)
    agent = agents.find(a =>
        a.name.toLowerCase() === identifier.toLowerCase() ||
        a.name.includes(identifier) ||
        identifier.includes(a.name)
    );

    if (agent) {
        logger.warn(`Agent lookup: Mapped "${identifier}" to agent "${agent.id}" by name`);
    }

    return agent;
}

/**
 * Validate and fix winnerId from AI response
 * 
 * @param winnerId - Winner ID from AI (might be name instead of ID)
 * @param agent1 - First agent in match
 * @param agent2 - Second agent in match
 * @param allAgents - All tournament agents
 * @returns Valid agent ID
 * @throws Error if winner cannot be determined
 */
export function validateWinnerId(
    winnerId: string | undefined,
    agent1: Agent,
    agent2: Agent,
    allAgents: Agent[]
): string {
    if (!winnerId) {
        throw new Error('No winner ID provided');
    }

    // Check if winnerId is valid
    const winnerExists = allAgents.some(a => a.id === winnerId);

    if (winnerExists) {
        return winnerId;
    }

    // Try to find by name in all agents
    const winnerByName = findAgent(winnerId, allAgents);

    if (winnerByName) {
        logger.warn(`AI returned agent name instead of ID. Mapping "${winnerId}" to "${winnerByName.id}"`);
        return winnerByName.id;
    }

    // Last resort: check if it matches one of the two agents in this match
    if (winnerId === agent1.name || winnerId.includes(agent1.name)) {
        logger.warn(`Mapped winner name to agent1: ${agent1.id}`);
        return agent1.id;
    }

    if (winnerId === agent2.name || winnerId.includes(agent2.name)) {
        logger.warn(`Mapped winner name to agent2: ${agent2.id}`);
        return agent2.id;
    }

    throw new Error(`Invalid winnerId: "${winnerId}". Could not map to any agent.`);
}
