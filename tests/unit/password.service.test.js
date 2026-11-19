import test from 'node:test';
import assert from 'node:assert/strict';
import passwordService from '../../services/password.service.js';
import AppError from '../../utils/appError.js';

test('password.service — validatePasswordStrength accepts strong passwords and rejects weak ones', () => {
  assert.equal(passwordService.validatePasswordStrength('StrongPass123!'), true);

  assert.throws(
    () => passwordService.validatePasswordStrength('short1A'),
    (err) => err instanceof AppError && err.statusCode === 400 && err.code === 'WEAK_PASSWORD',
  );

  assert.throws(
    () => passwordService.validatePasswordStrength('alllowercase123'),
    (err) => err instanceof AppError && err.code === 'WEAK_PASSWORD',
  );

  assert.throws(
    () => passwordService.validatePasswordStrength('ALLUPPERCASE123'),
    (err) => err instanceof AppError && err.code === 'WEAK_PASSWORD',
  );

  assert.throws(
    () => passwordService.validatePasswordStrength('NoNumbersHere!'),
    (err) => err instanceof AppError && err.code === 'WEAK_PASSWORD',
  );
});

test('password.service — hashPassword and verifyPassword work with bcryptjs', async () => {
  const plain = 'AdminSecret2026!';
  const hash = await passwordService.hashPassword(plain, 10);

  assert.notEqual(hash, plain);
  assert.equal(hash.startsWith('$2'), true);
  assert.equal(await passwordService.verifyPassword(plain, hash), true);
  assert.equal(await passwordService.verifyPassword('WrongSecret2026!', hash), false);
});

test('password.service — verifyPasswordTimingSafe returns false when hash is missing', async () => {
  const resultNull = await passwordService.verifyPasswordTimingSafe('SomePassword123', null);
  assert.equal(resultNull, false);

  const hash = await passwordService.hashPassword('ValidAdminPass99', 10);
  assert.equal(await passwordService.verifyPasswordTimingSafe('ValidAdminPass99', hash), true);
  assert.equal(await passwordService.verifyPasswordTimingSafe('InvalidAdminPass99', hash), false);
});
