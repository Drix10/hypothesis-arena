import { Router, Request, Response, NextFunction } from 'express';
import tradingRoutes from './trading';
import portfolioRoutes from './portfolio';
import weexRoutes from './weex';
import analysisRoutes from './analysis';
import autonomousRoutes from './autonomous';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query } from '../../config/database';
import { logger } from '../../utils/logger';

const router = Router();

router.use('/trading', tradingRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/weex', weexRoutes);
router.use('/analysis', analysisRoutes);
router.use('/autonomous', autonomousRoutes);

// Frontend compatibility routes (map to existing endpoints)

// GET /api/portfolio - Frontend expects this for portfolio summary
router.get('/portfolio', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const assets = await weex.getAccountAssets();
        const positions = await weex.getPositions();

        // FIXED: Validate numeric values before parsing
        const balance = parseFloat(assets.available || '0');
        const equity = parseFloat(assets.equity || '0');

        if (!Number.isFinite(balance) || !Number.isFinite(equity)) {
            throw new Error('Invalid balance or equity value from WEEX API');
        }

        // Calculate unrealized P&L from positions
        let unrealizedPnl = 0;
        for (const pos of positions) {
            if (pos.unrealizePnl) {
                const pnl = parseFloat(pos.unrealizePnl);
                if (Number.isFinite(pnl)) {
                    unrealizedPnl += pnl;
                }
            }
        }

        res.json({
            balance,
            equity,
            unrealizedPL: unrealizedPnl, // Frontend expects unrealizedPL (capital PL)
            positionsCount: positions.length
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/market/overview - Frontend expects market data
router.get('/market/overview', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();

        // Get tickers for approved symbols
        const symbols = ['cmt_btcusdt', 'cmt_ethusdt', 'cmt_bnbusdt', 'cmt_ltcusdt'];
        const markets = await Promise.all(
            symbols.map(async (symbol) => {
                try {
                    const ticker = await weex.getTicker(symbol);
                    const price = parseFloat(ticker.last || '0');
                    const change24h = parseFloat(ticker.priceChangePercent || '0');

                    // FIXED: Validate numeric values
                    if (!Number.isFinite(price) || !Number.isFinite(change24h)) {
                        logger.warn(`Invalid ticker data for ${symbol}`);
                        return null;
                    }

                    return {
                        symbol: symbol.replace('cmt_', '').replace('usdt', '').toUpperCase(),
                        price,
                        change24h
                    };
                } catch (error) {
                    logger.warn(`Failed to fetch ticker for ${symbol}:`, error);
                    return null;
                }
            })
        );

        res.json({ markets: markets.filter(m => m !== null) });
    } catch (error) {
        next(error);
    }
});

// GET /api/positions - Frontend expects positions list
router.get('/positions', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const weex = getWeexClient();
        const positions = await weex.getPositions();

        const formattedPositions = positions
            .filter((p) => {
                const size = parseFloat(p.size || '0');
                return Number.isFinite(size) && size > 0;
            })
            .map((p) => {
                // FIXED: Calculate current price from unrealized PnL and entry price
                // markPrice is not available in WeexPosition, so we derive it
                const size = parseFloat(String(p.size || '0'));
                const entryPrice = p.entryPrice || 0;
                const unrealizePnl = parseFloat(String(p.unrealizePnl || '0'));

                // Derive current price from PnL if possible
                // PnL = (currentPrice - entryPrice) * size * direction
                // For LONG: currentPrice = entryPrice + (PnL / size)
                // For SHORT: currentPrice = entryPrice - (PnL / size)
                let currentPrice = entryPrice; // Fallback to entry price
                if (size > 0 && entryPrice > 0 && Number.isFinite(unrealizePnl)) {
                    const pnlPerUnit = unrealizePnl / size;
                    if (p.side === 'LONG') {
                        currentPrice = entryPrice + pnlPerUnit;
                    } else {
                        currentPrice = entryPrice - pnlPerUnit;
                    }
                    // Sanity check - price should be positive
                    if (currentPrice <= 0 || !Number.isFinite(currentPrice)) {
                        currentPrice = entryPrice;
                    }
                }

                // Parse and validate liquidation price
                const liqPrice = parseFloat(String(p.liquidationPrice || '0'));
                const validLiqPrice = Number.isFinite(liqPrice) && liqPrice >= 0 ? liqPrice : 0;

                // Parse and validate leverage (must be >= 1)
                const lev = parseFloat(String(p.leverage || '1'));
                const validLeverage = Number.isFinite(lev) && lev >= 1 ? lev : 1;

                return {
                    symbol: (p.symbol || '').replace('cmt_', '').replace('usdt', '').toUpperCase(),
                    side: (p.side || '').toUpperCase(),
                    size: Number.isFinite(size) ? size : 0,
                    entryPrice: Number.isFinite(entryPrice) ? entryPrice : 0,
                    markPrice: Number.isFinite(currentPrice) ? currentPrice : entryPrice, // Frontend expects markPrice
                    currentPrice: Number.isFinite(currentPrice) ? currentPrice : entryPrice, // Keep for compatibility
                    liquidationPrice: validLiqPrice,
                    leverage: validLeverage,
                    pnl: Number.isFinite(unrealizePnl) ? unrealizePnl : 0
                };
            });

        res.json({ positions: formattedPositions });
    } catch (error) {
        next(error);
    }
});

// GET /api/activity - Frontend expects recent activity
router.get('/activity', async (_req: Request, res: Response) => {
    try {
        // Get recent trades from database
        const trades = await query<any>(
            `SELECT symbol, side, size, price, status, executed_at 
             FROM trades 
             WHERE executed_at IS NOT NULL 
             ORDER BY executed_at DESC 
             LIMIT 10`
        );

        const activities = trades.map((t: any) => ({
            timestamp: t.executed_at,
            message: `${t.side} ${t.size} ${t.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase()} @ $${t.price}`
        }));

        res.json({ activities });
    } catch (error: any) {
        res.status(500).json({ error: error.message, activities: [] });
    }
});

export { router as apiRouter };
