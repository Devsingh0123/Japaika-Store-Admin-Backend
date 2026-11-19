import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ROLES } from '../../config/constants.js';
import { requireRoles } from '../../middlewares/rbac.middleware.js';
import AppError from '../../utils/appError.js';

test('rbac.middleware — throws configuration error on empty or unknown roles', () => {
  assert.throws(() => requireRoles(), /at least one valid admin role/);
  assert.throws(() => requireRoles('invalid_role_name'), /Unknown admin role/);
});

test('rbac.middleware — rejects unauthenticated requests with 401 UNAUTHORIZED', () => {
  const guard = requireRoles(ADMIN_ROLES.SUPER_ADMIN);
  assert.throws(
    () => guard({}, {}, () => {}),
    (err) => err instanceof AppError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
  );
});

test('rbac.middleware — rejects disallowed role with 403 FORBIDDEN', () => {
  const guard = requireRoles(ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.OPERATIONS_MANAGER);
  const req = {
    admin: {
      id: '110e8400-e29b-41d4-a716-446655440000',
      role: ADMIN_ROLES.SUPPORT_MODERATOR,
      status: 'active',
    },
  };

  assert.throws(
    () => guard(req, {}, () => {}),
    (err) => err instanceof AppError && err.statusCode === 403 && err.code === 'FORBIDDEN',
  );
});

test('rbac.middleware — allows permitted role to proceed', () => {
  const guard = requireRoles(ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.CATALOG_MANAGER);
  const req = {
    admin: {
      id: '110e8400-e29b-41d4-a716-446655440000',
      role: ADMIN_ROLES.CATALOG_MANAGER,
      status: 'active',
    },
  };

  let calledNext = false;
  guard(req, {}, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
});
