import { Router } from 'express';
import authRoutes from './auth';
import tradingRoutes from './trading';
import portfolioRoutes from './portfolio';

const router = Router();

router.use('/auth', authRoutes);
router.use('/trading', tradingRoutes);
router.use('/portfolio', portfolioRoutes);

export { router as apiRouter };
