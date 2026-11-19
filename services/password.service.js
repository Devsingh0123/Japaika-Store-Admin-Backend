import bcrypt from 'bcryptjs';
import env from '../config/env.js';
import AppError from '../utils/appError.js';

// Precomputed dummy hash used when an admin email does not exist to prevent timing-based user enumeration.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('japaika_dummy_password_timing_guard_9x7Q!', 10);

const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,128}$/;

export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || !PASSWORD_COMPLEXITY_REGEX.test(password)) {
    throw new AppError(
      400,
      'WEAK_PASSWORD',
      'Password must be 8 to 128 characters long and include at least one uppercase letter, one lowercase letter, and one number.',
    );
  }
  return true;
}

export async function hashPassword(plainPassword, saltRounds = env.bcrypt.saltRounds) {
  validatePasswordStrength(plainPassword);
  return bcrypt.hash(plainPassword, saltRounds);
}

export async function verifyPassword(plainPassword, passwordHash) {
  if (typeof plainPassword !== 'string' || typeof passwordHash !== 'string' || !passwordHash) {
    return false;
  }
  return bcrypt.compare(plainPassword, passwordHash);
}

export async function verifyPasswordTimingSafe(plainPassword, passwordHash) {
  const candidate = typeof plainPassword === 'string' ? plainPassword : '';
  if (typeof passwordHash !== 'string' || !passwordHash) {
    await bcrypt.compare(candidate, DUMMY_PASSWORD_HASH);
    return false;
  }
  return bcrypt.compare(candidate, passwordHash);
}

export default {
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  verifyPasswordTimingSafe,
};
