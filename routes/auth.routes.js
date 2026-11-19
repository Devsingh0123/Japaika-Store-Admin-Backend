import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate.middleware.js';
import {
  loginIpLimiter,
  loginAccountLimiter,
  refreshLimiter,
} from '../middlewares/rateLimit.middleware.js';
import requireAdminAuth from '../middlewares/auth.middleware.js';
import * as authController from '../controllers/auth.controller.js';

const loginSchema = z.object({
  email: z
    .string({ error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    .max(255, 'Email must not exceed 255 characters.')
    .email('Please provide a valid email address.'),
  password: z
    .string({ error: 'Password is required.' })
    .min(1, 'Password is required.')
    .max(128, 'Password must not exceed 128 characters.'),
});

const router = Router();

router.post(
  '/login',
  loginIpLimiter,
  validateBody(loginSchema),
  loginAccountLimiter,
  authController.login
);
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-all', requireAdminAuth, authController.logoutAll);
router.get('/me', requireAdminAuth, authController.getMe);

export default router;
