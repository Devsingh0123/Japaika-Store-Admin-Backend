import { Admin, ALL_ADMIN_ROLES, ADMIN_STATUSES } from '../models/index.js';
import { sanitizeAdmin } from '../services/auth.service.js';
import { ACCESS_COOKIE_NAME, verifyAccessToken } from '../services/token.service.js';
import { AppError } from '../utils/http.js';

export async function requireAdminAuth(req, _res, next) {
  const accessToken = req.cookies?.[ACCESS_COOKIE_NAME];
  if (!accessToken) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
  }

  const payload = verifyAccessToken(accessToken);
  const admin = await Admin.findByPk(payload.sub);

  if (!admin) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
  }

  if (admin.status !== ADMIN_STATUSES.ACTIVE) {
    return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.'));
  }

  req.admin = sanitizeAdmin(admin);
  return next();
}

export function requireRoles(...allowedRoles) {
  const flatRoles = allowedRoles.flat();

  if (flatRoles.length === 0) {
    throw new Error('requireRoles requires at least one valid admin role');
  }

  for (const role of flatRoles) {
    if (!ALL_ADMIN_ROLES.includes(role)) {
      throw new Error(`Unknown admin role in requireRoles: "${role}"`);
    }
  }

  return (req, _res, next) => {
    if (!req.admin || !req.admin.id) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
    }

    if (req.admin.status && req.admin.status !== ADMIN_STATUSES.ACTIVE) {
      return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.'));
    }

    if (!flatRoles.includes(req.admin.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient role permissions for this operation.'));
    }

    return next();
  };
}

export default requireAdminAuth;
