import { Router, Request, Response, NextFunction } from 'express';
import { getWeexClient } from '../../services/weex/WeexClient';
import { logger } from '../../utils/logger';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { config } from '../../config';

const router = Router();

const VALID_INTERVALS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'];

const isValidSymbol = (symbol: string): boolean => {
    return /^[a-z0-9_]+$/i.test(symbol) && symbol.length <= 50;
};

const isApprovedSymbolCheck = (symbol: string): boolean => {
    return (APPROVED_SYMBOLS as readonly string[]).includes(symbol);
};

// GET /api/weex/status
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

// GET /api/weex/tickers
router.get('/tickers', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const tickers = await weex.getAllTickers();

        const filtered = tickers.filter(t => isApprovedSymbolCheck(t.symbol));

        res.json({ tickers: filtered });
    } catch (error) {
        next(error);
    }
});

// GET /api/weex/ticker/:symbol
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

// GET /api/weex/depth/:symbol
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

// GET /api/weex/candles/:symbol
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

// GET /api/weex/contracts
router.get('/contracts', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const contracts = await weex.getContracts();

        const filtered = contracts.filter(c => isApprovedSymbolCheck(c.symbol));

        res.json({ contracts: filtered });
    } catch (error) {
        next(error);
    }
});

// PRIVATE ENDPOINTS

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
                    // Debug: log what we get from WEEX
                    if (orders && orders.length > 0) {
                        logger.debug(`Plan orders for ${symbol}: ${orders.length} orders`, {
                            orders: orders.map((o: any) => ({
                                type: o.type,
                                planType: o.planType || o.plan_type,
                                positionSide: o.positionSide || o.position_side,
                                triggerPrice: o.triggerPrice || o.trigger_price,
                                size: o.size,
                                status: o.status
                            }))
                        });
                    } else {
                        logger.debug(`No plan orders for ${symbol}`);
                    }
                    return { symbol, orders };
                } catch (err) {
                    logger.warn(`Failed to fetch plan orders for ${symbol}:`, err);
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

            // Debug: log plan orders for each position
            logger.debug(`Position ${pos.symbol} (${pos.side}): ${planOrders.length} plan orders found`);

            // Get TP/SL orders for this position
            // WEEX plan orders return 'type' field:
            // WEEX plan orders can be:
            // 1. Regular trigger orders with type field (1-6)
            // 2. TP/SL orders placed via placeTpSlOrder with planType field (profit_plan/loss_plan)
            let stopLoss: number | null = null;
            let takeProfit: number | null = null;

            const isLongPos = pos.side === 'LONG';

            // Get entry price first - needed for SL/TP inference when markPrice is unavailable
            const size = parseFloat(String(pos.size)) || 0;
            const actualEntryPrice = pos.entryPrice
                ? parseFloat(String(pos.entryPrice))
                : (size > 0 ? parseFloat(String(pos.openValue || '0')) / size : 0);

            // Use markPrice if available, otherwise fall back to entryPrice for SL/TP inference
            const referencePrice = markPrice > 0 ? markPrice : actualEntryPrice;

            // Filter to only close orders for this position's direction
            // WEEX API returns type as string names: 'CLOSE_LONG', 'CLOSE_SHORT'
            // Or numeric: 3/5 for close long, 4/6 for close short
            const relevantTypes = isLongPos
                ? ['CLOSE_LONG', '3', '5']
                : ['CLOSE_SHORT', '4', '6'];

            for (const order of planOrders) {
                const orderType = String(order.type || '');
                const planType = String(order.planType || order.plan_type || '');
                const positionSide = String(order.positionSide || order.position_side || '').toLowerCase();

                // Check if this is a TP/SL order via planType
                const isTpSlOrder = planType === 'profit_plan' || planType === 'loss_plan';

                // For TP/SL orders, check positionSide matches our position
                if (isTpSlOrder) {
                    const orderIsForLong = positionSide === 'long';
                    if (orderIsForLong !== isLongPos) continue; // Skip if wrong direction
                }
                // For regular trigger orders, check type
                else if (!relevantTypes.includes(orderType)) {
                    continue; // Skip if not a close order for this direction
                }

                const triggerPrice = parseFloat(order.triggerPrice || order.trigger_price || '0');
                if (triggerPrice <= 0 || !Number.isFinite(triggerPrice)) continue;

                // For TP/SL orders, use planType to determine SL vs TP
                if (isTpSlOrder) {
                    if (planType === 'loss_plan') {
                        // Stop loss order
                        if (isLongPos) {
                            // For LONG, use highest SL (closest to current)
                            if (stopLoss === null || triggerPrice > stopLoss) {
                                stopLoss = triggerPrice;
                            }
                        } else {
                            // For SHORT, use lowest SL (closest to current)
                            if (stopLoss === null || triggerPrice < stopLoss) {
                                stopLoss = triggerPrice;
                            }
                        }
                    } else if (planType === 'profit_plan') {
                        // Take profit order
                        if (isLongPos) {
                            // For LONG, use lowest TP (closest to current)
                            if (takeProfit === null || triggerPrice < takeProfit) {
                                takeProfit = triggerPrice;
                            }
                        } else {
                            // For SHORT, use highest TP (closest to current)
                            if (takeProfit === null || triggerPrice > takeProfit) {
                                takeProfit = triggerPrice;
                            }
                        }
                    }
                    continue;
                }

                // For regular trigger orders, infer SL/TP from trigger price vs reference
                // Skip if we have no reference price to compare against
                if (referencePrice <= 0) continue;

                // Determine if this is SL or TP based on trigger price vs reference price
                // For LONG: SL trigger < reference (close at loss), TP trigger > reference (close at profit)
                // For SHORT: SL trigger > reference (close at loss), TP trigger < reference (close at profit)
                if (isLongPos) {
                    if (triggerPrice < referencePrice) {
                        // SL for LONG - triggers when price drops
                        // Use the HIGHEST SL (closest to current price, smallest loss)
                        if (stopLoss === null || triggerPrice > stopLoss) {
                            stopLoss = triggerPrice;
                        }
                    } else if (triggerPrice > referencePrice) {
                        // TP for LONG - triggers when price rises
                        // Use the LOWEST TP (closest to current price, first profit target)
                        if (takeProfit === null || triggerPrice < takeProfit) {
                            takeProfit = triggerPrice;
                        }
                    }
                    // triggerPrice === referencePrice is ambiguous, skip it
                } else {
                    if (triggerPrice > referencePrice) {
                        // SL for SHORT - triggers when price rises
                        // Use the LOWEST SL (closest to current price, smallest loss)
                        if (stopLoss === null || triggerPrice < stopLoss) {
                            stopLoss = triggerPrice;
                        }
                    } else if (triggerPrice < referencePrice) {
                        // TP for SHORT - triggers when price drops
                        // Use the HIGHEST TP (closest to current price, first profit target)
                        if (takeProfit === null || triggerPrice > takeProfit) {
                            takeProfit = triggerPrice;
                        }
                    }
                    // triggerPrice === referencePrice is ambiguous, skip it
                }
            }

            // Debug: log if we found SL/TP
            if (stopLoss || takeProfit) {
                logger.debug(`${pos.symbol} ${pos.side}: SL=${stopLoss}, TP=${takeProfit}`);
            } else if (planOrders.length > 0) {
                logger.debug(`${pos.symbol} ${pos.side}: No SL/TP found from ${planOrders.length} plan orders`);
            }

            // Calculate SL/TP P&L - the realized P&L when SL/TP is triggered
            // This matches WEEX's "exit plan" display which shows total P&L from entry
            const isLong = isLongPos;

            let slDistance: number | null = null;
            let tpDistance: number | null = null;

            if (stopLoss && actualEntryPrice > 0 && size > 0) {
                // SL P&L = P&L when price hits stopLoss (from entry, not current)
                const rawSlDist = isLong
                    ? (stopLoss - actualEntryPrice) * size  // LONG: SL below entry = negative (loss)
                    : (actualEntryPrice - stopLoss) * size; // SHORT: SL above entry = negative (loss)
                slDistance = Number.isFinite(rawSlDist) ? rawSlDist : null;
            }

            if (takeProfit && actualEntryPrice > 0 && size > 0) {
                // TP P&L = P&L when price hits takeProfit (from entry, not current)
                const rawTpDist = isLong
                    ? (takeProfit - actualEntryPrice) * size  // LONG: TP above entry = positive (profit)
                    : (actualEntryPrice - takeProfit) * size; // SHORT: TP below entry = positive (profit)
                tpDistance = Number.isFinite(rawTpDist) ? rawTpDist : null;
            }

            return {
                ...pos,
                markPrice: Number.isFinite(markPrice) ? markPrice : 0,
                entryPrice: actualEntryPrice,
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
