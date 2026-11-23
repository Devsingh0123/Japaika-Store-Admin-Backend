import * as authService from '../services/auth.service.js';
import {
  REFRESH_COOKIE_NAME,
  setAuthCookies,
  clearAuthCookies,
} from '../services/token.service.js';
import { sendSuccess } from '../utils/http.js';

export async function login(req, res) {
  const { admin, accessToken, refreshToken } = await authService.login({
    email: req.body.email,
    password: req.body.password,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  setAuthCookies(res, { accessToken, refreshToken });

  return sendSuccess(res, {
    message: 'Authentication successful.',
    data: { admin },
  });
}

export async function refresh(req, res) {
  const rawRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  try {
    const { admin, accessToken, refreshToken } = await authService.refreshSession({
      refreshToken: rawRefreshToken,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    setAuthCookies(res, { accessToken, refreshToken });

    return sendSuccess(res, {
      message: 'Session refreshed.',
      data: { admin },
    });
  } catch (err) {
    if (err?.statusCode === 401 || err?.statusCode === 403) {
      clearAuthCookies(res);
    }
    throw err;
  }
}

export async function logout(req, res) {
  try {
    await authService.logout({ refreshToken: req.cookies?.[REFRESH_COOKIE_NAME] });
  } finally {
    clearAuthCookies(res);
  }

  return sendSuccess(res, { message: 'Logged out successfully.', data: null });
}

export async function logoutAll(req, res) {
  await authService.logoutAll({ adminId: req.admin.id });
  clearAuthCookies(res);

  return sendSuccess(res, { message: 'Logged out from all devices.', data: null });
}

export async function getMe(req, res) {
  const admin = await authService.getCurrentAdmin({ adminId: req.admin.id });

  return sendSuccess(res, {
    message: 'Authenticated admin retrieved.',
    data: { admin },
  });
}
