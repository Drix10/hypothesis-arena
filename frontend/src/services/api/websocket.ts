type MessageHandler = (data: any) => void;
type ConnectionHandler = () => void;

interface WebSocketMessage {
    type: string;
    channel?: string;
    data?: any;
}

// Simple logger that respects production mode
const isDev = import.meta.env.DEV;
const wsLog = {
    info: (msg: string) => isDev && console.log(`[WS] ${msg}`),
    warn: (msg: string) => console.warn(`[WS] ${msg}`),
    error: (msg: string, err?: unknown) => console.error(`[WS] ${msg}`, err || ''),
};

class WebSocketClient {
    private ws: WebSocket | null = null;
    private url: string;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000;
    private messageHandlers: Map<string, Set<MessageHandler>> = new Map();
    private onConnectHandlers: Set<ConnectionHandler> = new Set();
    private onDisconnectHandlers: Set<ConnectionHandler> = new Set();
    private pingInterval: number | null = null;
    private pongTimeout: number | null = null;
    private reconnectTimeout: number | null = null;
    private subscriptions: Set<string> = new Set();
    private isDestroyed = false;
    private lastPongTime: number = 0;

    constructor() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = import.meta.env.VITE_WS_URL || '/ws';

        if (wsUrl.startsWith('ws')) {
            this.url = wsUrl;
        } else {
            this.url = `${wsProtocol}//${window.location.host}${wsUrl}`;
        }
    }

    connect(): void {
        if (this.ws?.readyState === WebSocket.OPEN) return;

        try {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                wsLog.info('Connected');
                this.reconnectAttempts = 0;
                this.startPing();
                this.resubscribe();
                this.onConnectHandlers.forEach(handler => handler());
            };

            this.ws.onmessage = (event) => {
                try {
                    const message: WebSocketMessage = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    wsLog.error('Failed to parse message', error);
                }
            };

            this.ws.onclose = () => {
                wsLog.info('Disconnected');
                this.stopPing();
                this.onDisconnectHandlers.forEach(handler => handler());
                this.attemptReconnect();
            };

            this.ws.onerror = (error) => {
                wsLog.error('Connection error', error);
            };

        } catch (error) {
            wsLog.error('Failed to create connection', error);
            this.attemptReconnect();
        }
    }

    disconnect(): void {
        this.isDestroyed = true;
        this.stopPing();
        this.clearReconnectTimeout();
        this.subscriptions.clear();
        this.messageHandlers.clear();
        this.onConnectHandlers.clear();
        this.onDisconnectHandlers.clear();

        if (this.ws) {
            this.ws.onclose = null; // Prevent reconnect attempt
            this.ws.close();
            this.ws = null;
        }
    }

    private clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    subscribe(channel: string, handler: MessageHandler): () => void {
        // Add to handlers
        if (!this.messageHandlers.has(channel)) {
            this.messageHandlers.set(channel, new Set());
        }
        this.messageHandlers.get(channel)!.add(handler);

        // Send subscription message
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.add(channel);
            this.send({ type: 'subscribe', channel });
        }

        // Return unsubscribe function
        return () => {
            const handlers = this.messageHandlers.get(channel);
            if (handlers) {
                handlers.delete(handler);
                if (handlers.size === 0) {
                    this.messageHandlers.delete(channel);
                    this.subscriptions.delete(channel);
                    this.send({ type: 'unsubscribe', channel });
                }
            }
        };
    }

    onConnect(handler: ConnectionHandler): () => void {
        this.onConnectHandlers.add(handler);
        return () => this.onConnectHandlers.delete(handler);
    }

    onDisconnect(handler: ConnectionHandler): () => void {
        this.onDisconnectHandlers.add(handler);
        return () => this.onDisconnectHandlers.delete(handler);
    }

    send(message: WebSocketMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    getLastPongTime(): number {
        return this.lastPongTime;
    }

    private handleMessage(message: WebSocketMessage): void {
        const { type, channel, data } = message;

        // Handle pong - update last pong time
        if (type === 'pong') {
            this.lastPongTime = Date.now();
            this.clearPongTimeout();
            return;
        }

        // Route to channel handlers
        const targetChannel = channel || type;
        const handlers = this.messageHandlers.get(targetChannel);

        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    wsLog.error(`Handler error for ${targetChannel}`, error);
                }
            });
        }

        // Also notify 'all' handlers
        const allHandlers = this.messageHandlers.get('*');
        if (allHandlers) {
            allHandlers.forEach(handler => {
                try {
                    handler({ type, channel, data });
                } catch (error) {
                    wsLog.error('Global handler error', error);
                }
            });
        }
    }

    private attemptReconnect(): void {
        if (this.isDestroyed) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            wsLog.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        wsLog.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.clearReconnectTimeout();
        this.reconnectTimeout = window.setTimeout(() => {
            if (!this.isDestroyed) {
                this.connect();
            }
        }, delay);
    }

    private resubscribe(): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.subscriptions.forEach(channel => {
            this.send({ type: 'subscribe', channel });
        });
    }

    private startPing(): void {
        this.lastPongTime = Date.now();
        this.pingInterval = window.setInterval(() => {
            this.send({ type: 'ping' });

            // Set timeout for pong response (10 seconds)
            this.clearPongTimeout();
            this.pongTimeout = window.setTimeout(() => {
                // No pong received - connection may be dead
                wsLog.warn('Pong timeout - reconnecting');
                if (this.ws) {
                    this.ws.close();
                }
            }, 10000);
        }, 30000);
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        this.clearPongTimeout();
    }

    private clearPongTimeout(): void {
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }
}

export const wsClient = new WebSocketClient();

// Auto-connect when module loads (in browser only)
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // Delay connection to allow app to initialize
    // Use requestIdleCallback if available for better performance
    const scheduleConnect = () => {
        if ('requestIdleCallback' in window) {
            (window as any).requestIdleCallback(() => wsClient.connect(), { timeout: 1000 });
        } else {
            setTimeout(() => wsClient.connect(), 100);
        }
    };

    // Only connect after DOM is ready
    if (document.readyState === 'complete') {
        scheduleConnect();
    } else {
        window.addEventListener('load', scheduleConnect, { once: true });
    }
}
