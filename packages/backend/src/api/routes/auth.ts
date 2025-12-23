import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '../../services/auth/AuthService';
import { authenticate } from '../middleware/auth';

const router = Router();

const registerSchema = z.object({
    email: z.string().email(),
    username: z.string().min(3).max(50),
    password: z.string().min(8),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const data = registerSchema.parse(req.body);
        const result = await authService.register(data);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const data = loginSchema.parse(req.body);
        const result = await authService.login(data);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(400).json({ error: 'Refresh token required' });
            return;
        }
        const tokens = await authService.refreshToken(refreshToken);
        res.json(tokens);
    } catch (error) {
        next(error);
    }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = await authService.getUserById(req.userId!);
        res.json({ user });
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req: Request, res: Response) => {
    // In a stateless JWT setup, logout is handled client-side
    // For stateful sessions, you'd invalidate the token here
    res.json({ message: 'Logged out successfully' });
});

export default router;
