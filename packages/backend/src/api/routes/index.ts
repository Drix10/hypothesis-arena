import { Router } from 'express';
import authRoutes from './auth';
import tradingRoutes from './trading';
import portfolioRoutes from './portfolio';
import weexRoutes from './weex';

const router = Router();

router.use('/auth', authRoutes);
router.use('/trading', tradingRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/weex', weexRoutes);

export { router as apiRouter };
