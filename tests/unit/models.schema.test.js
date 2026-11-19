import test from 'node:test';
import assert from 'node:assert/strict';
import env, { parseEnv } from '../../config/env.js';
import { Admin, AdminRefreshToken } from '../../models/index.js';
import { ALL_ADMIN_ROLES, ALL_ADMIN_STATUSES } from '../../config/constants.js';

test('config/env — uses shared local DB_NAME (japaika_ecommerce) for test/local environment without requiring a separate test DB', () => {
  assert.equal(env.db.name, 'japaika_ecommerce');

  const testParsed = parseEnv({
    NODE_ENV: 'test',
    DB_NAME: 'japaika_ecommerce',
  });
  assert.equal(testParsed.DB_NAME, 'japaika_ecommerce');
});

test('models/admin & adminRefreshToken — match shared database schema and migrations', () => {
  assert.equal(Admin.getTableName(), 'admins');
  assert.equal(Admin.options.paranoid, true);
  assert.equal(Admin.options.underscored, true);

  const adminFields = Object.values(Admin.rawAttributes).map((attr) => attr.field);
  assert.deepEqual(adminFields, [
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
  ]);
  assert.deepEqual(Admin.rawAttributes.role.values, [...ALL_ADMIN_ROLES]);
  assert.deepEqual(Admin.rawAttributes.status.values, [...ALL_ADMIN_STATUSES]);

  assert.equal(AdminRefreshToken.getTableName(), 'admin_refresh_tokens');
  assert.equal(AdminRefreshToken.options.updatedAt, false);
  const tokenFields = Object.values(AdminRefreshToken.rawAttributes).map((attr) => attr.field);
  assert.deepEqual(tokenFields, [
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
  ]);
});
