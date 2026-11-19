import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Duplex } from 'node:stream';
import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import { ADMIN_ROLES, ADMIN_STATUSES } from '../../config/constants.js';
import passwordService from '../../services/password.service.js';
import tokenService from '../../services/token.service.js';
import { createAuthService } from '../../services/auth.service.js';
import { createBootstrapService } from '../../services/bootstrap.service.js';
import { createAuthenticateAdmin } from '../../middlewares/auth.middleware.js';
import { requireRoles } from '../../middlewares/rbac.middleware.js';
import { createHealthController } from '../../controllers/health.controller.js';
import { createAuthController } from '../../controllers/auth.controller.js';
import { createAuthRouter } from '../../routes/auth.routes.js';
import { createApiRouter } from '../../routes/index.js';
import { createApp } from '../../app.js';
import { sendSuccess } from '../../utils/response.js';

class MockSocket extends Duplex {
  constructor() {
    super();
    this.remoteAddress = '127.0.0.1';
    this.encrypted = false;
  }

  _read() {}

  _write(_chunk, _encoding, callback) {
    callback();
  }
}

async function dispatchRequest(app, { method = 'GET', path = '/', headers = {}, cookies = [], body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new MockSocket();
    const req = new http.IncomingMessage(socket);
    req.method = method.toUpperCase();
    req.url = path;

    const normalizedHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    if (cookies.length > 0) {
      normalizedHeaders.cookie = cookies.join('; ');
    }

    let payloadBuffer = null;
    if (body !== undefined) {
      const rawString = typeof body === 'string' ? body : JSON.stringify(body);
      payloadBuffer = Buffer.from(rawString, 'utf8');
      if (!normalizedHeaders['content-type']) {
        normalizedHeaders['content-type'] = 'application/json';
      }
      normalizedHeaders['content-length'] = String(payloadBuffer.length);
    }

    req.headers = normalizedHeaders;

    const res = new http.ServerResponse(req);
    const chunks = [];

    res.write = function writeOverride(chunk, encoding, cb) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof cb === 'function') cb();
      return true;
    };

    res.end = function endOverride(chunk, encoding, cb) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody = rawBody;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // Leave as string if not JSON
      }

      const rawHeaders = res.getHeaders();
      const setCookieHeader = rawHeaders['set-cookie'];
      const setCookieArray = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [String(setCookieHeader)]
          : [];

      if (typeof cb === 'function') cb();
      resolve({
        status: res.statusCode,
        headers: {
          ...rawHeaders,
          'set-cookie': setCookieArray,
        },
        body: parsedBody,
      });
      return this;
    };

    try {
      app.handle(req, res, reject);
      if (payloadBuffer) {
        req.push(payloadBuffer);
      }
      req.push(null);
    } catch (err) {
      reject(err);
    }
  });
}

