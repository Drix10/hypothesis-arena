/**
 * Autonomous Trading Engine API Service
 * 
 * Connects to the 24/7 AI trading tournament system
 */

import { apiClient } from './client';

export interface AnalystState {
    id: string;
    name: string;
    emoji: string;
    methodology: string;
    balance: number;
    totalValue: number;
    return: number;
    returnPercent: number;
    rank: number;
    status: 'analyzing' | 'trading' | 'cooldown' | 'paused';
    currentPosition?: any;
    lastTrade?: any;
    tradesCount: number;
    winRate: number;
}

export interface EngineStatus {
    isRunning: boolean;
    cycleCount: number;
    currentCycle: {
        cycleNumber: number;
        startTime: number;
        endTime?: number;
        symbolsAnalyzed: string[];
        tradesExecuted: number;
        debatesRun: number;
        errors: string[];
    } | null;
    nextCycleIn: number; // milliseconds
    totalCycles: number;
    analysts: AnalystState[];
    stats: {
        totalTrades: number;
        tradesThisCycle: number;
        avgCycleTime: number;
    };
}

export interface LiveEvent {
    type: 'cycleStart' | 'cycleComplete' | 'tradeExecuted' | 'debatesComplete' | 'status';
    timestamp?: number;
    data?: any;
    cycleNumber?: number;
}

export const autonomousApi = {
    /**
     * Get current engine status
     */
    async getStatus(): Promise<EngineStatus> {
        const response = await apiClient.get<{ success: boolean; data: EngineStatus }>('/autonomous/status');
        if (!response.success) {
            throw new Error('Failed to get engine status');
        }
        return response.data;
    },

    /**
     * Get all analyst states
     */
    async getAnalysts(): Promise<AnalystState[]> {
        const response = await apiClient.get<{ success: boolean; data: AnalystState[] }>('/autonomous/analysts');
        if (!response.success) {
            throw new Error('Failed to get analysts');
        }
        return response.data;
    },

    /**
     * Start the autonomous trading engine
     */
    async start(): Promise<void> {
        const response = await apiClient.post<{ success: boolean; error?: string }>('/autonomous/start', {});
        // Defensive check: fail if response is missing or success is not explicitly true
        if (!response?.success) {
            throw new Error(response?.error || 'Failed to start engine');
        }
    },

    /**
     * Stop the autonomous trading engine
     */
    async stop(): Promise<void> {
        const response = await apiClient.post<{ success: boolean; error?: string }>('/autonomous/stop', {});
        // Defensive check: fail if response is missing or success is not explicitly true
        if (!response?.success) {
            throw new Error(response?.error || 'Failed to stop engine');
        }
    },

    /**
     * Connect to real-time events via Server-Sent Events (SSE)
     * 
     * SECURITY NOTE: EventSource doesn't support custom headers, so we use
     * a short-lived SSE token obtained via authenticated API call instead of
     * passing the main auth token in the URL. This prevents token exposure
     * in logs, browser history, and referrer headers.
     * 
     * Alternative approaches considered:
     * - fetch() + ReadableStream: Better security but less browser support
     * - WebSocket: Supports headers but more complex server implementation
     * - HttpOnly cookie: Requires CORS changes and server-side session handling
     * 
     * MEMORY LEAK FIX: Properly clean up event listeners on reconnection
     */
    connectToEvents(onEvent: (event: LiveEvent) => void, onError?: (error: Error) => void): () => void {
        const token = localStorage.getItem('auth_token');
        if (!token) {
            const error = new Error('Authentication required for live events');
            if (onError) {
                onError(error);
            }
            return () => { };
        }

        let eventSource: EventSource | null = null;
        let reconnectAttempts = 0;
        let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
        let isCleanedUp = false;
        const maxReconnectAttempts = 5;
        const reconnectDelay = 3000;

        let currentOnOpen: (() => void) | null = null;
        let currentOnMessage: ((event: MessageEvent) => void) | null = null;
        let currentOnError: ((event: Event) => void) | null = null;

        const cleanupEventSource = () => {
            if (eventSource) {
                if (currentOnOpen) eventSource.removeEventListener('open', currentOnOpen);
                if (currentOnMessage) eventSource.removeEventListener('message', currentOnMessage);
                if (currentOnError) eventSource.removeEventListener('error', currentOnError);
                eventSource.close();
                eventSource = null;
            }
            currentOnOpen = null;
            currentOnMessage = null;
            currentOnError = null;
        };

        const connect = async () => {
            if (isCleanedUp) return;

            cleanupEventSource();

            try {
                // Get a short-lived SSE token from the server
                // This token is single-use and expires quickly, minimizing exposure risk
                const baseUrl = import.meta.env.VITE_API_URL || '/api';

                // Add timeout to token fetch to prevent hanging
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

                let tokenResponse: Response;
                try {
                    tokenResponse = await fetch(`${baseUrl}/autonomous/sse-token`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (!tokenResponse.ok) {
                    throw new Error(`Failed to obtain SSE token: ${tokenResponse.status}`);
                }

                const tokenData = await tokenResponse.json();

                // Validate SSE token response
                if (!tokenData || typeof tokenData.sseToken !== 'string' || tokenData.sseToken.length === 0) {
                    throw new Error('Invalid SSE token response from server');
                }

                const { sseToken } = tokenData;

                if (isCleanedUp) return;

                // Use the short-lived token in the URL (expires in ~60 seconds)
                const url = `${baseUrl}/autonomous/events?sseToken=${encodeURIComponent(sseToken)}`;
                eventSource = new EventSource(url);

                currentOnOpen = () => {
                    console.log('SSE connection established');
                    reconnectAttempts = 0;
                };

                currentOnMessage = (event: MessageEvent) => {
                    try {
                        const data = JSON.parse(event.data);
                        onEvent({
                            ...data,
                            timestamp: Date.now(),
                        });
                    } catch (error) {
                        console.error('Failed to parse SSE event:', error);
                    }
                };

                currentOnError = () => {
                    console.error('SSE connection error');
                    cleanupEventSource();

                    if (isCleanedUp) return;

                    if (reconnectAttempts < maxReconnectAttempts) {
                        reconnectAttempts++;
                        const delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1);
                        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);

                        reconnectTimeout = setTimeout(() => {
                            connect();
                        }, delay);
                    } else {
                        if (onError) {
                            onError(new Error('Lost connection to live events after multiple retries'));
                        }
                    }
                };

                eventSource.addEventListener('open', currentOnOpen);
                eventSource.addEventListener('message', currentOnMessage);
                eventSource.addEventListener('error', currentOnError);

            } catch (error) {
                console.error('Failed to create EventSource:', error);

                if (isCleanedUp) return;

                // Retry on token fetch failure
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    const delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1);
                    reconnectTimeout = setTimeout(() => {
                        connect();
                    }, delay);
                } else if (onError) {
                    onError(error as Error);
                }
            }
        };

        connect();

        return () => {
            isCleanedUp = true;
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }
            cleanupEventSource();
        };
    },
};
