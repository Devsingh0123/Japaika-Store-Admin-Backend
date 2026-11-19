import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Admin,
  AdminRefreshToken,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ALL_ADMIN_STATUSES,
} from '../../models/index.js';
import {
  normalizeEmail,
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  verifyPasswordTimingSafe,
} from '../../services/auth.service.js';
import { requireRoles } from '../../middlewares/auth.middleware.js';

describe('Admin password & email helpers', () => {
  it('normalizes email by trimming whitespace and lowercasing', () => {
    assert.equal(normalizeEmail('  Super.Admin@Japaika.COM  '), 'super.admin@japaika.com');
  });

  it('validates password strength and rejects weak passwords', () => {
    assert.equal(validatePasswordStrength('StrongPass123!'), true);
    assert.throws(() => validatePasswordStrength('short1A'), { code: 'WEAK_PASSWORD' });
    assert.throws(() => validatePasswordStrength('alllowercase123'), { code: 'WEAK_PASSWORD' });
    assert.throws(() => validatePasswordStrength('ALLUPPERCASE123'), { code: 'WEAK_PASSWORD' });
    assert.throws(() => validatePasswordStrength('NoNumbersHere!'), { code: 'WEAK_PASSWORD' });
  });

  it('hashes and verifies passwords with bcryptjs, including timing-safe missing hash check', async () => {
    const hash = await hashPassword('AdminSecret2026!', 10);
    assert.equal(hash.startsWith('$2'), true);
    assert.equal(await verifyPassword('AdminSecret2026!', hash), true);
    assert.equal(await verifyPassword('WrongSecret2026!', hash), false);
    assert.equal(await verifyPasswordTimingSafe('SomePassword123!', null), false);
    assert.equal(await verifyPasswordTimingSafe('AdminSecret2026!', hash), true);
  });
});

describe('RBAC requireRoles middleware', () => {
  it('throws configuration error on empty or unknown roles', () => {
    assert.throws(() => requireRoles(), /at least one valid admin role/);
    assert.throws(() => requireRoles('unknown_role'), /Unknown admin role/);
  });

  it('enforces authentication (401), active status (403), and allowed roles (403 / next)', () => {
    const guard = requireRoles(ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.CATALOG_MANAGER);

    let errUnauth;
    guard({}, {}, (err) => {
      errUnauth = err;
    });
    assert.equal(errUnauth?.statusCode, 401);
    assert.equal(errUnauth?.code, 'UNAUTHORIZED');

    let errSuspended;
    guard(
      { admin: { id: 'a1', role: ADMIN_ROLES.SUPER_ADMIN, status: 'suspended' } },
      {},
      (err) => {
        errSuspended = err;
      }
    );
    assert.equal(errSuspended?.statusCode, 403);
    assert.equal(errSuspended?.code, 'ACCOUNT_SUSPENDED');

    let errForbidden;
    guard(
      { admin: { id: 'a1', role: ADMIN_ROLES.SUPPORT_MODERATOR, status: 'active' } },
      {},
      (err) => {
        errForbidden = err;
      }
    );
    assert.equal(errForbidden?.statusCode, 403);
    assert.equal(errForbidden?.code, 'FORBIDDEN');

    let allowed = false;
    guard(
      { admin: { id: 'a1', role: ADMIN_ROLES.CATALOG_MANAGER, status: 'active' } },
      {},
      (err) => {
        if (!err) allowed = true;
      }
    );
    assert.equal(allowed, true);
  });
});

describe('Sequelize models alignment with shared DATABASE_SCHEMA.md', () => {
  it('defines admins and admin_refresh_tokens with exact snake_case columns and enums', () => {
    assert.equal(Admin.getTableName(), 'admins');
    assert.equal(Admin.options.paranoid, true);
    assert.deepEqual(
      Object.values(Admin.rawAttributes).map((a) => a.field),
      [
        'id',
        'email',
        'password_hash',
        'full_name',
        'role',
        'status',
        'last_login_at',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );
    assert.deepEqual(Admin.rawAttributes.role.values, [...ALL_ADMIN_ROLES]);
    assert.deepEqual(Admin.rawAttributes.status.values, [...ALL_ADMIN_STATUSES]);

    assert.equal(AdminRefreshToken.getTableName(), 'admin_refresh_tokens');
    assert.equal(AdminRefreshToken.options.updatedAt, false);
    assert.deepEqual(
      Object.values(AdminRefreshToken.rawAttributes).map((a) => a.field),
      [
        'id',
        'admin_id',
        'token_hash',
        'family_id',
        'expires_at',
        'revoked_at',
        'replaced_by_token_id',
        'ip_address',
        'user_agent',
        'created_at',
      ]
    );
  });
});
