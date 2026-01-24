import WebSocket from 'ws';
import { logger } from '../../utils/logger';
import { WeexWsMessage, WeexWsTickerPayload } from '../../shared/types/weex';

export class WeexWebsocketService {
    private static instance: WeexWebsocketService;
    private ws: WebSocket | null = null;
    private readonly publicUrl = 'wss://ws-contract.weex.com/v2/ws/public';
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 5;
    private pingInterval: NodeJS.Timeout | null = null;
    private callbacks = new Set<(data: WeexWsTickerPayload) => void>();
    private shouldReconnect = true;

    private readonly symbols = [
        'cmt_btcusdt',
        'cmt_ethusdt',
        'cmt_solusdt',
        'cmt_xrpusdt',
        'cmt_dogeusdt',
        'cmt_adausdt',
        'cmt_bnbusdt',
        'cmt_ltcusdt',
    ];

    private isConnecting = false;

    private constructor() { }

    public static getInstance(): WeexWebsocketService {
        if (!WeexWebsocketService.instance) {
            WeexWebsocketService.instance = new WeexWebsocketService();
        }
        return WeexWebsocketService.instance;
    }

    public connect(): void {
        if (this.ws?.readyState === WebSocket.OPEN) return;
        if (this.isConnecting) {
            logger.warn('WEEX WS connection already in progress...');
            return;
        }

        this.shouldReconnect = true;
        this.isConnecting = true;

        logger.info('Connecting to WEEX Public WebSocket...');

        try {
            this.ws = new WebSocket(this.publicUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://www.weex.com'
                },
                handshakeTimeout: 10000
            });

            this.ws.on('open', () => {
                logger.info('WEEX Public WebSocket connected');
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.subscribeToTickers();
                this.startHeartbeat();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString()) as WeexWsMessage;

                    // Handle Pong
                    if (message.event === 'pong') {
                        return;
                    }

                    // Handle Ticker Data
                    if (message.event === 'payload' && (message.channel?.startsWith('ticker:') || message.channel?.startsWith('ticker.'))) {
                        const payload = message as WeexWsTickerPayload;
                        this.notifyCallbacks(payload);
                    }
                } catch (error) {
                    logger.error('Error parsing WEEX WS message:', error);
                }
            });

            this.ws.on('error', (error) => {
                this.isConnecting = false;
                logger.error('WEEX WS error:', error);
            });

            this.ws.on('close', (code, reason) => {
                this.isConnecting = false;
                logger.warn(`WEEX WS connection closed (Code: ${code}, Reason: ${reason || 'None'})`);
                this.stopHeartbeat();
                if (this.shouldReconnect) {
                    this.handleReconnect();
                }
            });
        } catch (error) {
            this.isConnecting = false;
            logger.error('Failed to initiate WEEX WS connection:', error);
            if (this.shouldReconnect) {
                this.handleReconnect();
            }
        }
    }

    private subscribeToTickers(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.symbols.forEach(symbol => {
            const subscribeMsg = {
                event: 'subscribe',
                channel: `ticker.${symbol}`,
            };
            this.ws?.send(JSON.stringify(subscribeMsg));
            logger.debug(`Subscribed to WEEX ticker: ${symbol}`);
        });
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ event: 'ping' }));
            }
        }, 20000); // 20s heartbeat
    }

    private stopHeartbeat(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    public isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    private handleReconnect(): void {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.pow(2, this.reconnectAttempts) * 1000;
            logger.info(`Reconnecting to WEEX WS in ${delay}ms (Attempt ${this.reconnectAttempts})...`);
            setTimeout(() => {
                if (this.shouldReconnect) {
                    this.connect();
                }
            }, delay);
        } else {
            logger.error('Max WEEX WS reconnect attempts reached');
        }
    }

    public onTickerUpdate(callback: (data: WeexWsTickerPayload) => void): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    private notifyCallbacks(data: WeexWsTickerPayload): void {
        this.callbacks.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                logger.error('Error in WEEX WS ticker callback:', error);
            }
        });
    }

    public disconnect(): void {
        this.shouldReconnect = false;
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
    }
}

export const weexWebsocketService = WeexWebsocketService.getInstance();
