/**
 * Analysis API Routes
 * 
 * Endpoints for AI-powered market analysis and debates.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { geminiService, ExtendedMarketData } from '../../services/ai/GeminiService';
import { ANALYST_PROFILES } from '../../constants/analystPrompts';
import { getWeexClient } from '../../services/weex/WeexClient';
import { analysisService } from '../../services/analysis/AnalysisService';
import { APPROVED_SYMBOLS } from '@hypothesis-arena/shared';

// Get all analyst IDs for validation
const ANALYST_IDS = Object.values(ANALYST_PROFILES).map(a => a.id);

const router = Router();

// Validate symbol helper
const isValidSymbol = (symbol: string): boolean => {
    return /^[a-z0-9_]+$/i.test(symbol) && symbol.length <= 50;
};

const isApprovedSymbol = (symbol: string): boolean => {
    return (APPROVED_SYMBOLS as readonly string[]).includes(symbol);
};

// Safe parseFloat that returns 0 for invalid values
const safeParseFloat = (value: string | undefined | null, fallback: number = 0): number => {
    if (value === undefined || value === null) return fallback;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

// Safe calculation of 24h change percentage
const calculateChange24h = (price: number, high: number, low: number, priceChangePercent?: string): number => {
    if (priceChangePercent) {
        const parsed = parseFloat(priceChangePercent);
        if (Number.isFinite(parsed)) return parsed * 100;
    }
    const mid = (high + low) / 2;
    if (mid <= 0 || !Number.isFinite(mid)) return 0;
    const change = ((price - mid) / mid) * 100;
    return Number.isFinite(change) ? change : 0;
};

// GET /api/analysis/analysts - Get all analyst personas
router.get('/analysts', (req: Request, res: Response) => {
    const analysts = Object.entries(ANALYST_PROFILES).map(([methodology, a]) => ({
        id: a.id,
        name: a.name,
        emoji: a.avatarEmoji,
        title: a.title,
        methodology,
        description: a.description,
        focusAreas: a.focusAreas,
        biases: a.biases,
    }));
    res.json({ analysts });
});

// GET /api/analysis/status - Check if AI service is configured
router.get('/status', (req: Request, res: Response) => {
    res.json({
        configured: geminiService.isConfigured(),
        analystsAvailable: ANALYST_IDS.length,
    });
});

// POST /api/analysis/generate - Generate analysis for a symbol
router.post('/generate', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, analystId } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        // Validate analystId if provided
        if (analystId !== undefined && typeof analystId !== 'string') {
            res.status(400).json({ error: 'Invalid analystId format' });
            return;
        }

        if (analystId && !ANALYST_IDS.includes(analystId)) {
            res.status(400).json({ error: 'Unknown analyst ID' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured. Set GEMINI_API_KEY in environment.' });
            return;
        }

        // Get current market data
        const weex = getWeexClient();
        const ticker = await weex.getTicker(normalizedSymbol);

        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }

        const analysis = await geminiService.generateAnalysis({
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: safeParseFloat(ticker.high_24h, price),
            low24h: safeParseFloat(ticker.low_24h, price),
            volume24h: safeParseFloat(ticker.volume_24h),
            analystId,
        }, req.userId);

        res.json({ analysis });
    } catch (error) {
        next(error);
    }
});

// POST /api/analysis/generate-all - Generate analyses from all 8 analysts
router.post('/generate-all', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured' });
            return;
        }

        // Get current market data
        const weex = getWeexClient();
        const ticker = await weex.getTicker(normalizedSymbol);

        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }

        const analyses = await geminiService.generateAllAnalyses({
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: safeParseFloat(ticker.high_24h, price),
            low24h: safeParseFloat(ticker.low_24h, price),
            volume24h: safeParseFloat(ticker.volume_24h),
        }, req.userId);

        res.json({
            symbol: normalizedSymbol,
            analyses,
            count: analyses.length,
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/analysis/debate - Generate a debate between two analysts
router.post('/debate', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, bullAnalystId, bearAnalystId } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        // Validate analyst IDs if provided
        if (bullAnalystId !== undefined && typeof bullAnalystId !== 'string') {
            res.status(400).json({ error: 'Invalid bullAnalystId format' });
            return;
        }
        if (bearAnalystId !== undefined && typeof bearAnalystId !== 'string') {
            res.status(400).json({ error: 'Invalid bearAnalystId format' });
            return;
        }
        if (bullAnalystId && !ANALYST_IDS.includes(bullAnalystId)) {
            res.status(400).json({ error: 'Unknown bull analyst ID' });
            return;
        }
        if (bearAnalystId && !ANALYST_IDS.includes(bearAnalystId)) {
            res.status(400).json({ error: 'Unknown bear analyst ID' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured' });
            return;
        }

        // Get market data
        const weex = getWeexClient();
        const ticker = await weex.getTicker(normalizedSymbol);
        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }
        const high = safeParseFloat(ticker.high_24h, price);
        const low = safeParseFloat(ticker.low_24h, price);
        const change24h = calculateChange24h(price, high, low, ticker.priceChangePercent);

        // Generate analyses for both sides
        const [bullAnalysis, bearAnalysis] = await Promise.all([
            geminiService.generateAnalysis({
                symbol: normalizedSymbol,
                currentPrice: price,
                high24h: high,
                low24h: low,
                volume24h: safeParseFloat(ticker.volume_24h),
                analystId: bullAnalystId,
            }, req.userId),
            geminiService.generateAnalysis({
                symbol: normalizedSymbol,
                currentPrice: price,
                high24h: high,
                low24h: low,
                volume24h: safeParseFloat(ticker.volume_24h),
                analystId: bearAnalystId,
            }, req.userId),
        ]);

        // Generate debate
        const debate = await geminiService.generateDebate({
            symbol: normalizedSymbol,
            bullAnalysis,
            bearAnalysis,
            round: 'final',
            marketData: { price, change24h },
        }, req.userId);

        res.json({
            symbol: normalizedSymbol,
            bullAnalysis,
            bearAnalysis,
            debate,
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/analysis/signal - Generate trading signal from multiple analyses
router.post('/signal', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured' });
            return;
        }

        // Get market data
        const weex = getWeexClient();
        const ticker = await weex.getTicker(normalizedSymbol);

        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }

        // Generate all analyses
        const analyses = await geminiService.generateAllAnalyses({
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: safeParseFloat(ticker.high_24h, price),
            low24h: safeParseFloat(ticker.low_24h, price),
            volume24h: safeParseFloat(ticker.volume_24h),
        }, req.userId);

        // Require at least some successful analyses to generate a signal
        if (analyses.length === 0) {
            res.status(503).json({ error: 'All analyst requests failed. Please try again.' });
            return;
        }

        // Generate signal (without tournament for quick response)
        const signal = await geminiService.generateTradingSignal(
            normalizedSymbol,
            analyses,
            undefined, // No tournament for quick signal
            req.userId
        );

        res.json({
            symbol: normalizedSymbol,
            signal,
            analysisCount: analyses.length,
            analyses: analyses.map(a => ({
                analyst: a.analystName,
                recommendation: a.recommendation,
                confidence: a.confidence,
            })),
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/analysis/tournament - Run full tournament with debates
router.post('/tournament', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured' });
            return;
        }

        // Get market data
        const weex = getWeexClient();
        const ticker = await weex.getTicker(normalizedSymbol);
        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }
        const high = safeParseFloat(ticker.high_24h, price);
        const low = safeParseFloat(ticker.low_24h, price);
        const volume = safeParseFloat(ticker.volume_24h);
        const change24h = calculateChange24h(price, high, low, ticker.priceChangePercent);

        // Generate all analyses first
        const analyses = await geminiService.generateAllAnalyses({
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: high,
            low24h: low,
            volume24h: volume,
        }, req.userId);

        if (analyses.length < 2) {
            res.status(503).json({ error: 'Not enough analyses generated for tournament' });
            return;
        }

        // Run tournament
        const tournament = await geminiService.runTournament(
            analyses,
            { price, change24h, volume24h: volume },
            normalizedSymbol,
            req.userId
        );

        // Generate final signal with tournament results
        const signal = await geminiService.generateTradingSignal(
            normalizedSymbol,
            analyses,
            tournament,
            req.userId
        );

        res.json({
            symbol: normalizedSymbol,
            analyses,
            tournament: {
                quarterfinals: tournament.quarterfinals,
                semifinals: tournament.semifinals,
                final: tournament.final,
                champion: tournament.champion,
            },
            signal,
            summary: {
                totalAnalysts: analyses.length,
                totalDebates: tournament.quarterfinals.length + tournament.semifinals.length + (tournament.final ? 1 : 0),
                champion: tournament.champion ? {
                    name: tournament.champion.analystName,
                    recommendation: tournament.champion.recommendation,
                    confidence: tournament.champion.confidence,
                    thesis: tournament.champion.thesis,
                } : null,
            },
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/analysis/history - Get user's analysis history
router.get('/history', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, limit = 20 } = req.query;

        const limitNum = Math.min(Math.max(1, Number(limit) || 20), 100);

        const analyses = await analysisService.getRecentAnalyses(
            req.userId!,
            symbol as string | undefined,
            limitNum
        );

        res.json({ analyses });
    } catch (error) {
        next(error);
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE TRADING ENDPOINTS - For WEEX integration
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/analysis/trading-decision - Generate complete trading decision with executable order
router.post('/trading-decision', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, accountBalance, existingPosition } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        // Validate accountBalance - must be a finite positive number
        if (typeof accountBalance !== 'number' || !Number.isFinite(accountBalance) || accountBalance <= 0) {
            res.status(400).json({ error: 'Valid accountBalance required (positive finite number)' });
            return;
        }

        // Validate existingPosition if provided
        if (existingPosition !== undefined) {
            if (typeof existingPosition !== 'object' ||
                existingPosition === null ||
                !['LONG', 'SHORT'].includes(existingPosition.side) ||
                typeof existingPosition.size !== 'number' ||
                !Number.isFinite(existingPosition.size) ||
                existingPosition.size <= 0) {
                res.status(400).json({ error: 'Invalid existingPosition format. Expected { side: "LONG"|"SHORT", size: positive number }' });
                return;
            }
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured. Set GEMINI_API_KEY in environment.' });
            return;
        }

        // Get comprehensive market data from WEEX
        const weex = getWeexClient();
        const [ticker, fundingRate] = await Promise.all([
            weex.getTicker(normalizedSymbol),
            weex.getFundingRate(normalizedSymbol).catch(() => null),
        ]);

        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }
        const high = safeParseFloat(ticker.high_24h, price);
        const low = safeParseFloat(ticker.low_24h, price);
        const change24h = calculateChange24h(price, high, low, ticker.priceChangePercent);

        // Build extended market data
        const marketData: ExtendedMarketData = {
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: high,
            low24h: low,
            volume24h: safeParseFloat(ticker.volume_24h),
            change24h,
            markPrice: ticker.markPrice ? safeParseFloat(ticker.markPrice) : undefined,
            indexPrice: ticker.indexPrice ? safeParseFloat(ticker.indexPrice) : undefined,
            bestBid: ticker.best_bid ? safeParseFloat(ticker.best_bid) : undefined,
            bestAsk: ticker.best_ask ? safeParseFloat(ticker.best_ask) : undefined,
            fundingRate: fundingRate ? safeParseFloat(fundingRate.fundingRate) : undefined,
        };

        // Generate trading decision
        const decision = await geminiService.generateTradingDecision(
            marketData,
            accountBalance,
            existingPosition,
            req.userId
        );

        res.json({
            symbol: normalizedSymbol,
            decision,
            marketData: {
                price: marketData.currentPrice,
                change24h: marketData.change24h,
                fundingRate: marketData.fundingRate,
            },
            timestamp: Date.now(),
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/analysis/extended - Generate analysis with extended market data
router.post('/extended', optionalAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, analystId } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol required' });
            return;
        }

        if (analystId !== undefined && typeof analystId !== 'string') {
            res.status(400).json({ error: 'Invalid analystId format' });
            return;
        }

        if (analystId && !ANALYST_IDS.includes(analystId)) {
            res.status(400).json({ error: 'Unknown analyst ID' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isValidSymbol(normalizedSymbol)) {
            res.status(400).json({ error: 'Invalid symbol format' });
            return;
        }

        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ error: `Symbol not approved` });
            return;
        }

        if (!geminiService.isConfigured()) {
            res.status(503).json({ error: 'AI service not configured' });
            return;
        }

        // Get comprehensive market data
        const weex = getWeexClient();
        const [ticker, fundingRate] = await Promise.all([
            weex.getTicker(normalizedSymbol),
            weex.getFundingRate(normalizedSymbol).catch(() => null),
        ]);

        const price = safeParseFloat(ticker.last);
        if (price <= 0) {
            res.status(503).json({ error: 'Unable to fetch valid market data' });
            return;
        }
        const high = safeParseFloat(ticker.high_24h, price);
        const low = safeParseFloat(ticker.low_24h, price);
        const change24h = calculateChange24h(price, high, low, ticker.priceChangePercent);

        const marketData: ExtendedMarketData = {
            symbol: normalizedSymbol,
            currentPrice: price,
            high24h: high,
            low24h: low,
            volume24h: safeParseFloat(ticker.volume_24h),
            change24h,
            markPrice: ticker.markPrice ? safeParseFloat(ticker.markPrice) : undefined,
            indexPrice: ticker.indexPrice ? safeParseFloat(ticker.indexPrice) : undefined,
            bestBid: ticker.best_bid ? safeParseFloat(ticker.best_bid) : undefined,
            bestAsk: ticker.best_ask ? safeParseFloat(ticker.best_ask) : undefined,
            fundingRate: fundingRate ? safeParseFloat(fundingRate.fundingRate) : undefined,
        };

        const analysis = await geminiService.generateAnalysisWithExtendedData(
            marketData,
            analystId,
            req.userId
        );

        res.json({
            symbol: normalizedSymbol,
            analysis,
            marketData: {
                price: marketData.currentPrice,
                change24h: marketData.change24h,
                fundingRate: marketData.fundingRate,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
