import { ALL_ADMIN_ROLES, ADMIN_STATUSES } from '../config/constants.js';
import AppError from '../utils/appError.js';

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

  return function rbacGuard(req, _res, next) {
    if (!req.admin || !req.admin.id) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
    }

    if (req.admin.status && req.admin.status !== ADMIN_STATUSES.ACTIVE) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
    }

    if (!flatRoles.includes(req.admin.role)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Insufficient role permissions for this operation.',
      );
    }

    next();
  };
}

export default requireRoles;
