import { WebSocketServer, WebSocket } from 'ws';
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

    constructor(private wss: WebSocketServer) {
        this.setupServer();
        this.startHeartbeat();
    }

    private setupServer() {
        this.wss.on('connection', (ws: WebSocket) => {
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

        switch (message.type) {
            case 'auth':
                client.userId = message.userId;
                client.ws.send(JSON.stringify({ type: 'auth_success' }));
                break;

            case 'subscribe':
                if (message.channel) {
                    client.subscriptions.add(message.channel);
                    client.ws.send(JSON.stringify({
                        type: 'subscribed',
                        channel: message.channel
                    }));
                }
                break;

            case 'unsubscribe':
                if (message.channel) {
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
                logger.warn(`Unknown message type: ${message.type}`);
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

    sendToUser(userId: string, data: any) {
        const message = JSON.stringify({
            type: 'message',
            data,
            timestamp: Date.now()
        });

        this.clients.forEach((client) => {
            if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        });
    }

    closeAll() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        this.clients.forEach((client, clientId) => {
            client.ws.close(1000, 'Server shutting down');
            this.clients.delete(clientId);
        });

        logger.info('All WebSocket connections closed');
    }

    getClientCount(): number {
        return this.clients.size;
    }

    getAuthenticatedCount(): number {
        let count = 0;
        this.clients.forEach((client) => {
            if (client.userId) count++;
        });
        return count;
    }

    private generateClientId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}
