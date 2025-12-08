/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';

// Augment React's JSX namespace to include iconify-icon.
// This is the single source of truth for this type definition.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'iconify-icon': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        icon?: string;
        width?: string | number;
        height?: string | number;
        class?: string;
        className?: string;
      };
    }
  }
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  avatarEmoji: string;
  expertise: string;
  voiceStyle: string;
  initialHypothesis: string;
  currentHypothesis?: string; // Tracks evolved hypothesis as agent advances
}

export interface Scores {
  novelty: number;
  feasibility: number;
  impact: number;
  ethics: number;
  total: number;
}

export type MatchStatus = 'pending' | 'running' | 'completed';

export interface MatchResult {
  matchId: string;
  round: "Quarterfinal" | "Semifinal" | "Final";
  agent1Id: string | null;
  agent2Id: string | null;
  status: MatchStatus;
  winnerId?: string;
  evolvedHypothesis?: string;
  debateDialogue?: string;
  fatalFlaw?: string;
  scores?: Scores;
}

export interface WinningBrief {
  title: string;
  abstract: string;
  predictedImpact: string;
  costAndTimeline: string;
  oneSentenceTweet: string;
}

export interface TournamentData {
  tournamentId: string;
  agents: Agent[];
  matches: MatchResult[];
  winningBrief?: WinningBrief; // Optional until end
  // Store original context for reference (file data NOT stored to save memory)
  originalContext?: {
    userInput: string;
    // File data intentionally not stored in state to prevent memory bloat
    // File is passed through function closures instead
    file?: undefined;
  };
}

export enum AppState {
  IDLE = 'IDLE',
  GENERATING_AGENTS = 'GENERATING_AGENTS',
  RUNNING_TOURNAMENT = 'RUNNING_TOURNAMENT',
  GENERATING_BRIEF = 'GENERATING_BRIEF',
  VIEWING_TOURNAMENT = 'VIEWING_TOURNAMENT',
  COMPLETE = 'COMPLETE'
}