function createInMemoryHarness() {
  const admins = new Map();
  const refreshTokens = new Map();
  let dbHealthy = true;

  function wrapAdminRecord(record) {
    return {
      ...record,
      get({ plain } = {}) {
        return plain ? { ...record } : this;
      },
      async update(patch) {
        Object.assign(record, patch, { updatedAt: new Date() });
        Object.assign(this, record);
        return this;
      },
    };
  }

  function wrapTokenRecord(record) {
    return {
      ...record,
      get({ plain } = {}) {
        return plain ? { ...record } : this;
      },
      async update(patch) {
        Object.assign(record, patch);
        Object.assign(this, record);
        return this;
      },
    };
  }

  const sequelize = {
    async authenticate() {
      if (!dbHealthy) {
        throw new Error('Simulated DB connection error');
      }
    },
    async transaction(callback) {
      return callback({});
    },
  };

  const Admin = {
    async findOne({ where }) {
      for (const record of admins.values()) {
        const matches = Object.entries(where).every(([k, v]) => record[k] === v);
        if (matches) {
          return wrapAdminRecord(record);
        }
      }
      return null;
    },
    async findByPk(id) {
      const record = admins.get(id);
      return record ? wrapAdminRecord(record) : null;
    },
    async create(data) {
      const now = new Date();
      const record = {
        id: data.id || crypto.randomUUID(),
        email: data.email,
        passwordHash: data.passwordHash,
        fullName: data.fullName,
        role: data.role || ADMIN_ROLES.SUPPORT_MODERATOR,
        status: data.status || ADMIN_STATUSES.ACTIVE,
        lastLoginAt: data.lastLoginAt || null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      admins.set(record.id, record);
      return wrapAdminRecord(record);
    },
  };

  const AdminRefreshToken = {
    async create(data) {
      const record = {
        id: data.id || crypto.randomUUID(),
        adminId: data.adminId,
        tokenHash: data.tokenHash,
        familyId: data.familyId,
        expiresAt: data.expiresAt,
        revokedAt: data.revokedAt || null,
        replacedByTokenId: data.replacedByTokenId || null,
        ipAddress: data.ipAddress || null,
        userAgent: data.userAgent || null,
        createdAt: new Date(),
      };
      refreshTokens.set(record.id, record);
      return wrapTokenRecord(record);
    },
    async findOne({ where }) {
      for (const record of refreshTokens.values()) {
        const matches = Object.entries(where).every(([k, v]) => record[k] === v);
        if (matches) {
          return wrapTokenRecord(record);
        }
      }
      return null;
    },
    async update(patch, { where }) {
      let count = 0;
      for (const record of refreshTokens.values()) {
        const matches = Object.entries(where).every(([k, v]) => record[k] === v);
        if (matches) {
          Object.assign(record, patch);
          count += 1;
        }
      }
      return [count];
    },
  };

  const passThroughLimiter = (_req, _res, next) => next();

  const authService = createAuthService({
    sequelize,
    Admin,
    AdminRefreshToken,
    passwordService,
    tokenService,
  });

  const bootstrapService = createBootstrapService({
    sequelize,
    Admin,
    passwordService,
  });

  const authenticateAdmin = createAuthenticateAdmin({
    Admin,
    tokenService,
  });

  const healthController = createHealthController({ sequelize });
  const authController = createAuthController({ authService, tokenService });
  const authRouter = createAuthRouter({
    authController,
    authenticateAdmin,
    loginIpRateLimiter: passThroughLimiter,
    loginAccountRateLimiter: passThroughLimiter,
    refreshRateLimiter: passThroughLimiter,
  });

  const apiRouter = createApiRouter({ healthController, authRouter });

  const app = createApp({
    apiRouter,
    registerExtraRoutes(expressApp) {
      expressApp.get(
        '/api/v1/test-rbac/super-only',
        authenticateAdmin,
        requireRoles(ADMIN_ROLES.SUPER_ADMIN),
        (req, res) =>
          sendSuccess(res, {
            message: 'Super admin access granted',
            data: { role: req.admin.role },
          }),
      );

      expressApp.get(
        '/api/v1/test-rbac/catalog-or-super',
        authenticateAdmin,
        requireRoles(ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.CATALOG_MANAGER),
        (req, res) =>
          sendSuccess(res, {
            message: 'Catalog access granted',
            data: { role: req.admin.role },
          }),
      );
    },
  });

  return {
    app,
    admins,
    refreshTokens,
    Admin,
    AdminRefreshToken,
    bootstrapService,
    setDbHealthy(healthy) {
      dbHealthy = healthy;
    },
  };
}

function extractCookies(setCookieHeaders = []) {
  const cookieMap = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const name = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      cookieMap[name] = value;
    }
  }
  return cookieMap;
}

test('GET /api/v1/health — returns 200 when database is connected and 503 when disconnected', async () => {
  const harness = createInMemoryHarness();

  const okRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/health',
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.success, true);
  assert.equal(okRes.body.data.service, 'admin-backend');
  assert.equal(okRes.body.data.database, 'connected');

  harness.setDbHealthy(false);
  const failRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/health',
  });
  assert.equal(failRes.status, 503);
  assert.equal(failRes.body.success, false);
  assert.equal(failRes.body.error.code, 'SERVICE_UNAVAILABLE');
});

test('Bootstrap & Registration — initial super-admin creation is idempotent and public registration does not exist', async () => {
  const harness = createInMemoryHarness();

  const firstRun = await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'SUPER@JAPAIKA.COM',
    password: 'SuperAdminPassword123!',
    fullName: 'Meera Super Admin',
  });

  assert.equal(firstRun.created, true);
  assert.equal(firstRun.admin.email, 'super@japaika.com');
  assert.equal(firstRun.admin.role, ADMIN_ROLES.SUPER_ADMIN);
  assert.equal(firstRun.admin.status, ADMIN_STATUSES.ACTIVE);
  assert.equal('passwordHash' in firstRun.admin, false);

  const secondRun = await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'another@japaika.com',
    password: 'AnotherPassword123!',
    fullName: 'Second Super Admin',
  });

  assert.equal(secondRun.created, false);
  assert.equal(secondRun.reason, 'SUPER_ADMIN_ALREADY_EXISTS');
  assert.equal(harness.admins.size, 1);

  const regRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/register',
    body: { email: 'hacker@example.com', password: 'Password123!' },
  });
  assert.equal(regRes.status, 404);
  assert.equal(regRes.body.error.code, 'NOT_FOUND');
});

