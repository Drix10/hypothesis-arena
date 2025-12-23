import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query, queryOne } from '../../config/database';
import { getWeexClient } from '../../services/weex/WeexClient';
import { cacheGet, cacheSet } from '../../config/redis';
import { v4 as uuid } from 'uuid';

const router = Router();

// GET /api/portfolio/summary
router.get('/summary', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const portfolios = await query<any>(
            `SELECT * FROM portfolios WHERE user_id = $1 ORDER BY created_at`,
            [req.userId]
        );

        // Calculate totals
        let totalValue = 0;
        let totalReturn = 0;

        for (const p of portfolios) {
            totalValue += parseFloat(p.current_balance) || 0;
            totalReturn += parseFloat(p.total_return) || 0;
        }

        res.json({
            portfolios: portfolios.map(p => ({
                id: p.id,
                agentId: p.agent_name,
                agentName: p.agent_name,
                initialBalance: parseFloat(p.initial_balance),
                currentBalance: parseFloat(p.current_balance),
                totalReturn: parseFloat(p.total_return) || 0,
                winRate: parseFloat(p.win_rate) || 0,
                tradingMode: p.trading_mode,
                status: p.is_active ? 'active' : 'paused',
            })),
            summary: {
                totalValue,
                totalReturn,
                portfolioCount: portfolios.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/portfolio/:agentId
router.get('/:agentId', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const portfolio = await queryOne<any>(
            `SELECT * FROM portfolios WHERE agent_name = $1 AND user_id = $2`,
            [req.params.agentId, req.userId]
        );

        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio not found' });
            return;
        }

        // Get positions
        const positions = await query<any>(
            `SELECT * FROM positions WHERE portfolio_id = $1 AND is_open = true`,
            [portfolio.id]
        );

        // Get recent trades
        const trades = await query<any>(
            `SELECT * FROM trades WHERE portfolio_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [portfolio.id]
        );

        res.json({
            id: portfolio.id,
            agentId: portfolio.agent_name,
            agentName: portfolio.agent_name,
            initialBalance: parseFloat(portfolio.initial_balance),
            currentBalance: parseFloat(portfolio.current_balance),
            totalValue: parseFloat(portfolio.current_balance),
            totalReturn: parseFloat(portfolio.total_return) || 0,
            winRate: parseFloat(portfolio.win_rate) || 0,
            sharpeRatio: parseFloat(portfolio.sharpe_ratio) || null,
            maxDrawdown: parseFloat(portfolio.max_drawdown) || 0,
            tradingMode: portfolio.trading_mode,
            status: portfolio.is_active ? 'active' : 'paused',
            positions: positions.map((p: any) => ({
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                size: parseFloat(p.size),
                entryPrice: parseFloat(p.entry_price),
                currentPrice: parseFloat(p.current_price),
                unrealizedPnL: parseFloat(p.unrealized_pnl) || 0,
                leverage: parseFloat(p.leverage) || 1,
            })),
            recentTrades: trades.map((t: any) => ({
                id: t.id,
                symbol: t.symbol,
                side: t.side,
                size: parseFloat(t.size),
                price: parseFloat(t.price),
                status: t.status,
                createdAt: new Date(t.created_at).getTime(),
            })),
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/portfolio/:agentId/positions
router.get('/:agentId/positions', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const portfolio = await queryOne<any>(
            `SELECT id, trading_mode FROM portfolios WHERE agent_name = $1 AND user_id = $2`,
            [req.params.agentId, req.userId]
        );

        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio not found' });
            return;
        }

        // If live mode, fetch from WEEX
        if (portfolio.trading_mode === 'live') {
            const cacheKey = `positions:${req.userId}:${req.params.agentId}`;
            const cached = await cacheGet<any[]>(cacheKey);

            if (cached) {
                res.json({ positions: cached });
                return;
            }

            const weexClient = getWeexClient();
            const weexPositions = await weexClient.getPositions();

            const positions = weexPositions.map(p => ({
                symbol: p.symbol,
                side: p.side.toUpperCase(),
                size: parseFloat(p.size),
                entryPrice: parseFloat(p.openValue) / parseFloat(p.size),
                currentPrice: parseFloat(p.markPrice),
                unrealizedPnL: parseFloat(p.unrealizePnl),
                leverage: parseFloat(p.leverage),
                liquidationPrice: parseFloat(p.liquidationPrice),
            }));

            await cacheSet(cacheKey, positions, 5);
            res.json({ positions });
            return;
        }

        // Paper mode - fetch from DB
        const positions = await query<any>(
            `SELECT * FROM positions WHERE portfolio_id = $1 AND is_open = true`,
            [portfolio.id]
        );

        res.json({
            positions: positions.map((p: any) => ({
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                size: parseFloat(p.size),
                entryPrice: parseFloat(p.entry_price),
                currentPrice: parseFloat(p.current_price),
                unrealizedPnL: parseFloat(p.unrealized_pnl) || 0,
                leverage: parseFloat(p.leverage) || 1,
            })),
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/portfolio/create
router.post('/create', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { agentName, initialBalance = 100000, tradingMode = 'paper' } = req.body;

        if (!agentName) {
            res.status(400).json({ error: 'Agent name required' });
            return;
        }

        // Check if portfolio exists
        const existing = await queryOne<any>(
            `SELECT id FROM portfolios WHERE agent_name = $1 AND user_id = $2`,
            [agentName, req.userId]
        );

        if (existing) {
            res.status(409).json({ error: 'Portfolio already exists for this agent' });
            return;
        }

        const id = uuid();
        await query(
            `INSERT INTO portfolios (id, user_id, agent_name, initial_balance, current_balance, trading_mode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, NOW(), NOW())`,
            [id, req.userId, agentName, initialBalance, tradingMode]
        );

        res.status(201).json({
            id,
            agentName,
            initialBalance,
            currentBalance: initialBalance,
            tradingMode,
        });
    } catch (error) {
        next(error);
    }
});

// PUT /api/portfolio/:agentId/mode
router.put('/:agentId/mode', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { mode } = req.body;

        if (!['paper', 'live'].includes(mode)) {
            res.status(400).json({ error: 'Invalid mode. Must be "paper" or "live"' });
            return;
        }

        const result = await query(
            `UPDATE portfolios SET trading_mode = $1, updated_at = NOW() 
       WHERE agent_name = $2 AND user_id = $3
       RETURNING id`,
            [mode, req.params.agentId, req.userId]
        );

        if (result.length === 0) {
            res.status(404).json({ error: 'Portfolio not found' });
            return;
        }

        res.json({ message: `Trading mode set to ${mode}` });
    } catch (error) {
        next(error);
    }
});

export default router;
