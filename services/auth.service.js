import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../models/index.js';
import {
  getRefreshMaxAgeMs,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from './token.service.js';
import { AppError } from '../utils/http.js';

export const BCRYPT_SALT_ROUNDS = 12;

// Precomputed dummy hash used when an admin email does not exist to prevent timing-based user enumeration.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('japaika_dummy_password_timing_guard_9x7Q!', 10);
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,128}$/;

const bootstrapInputSchema = z.object({
  email: z.string().trim().email('Valid super-admin email is required'),
  password: z.string().min(8, 'Super-admin password must be at least 8 characters'),
  fullName: z.string().trim().min(2, 'Super-admin name must be at least 2 characters').max(120),
});

// --- Email & Password Helpers ---

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || !PASSWORD_COMPLEXITY_REGEX.test(password)) {
    throw new AppError(
      400,
      'WEAK_PASSWORD',
      'Password must be 8 to 128 characters long and include at least one uppercase letter, one lowercase letter, and one number.'
    );
  }
  return true;
}

export async function hashPassword(plainPassword, saltRounds = BCRYPT_SALT_ROUNDS) {
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

// --- Internal Helpers ---

export function sanitizeAdmin(admin) {
  if (!admin) return null;
  const createdAt = admin.created_at ?? admin.createdAt ?? null;
  const lastLoginAt = admin.lastLoginAt ?? admin.last_login_at ?? null;

  return {
    id: admin.id,
    email: admin.email,
    fullName: admin.fullName ?? admin.full_name,
    role: admin.role,
    status: admin.status,
    lastLoginAt: lastLoginAt instanceof Date ? lastLoginAt.toISOString() : lastLoginAt,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
}

function revokeTokenFamily(familyId, transaction) {
  return AdminRefreshToken.update(
    { revokedAt: new Date() },
    { where: { familyId, revokedAt: null }, transaction }
  );
}

const cleanIp = (ip) => (ip ? String(ip).slice(0, 45) : null);
const cleanUa = (ua) => (ua ? String(ua).trim().slice(0, 255) : null);

// --- Core Admin Auth Flows ---

export async function login({ email, password, ipAddress = null, userAgent = null }) {
  const normalizedEmail = normalizeEmail(email);
  const admin = await Admin.findOne({ where: { email: normalizedEmail } });

  const isPasswordValid = await verifyPasswordTimingSafe(password, admin?.passwordHash);
  if (!admin || !isPasswordValid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  if (admin.status !== ADMIN_STATUSES.ACTIVE) {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
  }

  const now = new Date();
  const tokenId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ adminId: admin.id, tokenId, familyId });

  await sequelize.transaction(async (transaction) => {
    await admin.update({ lastLoginAt: now }, { transaction });
    await AdminRefreshToken.create(
      {
        id: tokenId,
        adminId: admin.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: new Date(now.getTime() + getRefreshMaxAgeMs()),
        ipAddress: cleanIp(ipAddress),
        userAgent: cleanUa(userAgent),
      },
      { transaction }
    );
  });

  return {
    admin: sanitizeAdmin(admin),
    accessToken: signAccessToken(admin),
    refreshToken,
  };
}

export async function refreshSession({ refreshToken, ipAddress = null, userAgent = null }) {
  if (!refreshToken) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is missing.');
  }

  verifyRefreshToken(refreshToken);

  const tokenRecord = await AdminRefreshToken.findOne({ where: { tokenHash: hashToken(refreshToken) } });
  if (!tokenRecord) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
  }

  if (tokenRecord.revokedAt) {
    await revokeTokenFamily(tokenRecord.familyId);
    throw new AppError(
      401,
      'REFRESH_TOKEN_REUSE_DETECTED',
      'Refresh token reuse detected. Session has been terminated.'
    );
  }

  const now = new Date();
  if (new Date(tokenRecord.expiresAt).getTime() <= now.getTime()) {
    await AdminRefreshToken.update({ revokedAt: now }, { where: { id: tokenRecord.id } });
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has expired.');
  }

  const admin = await Admin.findByPk(tokenRecord.adminId);
  if (!admin) {
    await revokeTokenFamily(tokenRecord.familyId);
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Admin account not found.');
  }

  if (admin.status !== ADMIN_STATUSES.ACTIVE) {
    await revokeTokenFamily(tokenRecord.familyId);
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
  }

  const newRefreshToken = await sequelize.transaction(async (transaction) => {
    const newTokenId = crypto.randomUUID();
    const signedRefresh = signRefreshToken({
      adminId: admin.id,
      tokenId: newTokenId,
      familyId: tokenRecord.familyId,
    });

    await AdminRefreshToken.create(
      {
        id: newTokenId,
        adminId: admin.id,
        tokenHash: hashToken(signedRefresh),
        familyId: tokenRecord.familyId,
        expiresAt: new Date(now.getTime() + getRefreshMaxAgeMs()),
        ipAddress: cleanIp(ipAddress),
        userAgent: cleanUa(userAgent),
      },
      { transaction }
    );

    const [revokedCount] = await AdminRefreshToken.update(
      { revokedAt: now, replacedByTokenId: newTokenId },
      { where: { id: tokenRecord.id, revokedAt: null }, transaction }
    );

    if (revokedCount === 0) {
      await revokeTokenFamily(tokenRecord.familyId, transaction);
      throw new AppError(
        401,
        'REFRESH_TOKEN_REUSE_DETECTED',
        'Session invalidated due to concurrent token reuse.'
      );
    }

    return signedRefresh;
  });

  return {
    admin: sanitizeAdmin(admin),
    accessToken: signAccessToken(admin),
    refreshToken: newRefreshToken,
  };
}