test('POST /api/v1/auth/login — validates input, rejects bad credentials or suspended admin, and logs in active admin', async () => {
  const harness = createInMemoryHarness();

  await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'admin@japaika.com',
    password: 'AdminLoginPass123!',
    fullName: 'Primary Admin',
  });

  // 1. Validation failure
  const invalidRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'not-an-email', password: '' },
  });
  assert.equal(invalidRes.status, 400);
  assert.equal(invalidRes.body.error.code, 'VALIDATION_ERROR');

  // 2. Unknown email
  const unknownRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'nonexistent@japaika.com', password: 'AdminLoginPass123!' },
  });
  assert.equal(unknownRes.status, 401);
  assert.equal(unknownRes.body.error.code, 'INVALID_CREDENTIALS');

  // 3. Wrong password
  const wrongPassRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'admin@japaika.com', password: 'WrongPassword999!' },
  });
  assert.equal(wrongPassRes.status, 401);
  assert.equal(wrongPassRes.body.error.code, 'INVALID_CREDENTIALS');

  // 4. Valid login
  const loginRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: '  ADMIN@JAPAIKA.COM ', password: 'AdminLoginPass123!' },
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.success, true);
  assert.equal(loginRes.body.data.admin.email, 'admin@japaika.com');
  assert.equal(loginRes.body.data.admin.role, ADMIN_ROLES.SUPER_ADMIN);
  assert.equal('passwordHash' in loginRes.body.data.admin, false);
  assert.ok(loginRes.body.data.admin.lastLoginAt);

  const cookies = extractCookies(loginRes.headers['set-cookie']);
  assert.ok(cookies.japaika_admin_access);
  assert.ok(cookies.japaika_admin_refresh);
  assert.equal(harness.refreshTokens.size, 1);

  // 5. Suspended account login blocked with 403
  const [adminRecord] = harness.admins.values();
  adminRecord.status = ADMIN_STATUSES.SUSPENDED;

  const suspendedRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'admin@japaika.com', password: 'AdminLoginPass123!' },
  });
  assert.equal(suspendedRes.status, 403);
  assert.equal(suspendedRes.body.error.code, 'ACCOUNT_SUSPENDED');
});

test('GET /api/v1/auth/me & Customer Auth Isolation — returns current admin and rejects customer tokens', async () => {
  const harness = createInMemoryHarness();

  const { admin } = await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'meera@japaika.com',
    password: 'AdminLoginPass123!',
    fullName: 'Meera Admin',
  });

  const loginRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'meera@japaika.com', password: 'AdminLoginPass123!' },
  });

  const cookies = extractCookies(loginRes.headers['set-cookie']);

  // Valid admin access cookie
  const meRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/auth/me',
    cookies: [`japaika_admin_access=${cookies.japaika_admin_access}`],
  });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.admin.id, admin.id);
  assert.equal(meRes.body.data.admin.email, 'meera@japaika.com');

  // Missing cookie -> 401
  const unauthRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/auth/me',
  });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.body.error.code, 'UNAUTHORIZED');

  // Customer cookie name (japaika_user_access) is ignored -> 401
  const customerCookieRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/auth/me',
    cookies: [`japaika_user_access=${cookies.japaika_admin_access}`],
  });
  assert.equal(customerCookieRes.status, 401);

  // Forged customer subType token placed inside japaika_admin_access cookie -> 401
  const customerPayloadToken = jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      subType: 'customer',
      tokenType: 'access',
    },
    env.jwt.accessSecret,
    {
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      expiresIn: '15m',
    },
  );

  const forgedRes = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/auth/me',
    cookies: [`japaika_admin_access=${customerPayloadToken}`],
  });
  assert.equal(forgedRes.status, 401);
});

