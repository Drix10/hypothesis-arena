import { Router } from 'express';
import authRoutes from './auth';
import tradingRoutes from './trading';
import portfolioRoutes from './portfolio';
import weexRoutes from './weex';
import analysisRoutes from './analysis';

const router = Router();

router.use('/auth', authRoutes);
router.use('/trading', tradingRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/weex', weexRoutes);
router.use('/analysis', analysisRoutes);

export { router as apiRouter };
