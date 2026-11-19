import { Router } from 'express';
import { z } from 'zod';
import defaultAuthController from '../controllers/auth.controller.js';
import defaultAuthenticateAdmin from '../middlewares/auth.middleware.js';
import {
  loginIpRateLimiter as defaultLoginIpLimiter,
  loginAccountRateLimiter as defaultLoginAccountLimiter,
  refreshRateLimiter as defaultRefreshLimiter,
} from '../middlewares/rateLimit.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';

export const loginSchema = z.object({
  email: z
    .string({ error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    .email('Please provide a valid email address.'),
  password: z
    .string({ error: 'Password is required.' })
    .min(1, 'Password is required.')
    .max(128, 'Password must not exceed 128 characters.'),
});

export function createAuthRouter({
  authController = defaultAuthController,
  authenticateAdmin = defaultAuthenticateAdmin,
  loginIpRateLimiter = defaultLoginIpLimiter,
  loginAccountRateLimiter = defaultLoginAccountLimiter,
  refreshRateLimiter = defaultRefreshLimiter,
} = {}) {
  const router = Router();

  router.post(
    '/login',
    loginIpRateLimiter,
    validateBody(loginSchema),
    loginAccountRateLimiter,
    authController.login,
  );

  router.post('/refresh', refreshRateLimiter, authController.refresh);
  router.post('/logout', authController.logout);
  router.post('/logout-all', authenticateAdmin, authController.logoutAll);
  router.get('/me', authenticateAdmin, authController.getCurrentAdmin);

  return router;
}

const authRouter = createAuthRouter();
export default authRouter;