test('POST /api/v1/auth/refresh — rotates refresh tokens and detects token reuse by revoking the session family', async () => {
  const harness = createInMemoryHarness();

  await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'ops@japaika.com',
    password: 'AdminLoginPass123!',
    fullName: 'Ops Super Admin',
  });

  const loginRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'ops@japaika.com', password: 'AdminLoginPass123!' },
  });

  const initialCookies = extractCookies(loginRes.headers['set-cookie']);

  // 1. Valid refresh rotates token
  const refreshRes1 = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    cookies: [`japaika_admin_refresh=${initialCookies.japaika_admin_refresh}`],
  });

  assert.equal(refreshRes1.status, 200);
  const rotatedCookies = extractCookies(refreshRes1.headers['set-cookie']);
  assert.ok(rotatedCookies.japaika_admin_access);
  assert.ok(rotatedCookies.japaika_admin_refresh);
  assert.notEqual(rotatedCookies.japaika_admin_refresh, initialCookies.japaika_admin_refresh);

  // 2. Replaying the initial (now-rotated) refresh token triggers reuse detection
  const reuseRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    cookies: [`japaika_admin_refresh=${initialCookies.japaika_admin_refresh}`],
  });

  assert.equal(reuseRes.status, 401);
  assert.equal(reuseRes.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');

  // 3. The rotated token from step 1 is now ALSO revoked because the entire familyId was invalidated
  const postCompromiseRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    cookies: [`japaika_admin_refresh=${rotatedCookies.japaika_admin_refresh}`],
  });

  assert.equal(postCompromiseRes.status, 401);
  assert.equal(postCompromiseRes.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
});

test('POST /api/v1/auth/logout and /logout-all — revokes single session or all sessions and clears cookies', async () => {
  const harness = createInMemoryHarness();

  await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'security@japaika.com',
    password: 'AdminLoginPass123!',
    fullName: 'Security Admin',
  });

  // Create two separate device sessions
  const loginDevice1 = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'security@japaika.com', password: 'AdminLoginPass123!' },
  });
  const cookiesDevice1 = extractCookies(loginDevice1.headers['set-cookie']);

  const loginDevice2 = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'security@japaika.com', password: 'AdminLoginPass123!' },
  });
  const cookiesDevice2 = extractCookies(loginDevice2.headers['set-cookie']);

  // Single logout on Device 1
  const logoutRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/logout',
    cookies: [`japaika_admin_refresh=${cookiesDevice1.japaika_admin_refresh}`],
  });
  assert.equal(logoutRes.status, 200);

  // Device 1 refresh token is now revoked
  const refreshDevice1 = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    cookies: [`japaika_admin_refresh=${cookiesDevice1.japaika_admin_refresh}`],
  });
  assert.equal(refreshDevice1.status, 401);

  // Device 2 can still call logout-all using its access token
  const logoutAllRes = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/logout-all',
    cookies: [`japaika_admin_access=${cookiesDevice2.japaika_admin_access}`],
  });
  assert.equal(logoutAllRes.status, 200);

  // All refresh tokens are now revoked
  for (const tokenRecord of harness.refreshTokens.values()) {
    assert.notEqual(tokenRecord.revokedAt, null);
  }
});

test('RBAC Middleware Integration — enforces role permissions across protected admin routes', async () => {
  const harness = createInMemoryHarness();

  await harness.bootstrapService.ensureInitialSuperAdmin({
    email: 'super@japaika.com',
    password: 'AdminLoginPass123!',
    fullName: 'Super Admin',
  });

  const moderatorPasswordHash = await passwordService.hashPassword('ModeratorPass123!', 10);
  await harness.Admin.create({
    email: 'moderator@japaika.com',
    passwordHash: moderatorPasswordHash,
    fullName: 'Support Moderator',
    role: ADMIN_ROLES.SUPPORT_MODERATOR,
    status: ADMIN_STATUSES.ACTIVE,
  });

  const superLogin = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'super@japaika.com', password: 'AdminLoginPass123!' },
  });
  const superCookies = extractCookies(superLogin.headers['set-cookie']);

  const modLogin = await dispatchRequest(harness.app, {
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { email: 'moderator@japaika.com', password: 'ModeratorPass123!' },
  });
  const modCookies = extractCookies(modLogin.headers['set-cookie']);

  // Super Admin can access super-only route
  const superOk = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/test-rbac/super-only',
    cookies: [`japaika_admin_access=${superCookies.japaika_admin_access}`],
  });
  assert.equal(superOk.status, 200);

  // Support Moderator receives 403 FORBIDDEN on super-only route
  const modForbidden = await dispatchRequest(harness.app, {
    method: 'GET',
    path: '/api/v1/test-rbac/super-only',
    cookies: [`japaika_admin_access=${modCookies.japaika_admin_access}`],
  });
  assert.equal(modForbidden.status, 403);
  assert.equal(modForbidden.body.error.code, 'FORBIDDEN');
});
