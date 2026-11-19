import { Router } from 'express';
import defaultHealthController from '../controllers/health.controller.js';
import defaultAuthRouter from './auth.routes.js';

export function createApiRouter({
  healthController = defaultHealthController,
  authRouter = defaultAuthRouter,
} = {}) {
  const router = Router();

  router.get('/health', healthController.getHealth);
  router.use('/auth', authRouter);

  return router;
}

const apiRouter = createApiRouter();
export default apiRouter;
