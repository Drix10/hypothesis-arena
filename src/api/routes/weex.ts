import { Router, Request, Response, NextFunction } from 'express';
import { getWeexClient } from '../../services/weex/WeexClient';
import { logger } from '../../utils/logger';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { config } from '../../config';

const router = Router();

// Valid intervals for candlestick data
const VALID_INTERVALS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'];

// Helper to validate symbol format
const isValidSymbol = (symbol: string): boolean => {
    return /^[a-z0-9_]+$/i.test(symbol) && symbol.length <= 50;
};

// Helper to check if symbol is in approved list (type-safe)
const isApprovedSymbolCheck = (symbol: string): boolean => {
    return (APPROVED_SYMBOLS as readonly string[]).includes(symbol);
};

// GET /api/weex/status - Test WEEX connection (public)
router.get('/status', async (_req: Request, res: Response, _next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const serverTime = await weex.getServerTime();

        res.json({
            connected: true,
            serverTime: serverTime.timestamp,
            localTime: Date.now(),
            offset: serverTime.timestamp - Date.now(),
        });
    } catch (error: any) {
        logger.error('WEEX status check failed:', { message: error.message });
        res.status(503).json({
            connected: false,
            error: error.message || 'Connection failed',
        });
    }
});

// GET /api/weex/tickers - Get all tickers (public)
router.get('/tickers', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const tickers = await weex.getAllTickers();

        // Filter to approved symbols only - use proper type checking
        const filtered = tickers.filter(t => isApprovedSymbolCheck(t.symbol));

        res.json({ tickers: filtered });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/ticker/:symbol - Get single ticker (public)
router.get('/ticker/:symbol', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbolCheck(symbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        const weex = getWeexClient();
        const ticker = await weex.getTicker(symbol);

        res.json({ ticker });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/depth/:symbol - Get orderbook (public)
router.get('/depth/:symbol', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbolCheck(symbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        const limitStr = req.query.limit as string;
        const limit = limitStr ? parseInt(limitStr, 10) : 15;

        if (isNaN(limit) || limit < 1 || limit > 100) {
            res.status(400).json({ error: 'Invalid limit (1-100)' });
            return;
        }

        const weex = getWeexClient();
        const depth = await weex.getDepth(symbol, limit);

        res.json({ depth });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/candles/:symbol - Get candlestick data (public)
router.get('/candles/:symbol', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbolCheck(symbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        const interval = (req.query.interval as string) || '1m';
        if (!VALID_INTERVALS.includes(interval)) {
            res.status(400).json({ error: `Invalid interval. Valid: ${VALID_INTERVALS.join(', ')}` });
            return;
        }

        const limitStr = req.query.limit as string;
        const limit = limitStr ? parseInt(limitStr, 10) : 100;

        if (isNaN(limit) || limit < 1 || limit > 1000) {
            res.status(400).json({ error: 'Invalid limit (1-1000)' });
            return;
        }

        const weex = getWeexClient();
        const candles = await weex.getCandles(symbol, interval, limit);

        res.json({ candles });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/contracts - Get all contracts info (public)
router.get('/contracts', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const contracts = await weex.getContracts();

        // Filter to approved symbols - use proper type checking
        const filtered = contracts.filter(c => isApprovedSymbolCheck(c.symbol));

        res.json({ contracts: filtered });
    } catch (error) {
        next(error);
    }
});

// ============ PRIVATE ENDPOINTS ============

// GET /api/weex/account - Get account info
router.get('/account', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const accounts = await weex.getAccount();

        res.json({ success: true, data: accounts });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/assets - Get account assets
router.get('/assets', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const assets = await weex.getAccountAssets();

        // Calculate total wallet P&L based on starting balance from config
        const startingBalance = config.trading.startingBalance;
        const currentEquity = parseFloat(assets.equity || '0');

        // Validate and calculate P&L with NaN protection
        const rawTotalWalletPnl = currentEquity - startingBalance;
        const totalWalletPnl = Number.isFinite(rawTotalWalletPnl) ? rawTotalWalletPnl : 0;

        const rawTotalWalletPnlPercent = startingBalance > 0
            ? ((currentEquity - startingBalance) / startingBalance) * 100
            : 0;
        const totalWalletPnlPercent = Number.isFinite(rawTotalWalletPnlPercent) ? rawTotalWalletPnlPercent : 0;

        // Get positions to calculate unrealized P&L
        const positions = await weex.getPositions();
        const unrealizedPL = positions.reduce((sum, pos) => {
            const pnl = parseFloat(String(pos.unrealizePnl)) || 0;
            return sum + (Number.isFinite(pnl) ? pnl : 0);
        }, 0);

        // Consolidated response - assets with additional calculated fields
        res.json({
            success: true,
            data: {
                ...assets,
                unrealizedPL,
                totalWalletPnl,
                totalWalletPnlPercent,
                startingBalance
            }
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/positions - Get all positions with current market prices
router.get('/positions', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const positions = await weex.getPositions();

        // Fetch current prices for all position symbols
        const activePositions = positions.filter(p => parseFloat(String(p.size)) > 0);

        if (activePositions.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }

        // Batch fetch tickers and plan orders for all symbols to avoid N+1
        const symbols = [...new Set(activePositions.map(p => p.symbol))];

        const [tickerResults, planOrderResults] = await Promise.all([
            // Fetch all tickers in parallel
            Promise.all(symbols.map(async (symbol) => {
                try {
                    const ticker = await weex.getTicker(symbol);
                    return { symbol, price: parseFloat(ticker?.last || '0') };
                } catch {
                    return { symbol, price: 0 };
                }
            })),
            // Fetch all plan orders in parallel
            Promise.all(symbols.map(async (symbol) => {
                try {
                    const orders = await weex.getCurrentPlanOrders(symbol);
                    return { symbol, orders };
                } catch {
                    return { symbol, orders: [] };
                }
            }))
        ]);

        // Build lookup maps
        const tickerMap = new Map(tickerResults.map(t => [t.symbol, t.price]));
        const planOrderMap = new Map(planOrderResults.map(p => [p.symbol, p.orders]));

        // Enhance positions with current market price and SL distance
        const enhancedPositions = activePositions.map((pos) => {
            const markPrice = tickerMap.get(pos.symbol) || 0;
            const planOrders = planOrderMap.get(pos.symbol) || [];

            // Get TP/SL orders for this position
            // WEEX plan orders don't return planType or positionSide in response
            // We infer SL vs TP based on trigger price relative to mark price:
            // - LONG: SL trigger < mark price, TP trigger > mark price
            // - SHORT: SL trigger > mark price, TP trigger < mark price
            let stopLoss: number | null = null;
            let takeProfit: number | null = null;

            const isLongPos = pos.side === 'LONG';
            for (const order of planOrders) {
                const triggerPrice = parseFloat(order.triggerPrice || order.trigger_price || '0');
                if (triggerPrice <= 0) continue;

                // Determine if this is SL or TP based on trigger price vs mark price
                if (isLongPos) {
                    // LONG: SL below mark, TP above mark
                    if (triggerPrice < markPrice) {
                        stopLoss = triggerPrice;
                    } else if (triggerPrice > markPrice) {
                        takeProfit = triggerPrice;
                    }
                } else {
                    // SHORT: SL above mark, TP below mark
                    if (triggerPrice > markPrice) {
                        stopLoss = triggerPrice;
                    } else if (triggerPrice < markPrice) {
                        takeProfit = triggerPrice;
                    }
                }
            }

            // Calculate distance to SL/TP
            const isLong = isLongPos;
            const size = parseFloat(String(pos.size)) || 0;

            let slDistance: number | null = null;
            let tpDistance: number | null = null;

            if (stopLoss && markPrice > 0 && size > 0) {
                // Distance as $ amount to SL
                const rawSlDist = isLong
                    ? (markPrice - stopLoss) * size  // LONG: lose money if price drops to SL
                    : (stopLoss - markPrice) * size; // SHORT: lose money if price rises to SL
                slDistance = Number.isFinite(rawSlDist) ? rawSlDist : null;
            }

            if (takeProfit && markPrice > 0 && size > 0) {
                const rawTpDist = isLong
                    ? (takeProfit - markPrice) * size  // LONG: gain money if price rises to TP
                    : (markPrice - takeProfit) * size; // SHORT: gain money if price drops to TP
                tpDistance = Number.isFinite(rawTpDist) ? rawTpDist : null;
            }

            return {
                ...pos,
                markPrice: Number.isFinite(markPrice) ? markPrice : 0,
                stopLoss,
                takeProfit,
                slDistance,
                tpDistance
            };
        });

        res.json({ success: true, data: enhancedPositions });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/position/:symbol - Get single position
router.get('/position/:symbol', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        const weex = getWeexClient();
        const position = await weex.getPosition(symbol);

        res.json({ position });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/orders - Get current open orders
router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const symbol = req.query.symbol as string | undefined;

        if (symbol && !isValidSymbol(symbol.toLowerCase())) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        const weex = getWeexClient();
        const orders = await weex.getCurrentOrders(symbol?.toLowerCase());

        res.json({ orders });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/orders/history/:symbol - Get order history
router.get('/orders/history/:symbol', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        const limitStr = req.query.limit as string;
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        if (isNaN(limit) || limit < 1 || limit > 500) {
            res.status(400).json({ error: 'Invalid limit (1-500)' });
            return;
        }

        const weex = getWeexClient();
        const orders = await weex.getHistoryOrders(symbol, limit);

        res.json({ orders });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/fills/:symbol - Get trade fills
router.get('/fills/:symbol', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const symbol = req.params.symbol.toLowerCase();

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        const limitStr = req.query.limit as string;
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        if (isNaN(limit) || limit < 1 || limit > 500) {
            res.status(400).json({ error: 'Invalid limit (1-500)' });
            return;
        }

        const weex = getWeexClient();
        const fills = await weex.getFills(symbol, limit);

        res.json({ fills });
    } catch (error) {
        next(error);
    }
});

// POST /api/weex/leverage - Change leverage
router.post('/leverage', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { symbol, leverage, marginMode } = req.body;

        if (!symbol || leverage === undefined || leverage === null) {
            res.status(400).json({ error: 'symbol and leverage required' });
            return;
        }

        if (!isValidSymbol(symbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        const leverageNum = Number(leverage);
        if (isNaN(leverageNum) || leverageNum < 1 || leverageNum > 125) {
            res.status(400).json({ error: 'Invalid leverage (1-125)' });
            return;
        }

        if (marginMode && marginMode !== '1' && marginMode !== '3') {
            res.status(400).json({ error: 'Invalid marginMode (1=cross, 3=isolated)' });
            return;
        }

        const weex = getWeexClient();
        const result = await weex.changeLeverage(symbol.toLowerCase(), leverageNum, marginMode || '1');

        res.json({ success: true, result });
    } catch (error) {
        next(error);
    }
});

// POST /api/weex/test-auth - Test WEEX authentication
router.post('/test-auth', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();

        // Test sequence: server time -> account -> positions
        const results: any = {
            tests: [],
            success: true,
        };

        // Test 1: Server time (public)
        try {
            const serverTime = await weex.getServerTime();
            results.tests.push({
                name: 'Server Time',
                success: true,
                data: { timestamp: serverTime.timestamp },
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Server Time',
                success: false,
                error: error.message,
            });
            results.success = false;
        }

        // Test 2: Account (private - tests auth)
        try {
            const accounts = await weex.getAccount();
            results.tests.push({
                name: 'Account Auth',
                success: true,
                data: { accountCount: accounts.length },
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Account Auth',
                success: false,
                error: error.message,
            });
            results.success = false;
        }

        // Test 3: Positions (private)
        try {
            const positions = await weex.getPositions();
            results.tests.push({
                name: 'Positions',
                success: true,
                data: { positionCount: positions.length },
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Positions',
                success: false,
                error: error.message,
            });
            results.success = false;
        }

        // Test 4: Assets (private)
        try {
            const assets = await weex.getAccountAssets();
            results.tests.push({
                name: 'Assets',
                success: true,
                data: { equity: assets.equity, available: assets.available },
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Assets',
                success: false,
                error: error.message,
            });
            results.success = false;
        }

        res.json(results);
    } catch (error) {
        next(error);
    }
});

export default router;
