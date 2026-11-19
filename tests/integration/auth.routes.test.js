import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../app.js';
import env from '../../config/env.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../../models/index.js';
import {
  hashPassword,
  ensureInitialSuperAdmin,
} from '../../services/auth.service.js';
import requireAdminAuth, { requireRoles } from '../../middlewares/auth.middleware.js';
import { sendSuccess } from '../../utils/http.js';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mount a protected RBAC test route on app before 404/error handlers?
// Instead of mutating app's router stack after 404 handler, we can test RBAC middleware via a dedicated express router or direct route before 404, or test /api/v1/auth/* via supertest(app) and RBAC route on a tiny express wrapper.
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from '../../middlewares/error.middleware.js';

const rbacTestApp = express();
rbacTestApp.use(cookieParser());
rbacTestApp.get(
  '/api/v1/test-rbac/super-only',
  requireAdminAuth,
  requireRoles(ADMIN_ROLES.SUPER_ADMIN),
  (req, res) => sendSuccess(res, { message: 'Super admin access granted', data: { role: req.admin.role } })
);
rbacTestApp.use(errorHandler);

function extractCookies(setCookieHeaders = []) {
  const cookies = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const eqIndex = pair.indexOf('=');
    cookies[pair.slice(0, eqIndex).trim()] = {
      value: pair.slice(eqIndex + 1).trim(),
      raw: header,
    };
  }
  return cookies;
}

