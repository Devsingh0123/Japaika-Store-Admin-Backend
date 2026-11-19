import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../../config/env.js';
import {
  parseDurationToMs,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../services/token.service.js';

describe('token.service', () => {
  it('parses duration strings into milliseconds', () => {
    assert.equal(parseDurationToMs('15m', 0), 15 * 60 * 1000);
    assert.equal(parseDurationToMs('7d', 0), 7 * 24 * 60 * 60 * 1000);
    assert.equal(parseDurationToMs('60s', 0), 60 * 1000);
    assert.equal(parseDurationToMs('2h', 0), 2 * 60 * 60 * 1000);
    assert.equal(parseDurationToMs('invalid', 1234), 1234);
  });

  it('signs and verifies admin access tokens with strict claims', () => {
    const admin = {
      id: crypto.randomUUID(),
      email: 'superadmin@japaika.com',
      role: 'super_admin',
    };
    const payload = verifyAccessToken(signAccessToken(admin));

    assert.equal(payload.sub, admin.id);
    assert.equal(payload.email, admin.email);
    assert.equal(payload.role, admin.role);
    assert.equal(payload.subType, 'admin');
    assert.equal(payload.tokenType, 'access');
    assert.equal(payload.iss, 'japaika-admin-backend');
    assert.equal(payload.aud, 'japaika-admin');
  });

  it('rejects refresh tokens and customer tokens when verifying admin access tokens', () => {
    const adminId = crypto.randomUUID();
    const refreshToken = signRefreshToken({
      adminId,
      tokenId: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
    });

    assert.throws(() => verifyAccessToken(refreshToken), { code: 'UNAUTHORIZED' });

    const customerToken = jwt.sign(
      { sub: adminId, subType: 'customer', tokenType: 'access' },
      'different_customer_secret_at_least_32_characters',
      { issuer: 'japaika-user-backend', audience: 'japaika-user', expiresIn: '15m' }
    );
    assert.throws(() => verifyAccessToken(customerToken), { code: 'UNAUTHORIZED' });
  });

  it('signs and verifies admin refresh tokens and rejects access tokens', () => {
    const adminId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const familyId = crypto.randomUUID();

    const payload = verifyRefreshToken(signRefreshToken({ adminId, tokenId, familyId }));
    assert.equal(payload.sub, adminId);
    assert.equal(payload.jti, tokenId);
    assert.equal(payload.familyId, familyId);
    assert.equal(payload.subType, 'admin');
    assert.equal(payload.tokenType, 'refresh');

    const accessToken = signAccessToken({
      id: adminId,
      email: 'superadmin@japaika.com',
      role: 'super_admin',
    });
    assert.throws(() => verifyRefreshToken(accessToken), { code: 'INVALID_REFRESH_TOKEN' });
  });

  it('hashes raw tokens deterministically with SHA-256', () => {
    const h1 = hashToken('sample-admin-refresh-token');
    assert.equal(h1.length, 64);
    assert.equal(h1, hashToken('sample-admin-refresh-token'));
    assert.notEqual(h1, hashToken('different-admin-refresh-token'));
  });
});

describe('config/env production safety checks', () => {
  it('rejects identical access and refresh secrets', () => {
    const sameSecret = 'a_shared_secret_value_that_is_over_32_chars_long';
    assert.throws(
      () => loadEnv({ ADMIN_JWT_ACCESS_SECRET: sameSecret, ADMIN_JWT_REFRESH_SECRET: sameSecret }),
      /must differ/
    );
  });

  it('rejects default/placeholder secrets in production', () => {
    assert.throws(
      () => loadEnv({ NODE_ENV: 'production' }),
      /Production requires custom ADMIN_JWT_ACCESS_SECRET/
    );
  });
});
