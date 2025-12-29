import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query, queryOne } from '../../config/database';
import { getWeexClient } from '../../services/weex/WeexClient';
import { cacheGet, cacheSet } from '../../config/redis';
import { logger } from '../../utils/logger';
import { v4 as uuid } from 'uuid';

const router = Router();

// Helper to validate agentId format (alphanumeric, underscore, hyphen, 1-50 chars)
const isValidAgentId = (agentId: string): boolean => {
    return /^[a-zA-Z0-9_-]{1,50}$/.test(agentId);
};

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
                initialBalance: parseFloat(p.initial_balance) || 0,
                currentBalance: parseFloat(p.current_balance) || 0,
                totalReturn: parseFloat(p.total_return) || 0,
                winRate: parseFloat(p.win_rate) || 0,
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
        const { agentId } = req.params;

        if (!isValidAgentId(agentId)) {
            res.status(400).json({ error: 'Invalid agent ID format' });
            return;
        }

        const portfolio = await queryOne<any>(
            `SELECT * FROM portfolios WHERE agent_name = $1 AND user_id = $2`,
            [agentId, req.userId]
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
            initialBalance: parseFloat(portfolio.initial_balance) || 0,
            currentBalance: parseFloat(portfolio.current_balance) || 0,
            totalValue: parseFloat(portfolio.current_balance) || 0,
            totalReturn: parseFloat(portfolio.total_return) || 0,
            winRate: parseFloat(portfolio.win_rate) || 0,
            sharpeRatio: portfolio.sharpe_ratio ? parseFloat(portfolio.sharpe_ratio) : null,
            maxDrawdown: parseFloat(portfolio.max_drawdown) || 0,
            status: portfolio.is_active ? 'active' : 'paused',
            positions: positions.map((p: any) => ({
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                size: parseFloat(p.size) || 0,
                entryPrice: parseFloat(p.entry_price) || 0,
                currentPrice: parseFloat(p.current_price) || 0,
                unrealizedPnL: parseFloat(p.unrealized_pnl) || 0,
                leverage: parseFloat(p.leverage) || 1,
            })),
            recentTrades: trades.map((t: any) => ({
                id: t.id,
                symbol: t.symbol,
                side: t.side,
                size: parseFloat(t.size) || 0,
                price: parseFloat(t.price) || 0,
                status: t.status,
                createdAt: t.created_at ? new Date(t.created_at).getTime() : Date.now(),
            })),
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/portfolio/:agentId/positions
router.get('/:agentId/positions', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { agentId } = req.params;

        if (!isValidAgentId(agentId)) {
            res.status(400).json({ error: 'Invalid agent ID format' });
            return;
        }

        const portfolio = await queryOne<any>(
            `SELECT id, agent_name FROM portfolios WHERE agent_name = $1 AND user_id = $2`,
            [agentId, req.userId]
        );

        if (!portfolio) {
            res.status(404).json({ error: 'Portfolio not found' });
            return;
        }

        // Fetch positions from WEEX
        const cacheKey = `positions:${req.userId}:${agentId}`;
        const cached = await cacheGet<any[]>(cacheKey);

        if (cached) {
            res.json({ positions: cached });
            return;
        }

        let weexPositions: any[] = [];
        try {
            const weexClient = getWeexClient();
            weexPositions = await weexClient.getPositions();
        } catch (error: any) {
            // Log error but return empty positions instead of failing
            logger.error('WEEX API error fetching positions:', { message: error.message });
            res.json({ positions: [], error: 'Unable to fetch positions from exchange' });
            return;
        }

        // Validate response is an array
        if (!Array.isArray(weexPositions)) {
            res.json({ positions: [], error: 'Invalid response from exchange' });
            return;
        }

        // Filter and map positions with proper null safety
        // Positions are normalized by WeexClient - use camelCase properties
        const positions = weexPositions
            .filter(p => p && typeof p === 'object' && p.symbol && p.size)
            .map(p => {
                const size = parseFloat(p.size) || 0;
                const openValue = parseFloat(p.openValue) || 0;
                // Prevent division by zero
                const entryPrice = size !== 0 ? openValue / Math.abs(size) : 0;

                return {
                    symbol: String(p.symbol || ''),
                    side: p.side, // Already normalized to 'LONG' | 'SHORT'
                    size: Math.abs(size),
                    entryPrice,
                    currentPrice: parseFloat(p.markPrice) || 0,
                    unrealizedPnL: parseFloat(p.unrealizePnl) || 0,
                    leverage: parseFloat(p.leverage) || 1,
                    liquidationPrice: parseFloat(p.liquidationPrice) || 0,
                    portfolioId: portfolio.id,
                };
            });

        await cacheSet(cacheKey, positions, 5);
        res.json({ positions });
    } catch (error) {
        next(error);
    }
});

// POST /api/portfolio/create
router.post('/create', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { agentName, initialBalance = 100000 } = req.body;

        if (!agentName || typeof agentName !== 'string') {
            res.status(400).json({ error: 'Agent name required' });
            return;
        }

        if (!isValidAgentId(agentName)) {
            res.status(400).json({ error: 'Invalid agent name format (alphanumeric, underscore, hyphen, 1-50 chars)' });
            return;
        }

        const balance = Number(initialBalance);
        if (isNaN(balance) || balance < 0 || balance > 1000000000) {
            res.status(400).json({ error: 'Invalid initial balance (0 - 1,000,000,000)' });
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
            `INSERT INTO portfolios (id, user_id, agent_name, initial_balance, current_balance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, NOW(), NOW())`,
            [id, req.userId, agentName, balance]
        );

        res.status(201).json({
            id,
            agentName,
            initialBalance: balance,
            currentBalance: balance,
        });
    } catch (error) {
        next(error);
    }
});

export default router;
