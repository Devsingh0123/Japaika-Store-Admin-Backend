import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import AppError from '../utils/appError.js';

const DURATION_UNITS_MS = Object.freeze({
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
});

export function parseDurationToMs(durationStr, fallbackMs = 15 * 60 * 1000) {
  if (typeof durationStr === 'number' && Number.isFinite(durationStr) && durationStr > 0) {
    return durationStr * 1000;
  }
  if (typeof durationStr !== 'string') {
    return fallbackMs;
  }
  const match = /^(\d+)\s*([smhd])$/i.exec(durationStr.trim());
  if (!match) {
    return fallbackMs;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return amount * DURATION_UNITS_MS[unit];
}

export function hashRefreshToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken) {
    throw new Error('Refresh token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
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
      expiresIn: env.jwt.accessExpiresIn,
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    },
  );
}

export function signRefreshToken({ adminId, jti, familyId }) {
  return jwt.sign(
    {
      sub: adminId,
      jti,
      familyId,
      subType: 'admin',
      tokenType: 'refresh',
    },
    env.jwt.refreshSecret,
    {
      algorithm: 'HS256',
      expiresIn: env.jwt.refreshExpiresIn,
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    },
  );
}

export function verifyAccessToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  }

  try {
    const payload = jwt.verify(token, env.jwt.accessSecret, {
      algorithms: ['HS256'],
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.subType !== 'admin' ||
      payload.tokenType !== 'access' ||
      typeof payload.sub !== 'string'
    ) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid access token claims.');
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token.');
  }
}

export function verifyRefreshToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is missing.');
  }

  try {
    const payload = jwt.verify(token, env.jwt.refreshSecret, {
      algorithms: ['HS256'],
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.subType !== 'admin' ||
      payload.tokenType !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      typeof payload.familyId !== 'string'
    ) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token claims.');
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.');
  }
}

export function getRefreshTokenExpiresAt() {
  const ttlMs = parseDurationToMs(env.jwt.refreshExpiresIn, 7 * 24 * 60 * 60 * 1000);
  return new Date(Date.now() + ttlMs);
}

export function getAccessCookieOptions() {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/',
    maxAge: parseDurationToMs(env.jwt.accessExpiresIn, 15 * 60 * 1000),
  };
  if (env.cookie.domain) {
    options.domain = env.cookie.domain;
  }
  return options;
}

export function getRefreshCookieOptions() {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/api/v1/auth',
    maxAge: parseDurationToMs(env.jwt.refreshExpiresIn, 7 * 24 * 60 * 60 * 1000),
  };
  if (env.cookie.domain) {
    options.domain = env.cookie.domain;
  }
  return options;
}

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(env.cookie.accessName, accessToken, getAccessCookieOptions());
  res.cookie(env.cookie.refreshName, refreshToken, getRefreshCookieOptions());
}

export function clearAuthCookies(res) {
  const { maxAge: _accessMaxAge, ...accessClearOpts } = getAccessCookieOptions();
  const { maxAge: _refreshMaxAge, ...refreshClearOpts } = getRefreshCookieOptions();
  res.clearCookie(env.cookie.accessName, accessClearOpts);
  res.clearCookie(env.cookie.refreshName, refreshClearOpts);
}

export default {
  parseDurationToMs,
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getRefreshTokenExpiresAt,
  getAccessCookieOptions,
  getRefreshCookieOptions,
  setAuthCookies,
  clearAuthCookies,
};