describe('Admin Auth & RBAC API integration tests (/api/v1)', () => {
  const testEmails = new Set();

  const makeTestEmail = (label) => {
    const email = `test.${label}.${crypto.randomUUID()}@japaika-admin-test.local`;
    testEmails.add(email);
    return email;
  };

  async function createTestAdmin({
    label = 'admin',
    password = 'AdminLoginPass123!',
    role = ADMIN_ROLES.SUPER_ADMIN,
    status = ADMIN_STATUSES.ACTIVE,
    fullName = 'Test Admin',
  } = {}) {
    const email = makeTestEmail(label);
    const passwordHash = await hashPassword(password, 10);
    const admin = await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash,
      fullName,
      role,
      status,
    });
    return { admin, email, password };
  }

  beforeEach(() => {
    process.env.DISABLE_RATE_LIMIT = 'true';
  });

  afterEach(async () => {
    delete process.env.DISABLE_RATE_LIMIT;

    for (const email of testEmails) {
      const admin = await Admin.findOne({ where: { email }, paranoid: false });
      if (admin) {
        await AdminRefreshToken.destroy({ where: { adminId: admin.id } });
        await Admin.destroy({ where: { id: admin.id }, force: true });
      }
    }
    testEmails.clear();
  });

  after(async () => {
    await sequelize.close();
  });

  describe('GET /api/v1/health', () => {
    it('returns 200 when database is healthy and 503 when unavailable', async () => {
      const okRes = await request(app).get('/api/v1/health');
      assert.equal(okRes.status, 200);
      assert.equal(okRes.body.success, true);
      assert.equal(okRes.body.data.service, 'admin-backend');
      assert.equal(okRes.body.data.database, 'connected');

      const authStub = mock.method(sequelize, 'authenticate', async () => {
        throw new Error('DB down');
      });
      try {
        const errRes = await request(app).get('/api/v1/health');
        assert.equal(errRes.status, 503);
        assert.equal(errRes.body.error.code, 'SERVICE_UNAVAILABLE');
      } finally {
        authStub.mock.restore();
      }
    });
  });

  describe('Initial Super-Admin Bootstrap & No Public Registration', () => {
    it('provisions initial super_admin idempotently and exposes no public registration route', async () => {
      const email1 = makeTestEmail('boot1');
      const email2 = makeTestEmail('boot2');

      const first = await ensureInitialSuperAdmin({
        email: `  ${email1.toUpperCase()} `,
        password: 'SuperAdminPassword123!',
        fullName: 'Meera Super Admin',
      });

      if (first.created) {
        assert.equal(first.admin.email, email1);
        assert.equal(first.admin.role, ADMIN_ROLES.SUPER_ADMIN);
        assert.match(first.admin.id, UUID_V4_REGEX);
      }

      const second = await ensureInitialSuperAdmin({
        email: email2,
        password: 'AnotherPassword123!',
        fullName: 'Duplicate Super Admin',
      });
      assert.equal(second.created, false);
      assert.equal(second.reason, 'SUPER_ADMIN_ALREADY_EXISTS');

      const regRes = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: email2, password: 'AnotherPassword123!' });
      assert.equal(regRes.status, 404);
      assert.equal(regRes.body.error.code, 'NOT_FOUND');
    });
  });

  describe('POST /api/v1/auth/login & GET /api/v1/auth/me', () => {
    it('validates input, rejects invalid credentials or suspended admin, and logs in active admin with HttpOnly cookies', async () => {
      const { admin, email, password } = await createTestAdmin({ label: 'login' });

      const badInput = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: '' });
      assert.equal(badInput.status, 400);
      assert.equal(badInput.body.error.code, 'VALIDATION_ERROR');

      const unknownEmail = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: makeTestEmail('unknown'), password });
      assert.equal(unknownEmail.status, 401);
      assert.equal(unknownEmail.body.error.code, 'INVALID_CREDENTIALS');

      const wrongPass = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPassword999!' });
      assert.equal(wrongPass.status, 401);
      assert.equal(wrongPass.body.error.code, 'INVALID_CREDENTIALS');

      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: `  ${email.toUpperCase()}  `, password });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.data.admin.id, admin.id);
      assert.equal(loginRes.body.data.admin.email, email);
      assert.equal('passwordHash' in loginRes.body.data.admin, false);
      assert.ok(loginRes.body.data.admin.lastLoginAt);

      const cookies = extractCookies(loginRes.headers['set-cookie']);
      assert.match(cookies.japaika_admin_access.raw, /HttpOnly/i);
      assert.match(cookies.japaika_admin_access.raw, /SameSite=Lax/i);
      assert.match(cookies.japaika_admin_refresh.raw, /Path=\/api\/v1\/auth/i);

      // /me succeeds with valid admin cookie
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', `japaika_admin_access=${cookies.japaika_admin_access.value}`);
      assert.equal(meRes.status, 200);
      assert.equal(meRes.body.data.admin.id, admin.id);

      // Customer cookie name or customer subType token rejected (strict isolation)
      const customerCookieRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', `japaika_user_access=${cookies.japaika_admin_access.value}`);
      assert.equal(customerCookieRes.status, 401);

      const forgedCustomerJwt = jwt.sign(
        { sub: admin.id, email, subType: 'customer', tokenType: 'access' },
        env.jwt.accessSecret,
        { issuer: env.jwt.issuer, audience: env.jwt.audience, expiresIn: '15m' }
      );
      const forgedRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', `japaika_admin_access=${forgedCustomerJwt}`);
      assert.equal(forgedRes.status, 401);

      // Suspended admin blocked with 403 on login and /me
      await Admin.update({ status: ADMIN_STATUSES.SUSPENDED }, { where: { id: admin.id } });

      const suspendedLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password });
      assert.equal(suspendedLogin.status, 403);
      assert.equal(suspendedLogin.body.error.code, 'ACCOUNT_SUSPENDED');

      const suspendedMe = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', `japaika_admin_access=${cookies.japaika_admin_access.value}`);
      assert.equal(suspendedMe.status, 403);
      assert.equal(suspendedMe.body.error.code, 'ACCOUNT_SUSPENDED');
    });
  });

  describe('POST /api/v1/auth/refresh, /logout, and /logout-all', () => {
    it('rotates refresh tokens and revokes entire family on token reuse', async () => {
      const { email, password } = await createTestAdmin({ label: 'rotate' });
      const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
      const token1 = extractCookies(loginRes.headers['set-cookie']).japaika_admin_refresh.value;

      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `japaika_admin_refresh=${token1}`);
      assert.equal(refreshRes.status, 200);
      const token2 = extractCookies(refreshRes.headers['set-cookie']).japaika_admin_refresh.value;
      assert.notEqual(token2, token1);

      // Replaying token1 triggers reuse detection and invalidates token2 in the same family
      const reuseRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `japaika_admin_refresh=${token1}`);
      assert.equal(reuseRes.status, 401);
      assert.equal(reuseRes.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');

      const afterCompromise = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `japaika_admin_refresh=${token2}`);
      assert.equal(afterCompromise.status, 401);
    });

    it('revokes single session on /logout and all sessions on /logout-all', async () => {
      const { email, password } = await createTestAdmin({ label: 'logout' });

      const login1 = await request(app).post('/api/v1/auth/login').send({ email, password });
      const cookies1 = extractCookies(login1.headers['set-cookie']);

      const login2 = await request(app).post('/api/v1/auth/login').send({ email, password });
      const cookies2 = extractCookies(login2.headers['set-cookie']);

      const logout1 = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `japaika_admin_refresh=${cookies1.japaika_admin_refresh.value}`);
      assert.equal(logout1.status, 200);

      const refresh1 = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `japaika_admin_refresh=${cookies1.japaika_admin_refresh.value}`);
      assert.equal(refresh1.status, 401);

      const logoutAll = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Cookie', `japaika_admin_access=${cookies2.japaika_admin_access.value}`);
      assert.equal(logoutAll.status, 200);

      const refresh2 = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `japaika_admin_refresh=${cookies2.japaika_admin_refresh.value}`);
      assert.equal(refresh2.status, 401);
    });
  });

  describe('RBAC & Rate limiting', () => {
    it('enforces RBAC roles on protected routes and rate-limits repeated login attempts', async () => {
      const superData = await createTestAdmin({
        label: 'rbac-super',
        role: ADMIN_ROLES.SUPER_ADMIN,
      });
      const modData = await createTestAdmin({
        label: 'rbac-mod',
        role: ADMIN_ROLES.SUPPORT_MODERATOR,
      });

      const superLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: superData.email, password: superData.password });
      const superAccess = extractCookies(superLogin.headers['set-cookie']).japaika_admin_access.value;

      const modLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: modData.email, password: modData.password });
      const modAccess = extractCookies(modLogin.headers['set-cookie']).japaika_admin_access.value;

      const superRes = await request(rbacTestApp)
        .get('/api/v1/test-rbac/super-only')
        .set('Cookie', `japaika_admin_access=${superAccess}`);
      assert.equal(superRes.status, 200);

      const modRes = await request(rbacTestApp)
        .get('/api/v1/test-rbac/super-only')
        .set('Cookie', `japaika_admin_access=${modAccess}`);
      assert.equal(modRes.status, 403);
      assert.equal(modRes.body.error.code, 'FORBIDDEN');

      // Rate limiting check (5 attempts per account)
      process.env.DISABLE_RATE_LIMIT = 'false';
      const rlEmail = makeTestEmail('ratelimit');
      for (let i = 0; i < 5; i += 1) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: rlEmail, password: 'WrongPassword123!' });
        assert.equal(res.status, 401);
      }
      const sixth = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: rlEmail, password: 'WrongPassword123!' });
      assert.equal(sixth.status, 429);
      assert.equal(sixth.body.error.code, 'RATE_LIMIT_EXCEEDED');
    });
  });
});