export async function logout({ refreshToken }) {
  if (!refreshToken) return;
  await AdminRefreshToken.update(
    { revokedAt: new Date() },
    { where: { tokenHash: hashToken(refreshToken), revokedAt: null } }
  );
}

export async function logoutAll({ adminId }) {
  await AdminRefreshToken.update(
    { revokedAt: new Date() },
    { where: { adminId, revokedAt: null } }
  );
}

export async function getCurrentAdmin({ adminId }) {
  const admin = await Admin.findByPk(adminId);
  if (!admin) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  }
  if (admin.status !== ADMIN_STATUSES.ACTIVE) {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
  }
  return sanitizeAdmin(admin);
}

export async function ensureInitialSuperAdmin({ email, password, fullName } = {}) {
  const parsed = bootstrapInputSchema.safeParse({ email, password, fullName });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError(400, 'INVALID_BOOTSTRAP_CONFIG', 'Invalid initial super-admin configuration.', details);
  }

  const normalizedEmail = normalizeEmail(parsed.data.email);
  validatePasswordStrength(parsed.data.password);

  return sequelize.transaction(async (transaction) => {
    const existingSuperAdmin = await Admin.findOne({
      where: { role: ADMIN_ROLES.SUPER_ADMIN },
      paranoid: false,
      transaction,
    });

    if (existingSuperAdmin) {
      return {
        created: false,
        reason: 'SUPER_ADMIN_ALREADY_EXISTS',
        admin: sanitizeAdmin(existingSuperAdmin),
      };
    }

    const existingByEmail = await Admin.findOne({
      where: { email: normalizedEmail },
      paranoid: false,
      transaction,
    });

    if (existingByEmail) {
      return {
        created: false,
        reason: 'EMAIL_ALREADY_EXISTS',
        admin: sanitizeAdmin(existingByEmail),
      };
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const created = await Admin.create(
      {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        passwordHash,
        fullName: parsed.data.fullName,
        role: ADMIN_ROLES.SUPER_ADMIN,
        status: ADMIN_STATUSES.ACTIVE,
      },
      { transaction }
    );

    return {
      created: true,
      reason: 'CREATED',
      admin: sanitizeAdmin(created),
    };
  });
}
