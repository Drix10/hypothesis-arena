import { Router } from 'express';
import tradingRoutes from './trading';
import portfolioRoutes from './portfolio';
import weexRoutes from './weex';
import analysisRoutes from './analysis';
import autonomousRoutes from './autonomous';

const router = Router();

router.use('/trading', tradingRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/weex', weexRoutes);
router.use('/analysis', analysisRoutes);
router.use('/autonomous', autonomousRoutes);

export { router as apiRouter };
