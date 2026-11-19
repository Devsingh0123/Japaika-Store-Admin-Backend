import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { normalizeEmail } from '../services/auth.service.js';
import { sendError } from '../utils/response.js';

function rateLimitHandler(_req, res) {
  return sendError(res, {
    statusCode: 429,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please try again later.',
    details: [],
  });
}

export function createLoginIpRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitHandler,
    ...overrides,
  });
}

export function createLoginAccountRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ipKey = ipKeyGenerator(req.ip || '127.0.0.1');
      const emailKey = normalizeEmail(req.body?.email) || 'unknown';
      return `${ipKey}:${emailKey}`;
    },
    handler: rateLimitHandler,
    ...overrides,
  });
}

export function createRefreshRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitHandler,
    ...overrides,
  });
}

export const loginIpRateLimiter = createLoginIpRateLimiter();
export const loginAccountRateLimiter = createLoginAccountRateLimiter();
export const refreshRateLimiter = createRefreshRateLimiter();
