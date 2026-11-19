import env from '../config/env.js';
import defaultAuthService from '../services/auth.service.js';
import defaultTokenService from '../services/token.service.js';
import { sendSuccess } from '../utils/response.js';

export function createAuthController({
  authService = defaultAuthService,
  tokenService = defaultTokenService,
} = {}) {
  async function login(req, res) {
    const { email, password } = req.body;
    const result = await authService.login({
      email,
      password,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    tokenService.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });

    return sendSuccess(res, {
      statusCode: 200,
      message: 'Authentication successful.',
      data: {
        admin: result.admin,
      },
    });
  }

  async function refresh(req, res) {
    const rawRefreshToken = req.cookies?.[env.cookie.refreshName];

    try {
      const result = await authService.refreshSession({
        rawRefreshToken,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      tokenService.setAuthCookies(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: 'Session refreshed.',
        data: {
          admin: result.admin,
        },
      });
    } catch (err) {
      tokenService.clearAuthCookies(res);
      throw err;
    }
  }

  async function logout(req, res) {
    const rawRefreshToken = req.cookies?.[env.cookie.refreshName];
    await authService.logout({ rawRefreshToken });
    tokenService.clearAuthCookies(res);

    return sendSuccess(res, {
      statusCode: 200,
      message: 'Logged out successfully.',
      data: null,
    });
  }

  async function logoutAll(req, res) {
    await authService.logoutAll({ adminId: req.admin.id });
    tokenService.clearAuthCookies(res);

    return sendSuccess(res, {
      statusCode: 200,
      message: 'Logged out from all devices.',
      data: null,
    });
  }

  async function getCurrentAdmin(req, res) {
    const result = await authService.getCurrentAdmin({ adminId: req.admin.id });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Authenticated admin retrieved.',
      data: {
        admin: result.admin,
      },
    });
  }

  return {
    login,
    refresh,
    logout,
    logoutAll,
    getCurrentAdmin,
  };
}

const authController = createAuthController();
export default authController;
