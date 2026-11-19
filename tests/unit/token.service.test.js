import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import tokenService from '../../services/token.service.js';
import AppError from '../../utils/appError.js';

const sampleAdmin = {
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  email: 'superadmin@japaika.com',
  role: 'super_admin',
};

test('token.service — signAccessToken and verifyAccessToken enforce admin claims', () => {
  const token = tokenService.signAccessToken(sampleAdmin);
  const payload = tokenService.verifyAccessToken(token);

  assert.equal(payload.sub, sampleAdmin.id);
  assert.equal(payload.email, sampleAdmin.email);
  assert.equal(payload.role, sampleAdmin.role);
  assert.equal(payload.subType, 'admin');
  assert.equal(payload.tokenType, 'access');
  assert.equal(payload.iss, 'japaika-admin-backend');
  assert.equal(payload.aud, 'japaika-admin');
});

test('token.service — signRefreshToken and verifyRefreshToken enforce refresh claims', () => {
  const jti = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const refreshToken = tokenService.signRefreshToken({
    adminId: sampleAdmin.id,
    jti,
    familyId,
  });

  const payload = tokenService.verifyRefreshToken(refreshToken);
  assert.equal(payload.sub, sampleAdmin.id);
  assert.equal(payload.jti, jti);
  assert.equal(payload.familyId, familyId);
  assert.equal(payload.subType, 'admin');
  assert.equal(payload.tokenType, 'refresh');
});

test('token.service — rejects customer tokens and cross-type tokens', () => {
  const fakeCustomerToken = jwt.sign(
    {
      sub: sampleAdmin.id,
      email: 'customer@example.com',
      subType: 'customer',
      tokenType: 'access',
    },
    env.jwt.accessSecret,
    {
      issuer: 'japaika-user-backend',
      audience: 'japaika-user',
      expiresIn: '15m',
    },
  );

  assert.throws(
    () => tokenService.verifyAccessToken(fakeCustomerToken),
    (err) => err instanceof AppError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
  );

  const subTypeMismatchToken = jwt.sign(
    {
      sub: sampleAdmin.id,
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

  assert.throws(
    () => tokenService.verifyAccessToken(subTypeMismatchToken),
    (err) => err instanceof AppError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
  );

  const refreshToken = tokenService.signRefreshToken({
    adminId: sampleAdmin.id,
    jti: crypto.randomUUID(),
    familyId: crypto.randomUUID(),
  });

  assert.throws(
    () => tokenService.verifyAccessToken(refreshToken),
    (err) => err instanceof AppError && err.statusCode === 401,
  );
});

test('token.service — hashRefreshToken produces deterministic 64-char SHA-256 hex digest', () => {
  const digest1 = tokenService.hashRefreshToken('sample-refresh-jwt-value');
  const digest2 = tokenService.hashRefreshToken('sample-refresh-jwt-value');

  assert.equal(digest1.length, 64);
  assert.equal(digest1, digest2);
  assert.notEqual(digest1, tokenService.hashRefreshToken('different-refresh-jwt-value'));
});

test('token.service — parseDurationToMs parses s, m, h, d units accurately', () => {
  assert.equal(tokenService.parseDurationToMs('30s'), 30 * 1000);
  assert.equal(tokenService.parseDurationToMs('15m'), 15 * 60 * 1000);
  assert.equal(tokenService.parseDurationToMs('2h'), 2 * 60 * 60 * 1000);
  assert.equal(tokenService.parseDurationToMs('7d'), 7 * 24 * 60 * 60 * 1000);
});
