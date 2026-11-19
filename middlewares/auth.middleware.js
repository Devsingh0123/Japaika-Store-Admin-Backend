import env from '../config/env.js';
import { ADMIN_STATUSES } from '../config/constants.js';
import defaultModels from '../models/index.js';
import defaultTokenService from '../services/token.service.js';
import { sanitizeAdmin } from '../services/auth.service.js';
import AppError from '../utils/appError.js';

export function createAuthenticateAdmin({
  Admin = defaultModels.Admin,
  tokenService = defaultTokenService,
} = {}) {
  return async function authenticateAdmin(req, _res, next) {
    const rawAccessToken = req.cookies?.[env.cookie.accessName];
    if (!rawAccessToken) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
    }

    const payload = tokenService.verifyAccessToken(rawAccessToken);
    const admin = await Admin.findByPk(payload.sub);

    if (!admin) {
      throw new AppError(401, 'UNAUTHORIZED', 'Admin account not found.');
    }

    if (admin.status !== ADMIN_STATUSES.ACTIVE) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
    }

    req.admin = sanitizeAdmin(admin);
    next();
  };
}

export const authenticateAdmin = createAuthenticateAdmin();
export default authenticateAdmin;
