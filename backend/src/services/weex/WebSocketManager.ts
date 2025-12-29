import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';

interface Client {
    ws: WebSocket;
    userId: string;
    subscriptions: Set<string>;
    lastPing: number;
    isAlive: boolean;
}

export class WebSocketManager {
    private clients: Map<string, Client> = new Map();
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private readonly HEARTBEAT_INTERVAL = 30000;
    private readonly CLIENT_TIMEOUT = 60000;
    private readonly MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
    private readonly MAX_CLIENTS = 10000; // Prevent unbounded growth

    constructor(private wss: WebSocketServer) {
        this.setupServer();
        this.startHeartbeat();
    }

    private setupServer() {
        this.wss.on('connection', (ws: WebSocket) => {
            // Reject if at max capacity
            if (this.clients.size >= this.MAX_CLIENTS) {
                logger.warn('WebSocket connection rejected: max clients reached');
                ws.close(1013, 'Server at capacity');
                return;
            }

            const clientId = this.generateClientId();

            const client: Client = {
                ws,
                userId: '',
                subscriptions: new Set(),
                lastPing: Date.now(),
                isAlive: true,
            };

            this.clients.set(clientId, client);
            logger.info(`WebSocket client connected: ${clientId}`);

            ws.on('message', (data) => {
                try {
                    // Check message size
                    const messageSize = Buffer.isBuffer(data) ? data.length : data.toString().length;
                    if (messageSize > this.MAX_MESSAGE_SIZE) {
                        logger.warn(`Message too large from ${clientId}: ${messageSize} bytes`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
                        return;
                    }

                    const message = JSON.parse(data.toString());
                    this.handleMessage(clientId, message);
                } catch (error) {
                    logger.error('Invalid WebSocket message:', error);
                }
            });

            ws.on('pong', () => {
                const client = this.clients.get(clientId);
                if (client) {
                    client.isAlive = true;
                    client.lastPing = Date.now();
                }
            });

            ws.on('close', () => {
                this.clients.delete(clientId);
                logger.info(`WebSocket client disconnected: ${clientId}`);
            });

            ws.on('error', (error) => {
                logger.error(`WebSocket error for ${clientId}:`, error);
                this.clients.delete(clientId);
            });

            // Send welcome message
            ws.send(JSON.stringify({ type: 'connected', clientId }));
        });
    }

    private startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();

            this.clients.forEach((client, clientId) => {
                if (!client.isAlive || (now - client.lastPing) > this.CLIENT_TIMEOUT) {
                    logger.info(`Terminating inactive client: ${clientId}`);
                    client.ws.terminate();
                    this.clients.delete(clientId);
                    return;
                }

                client.isAlive = false;
                client.ws.ping();
            });
        }, this.HEARTBEAT_INTERVAL);
    }

    private handleMessage(clientId: string, message: any) {
        const client = this.clients.get(clientId);
        if (!client) return;

        // Validate message type
        if (typeof message.type !== 'string') {
            logger.warn(`Invalid message type from ${clientId}`);
            return;
        }

        switch (message.type) {
            case 'auth':
                // Validate userId is a non-empty string of reasonable length
                if (typeof message.userId === 'string' &&
                    message.userId.trim().length > 0 &&
                    message.userId.length <= 100) {
                    client.userId = message.userId;
                    client.ws.send(JSON.stringify({ type: 'auth_success' }));
                } else {
                    client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid userId' }));
                }
                break;

            case 'subscribe':
                // Validate channel and limit subscriptions
                if (typeof message.channel === 'string' &&
                    message.channel.length <= 100 &&
                    client.subscriptions.size < 50) {
                    client.subscriptions.add(message.channel);
                    client.ws.send(JSON.stringify({
                        type: 'subscribed',
                        channel: message.channel
                    }));
                }
                break;

            case 'unsubscribe':
                if (typeof message.channel === 'string') {
                    client.subscriptions.delete(message.channel);
                    client.ws.send(JSON.stringify({
                        type: 'unsubscribed',
                        channel: message.channel
                    }));
                }
                break;

            case 'ping':
                client.ws.send(JSON.stringify({ type: 'pong' }));
                break;

            default:
                // Don't log unknown types to prevent log spam attacks
                break;
        }
    }

    broadcast(channel: string, data: any) {
        const message = JSON.stringify({
            type: 'message',
            channel,
            data,
            timestamp: Date.now()
        });

        let sent = 0;
        this.clients.forEach((client) => {
            if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
                sent++;
            }
        });

        logger.debug(`Broadcast to ${sent} clients on channel: ${channel}`);
    }

    /**
     * Close all WebSocket connections gracefully
     * 
     * FIXED: Now async with timeout to ensure proper cleanup
     * FIXED: Removes event listeners on timeout to prevent race conditions
     */
    async closeAll(timeoutMs: number = 5000): Promise<void> {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        // Collect client IDs first to avoid modifying Map during iteration
        const clientIds = Array.from(this.clients.keys());

        if (clientIds.length === 0) {
            logger.info('No WebSocket connections to close');
            return;
        }

        // Track cleanup functions to call on timeout
        const cleanupFunctions: Array<() => void> = [];

        // Create close promises for all clients
        const closePromises = clientIds.map(clientId => {
            return new Promise<void>((resolve) => {
                const client = this.clients.get(clientId);
                if (!client) {
                    resolve();
                    return;
                }

                // Track if onClose has already been called (guard for once-like behavior)
                let hasResolved = false;

                // Set up close handler
                const onClose = () => {
                    if (hasResolved) return; // Guard against multiple calls
                    hasResolved = true;
                    client.subscriptions.clear();
                    this.clients.delete(clientId);
                    resolve();
                };

                // Handle already closed connections
                if (client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING) {
                    onClose();
                    return;
                }

                // Listen for close event (use 'on' so we can properly removeListener)
                client.ws.on('close', onClose);

                // Track cleanup function to remove listener on timeout
                cleanupFunctions.push(() => {
                    client.ws.removeListener('close', onClose);
                });

                // Initiate close with error handling
                try {
                    client.ws.close(1000, 'Server shutting down');
                } catch (error) {
                    logger.warn(`Error closing WebSocket for ${client.userId}:`, error);
                    // Resolve anyway since we're shutting down
                    resolve();
                }
            });
        });

        // Wait for all connections to close with timeout
        let timeoutId: NodeJS.Timeout | null = null;
        try {
            await Promise.race([
                Promise.all(closePromises),
                new Promise<void>((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
                })
            ]);
            logger.info(`All ${clientIds.length} WebSocket connections closed gracefully`);
        } catch (_error) {
            // Remove event listeners to prevent race conditions
            cleanupFunctions.forEach(cleanup => cleanup());

            // Force terminate remaining connections
            logger.warn('WebSocket close timeout, force terminating remaining connections');
            for (const clientId of clientIds) {
                const client = this.clients.get(clientId);
                if (client) {
                    client.ws.terminate();
                    client.subscriptions.clear();
                    this.clients.delete(clientId);
                }
            }
            logger.info('All WebSocket connections terminated');
        } finally {
            // Always clear the timeout to prevent memory leak
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

    getClientCount(): number {
        return this.clients.size;
    }

    private generateClientId(): string {
        return randomUUID();
    }
}
