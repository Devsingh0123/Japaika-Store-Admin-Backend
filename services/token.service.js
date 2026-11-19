import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { AppError } from '../utils/http.js';

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDurationToMs(duration, fallbackMs) {
  const match = String(duration || '').trim().match(/^(\d+)([smhd])$/i);
  return match ? Number(match[1]) * UNIT_MS[match[2].toLowerCase()] : fallbackMs;
}

export function getRefreshMaxAgeMs() {
  return parseDurationToMs(env.jwt.refreshExpiresIn, 7 * UNIT_MS.d);
}

export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

export function signAccessToken(admin) {
  return jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      subType: 'admin',
      tokenType: 'access',
    },
    env.jwt.accessSecret,
    {
      algorithm: 'HS256',
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      expiresIn: env.jwt.accessExpiresIn,
    }
  );
}

export function signRefreshToken({ adminId, tokenId, familyId }) {
  return jwt.sign(
    {
      sub: adminId,
      jti: tokenId,
      familyId,
      subType: 'admin',
      tokenType: 'refresh',
    },
    env.jwt.refreshSecret,
    {
      algorithm: 'HS256',
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      expiresIn: env.jwt.refreshExpiresIn,
    }
  );
}

function verifyJwt(token, { secret, tokenType, errorCode, errorMessage }) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });

    if (
      typeof payload !== 'object' ||
      payload.subType !== 'admin' ||
      payload.tokenType !== tokenType ||
      !payload.sub
    ) {
      throw new AppError(401, errorCode, errorMessage);
    }

    if (tokenType === 'refresh' && (!payload.jti || !payload.familyId)) {
      throw new AppError(401, errorCode, errorMessage);
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, errorCode, errorMessage);
  }
}

export function verifyAccessToken(token) {
  return verifyJwt(token, {
    secret: env.jwt.accessSecret,
    tokenType: 'access',
    errorCode: 'UNAUTHORIZED',
    errorMessage: 'Authentication token is invalid or expired.',
  });
}

export function verifyRefreshToken(token) {
  return verifyJwt(token, {
    secret: env.jwt.refreshSecret,
    tokenType: 'refresh',
    errorCode: 'INVALID_REFRESH_TOKEN',
    errorMessage: 'Refresh token is invalid or expired.',
  });
}

function cookieBaseOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    ...(env.cookie.domain ? { domain: env.cookie.domain } : {}),
  };
}

export function setAuthCookies(res, { accessToken, refreshToken }) {
  const base = cookieBaseOptions();
  res.cookie(env.cookie.accessName, accessToken, {
    ...base,
    path: '/',
    maxAge: parseDurationToMs(env.jwt.accessExpiresIn, 15 * UNIT_MS.m),
  });
  res.cookie(env.cookie.refreshName, refreshToken, {
    ...base,
    path: '/api/v1/auth',
    maxAge: getRefreshMaxAgeMs(),
  });
}

export function clearAuthCookies(res) {
  const base = cookieBaseOptions();
  res.clearCookie(env.cookie.accessName, { ...base, path: '/' });
  res.clearCookie(env.cookie.refreshName, { ...base, path: '/api/v1/auth' });
}
