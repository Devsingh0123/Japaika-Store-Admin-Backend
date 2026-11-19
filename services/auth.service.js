import crypto from 'node:crypto';
import defaultModels from '../models/index.js';
import defaultPasswordService from './password.service.js';
import defaultTokenService from './token.service.js';
import { ADMIN_STATUSES } from '../config/constants.js';
import AppError from '../utils/appError.js';

export function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function truncateUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) {
    return null;
  }
  return userAgent.trim().slice(0, 255);
}

export function sanitizeAdmin(adminInstance) {
  if (!adminInstance) {
    return null;
  }
  const plain =
    typeof adminInstance.get === 'function'
      ? adminInstance.get({ plain: true })
      : adminInstance;

  const createdAt = plain.createdAt ?? plain.created_at ?? null;
  const lastLoginAt = plain.lastLoginAt ?? plain.last_login_at ?? null;

  return {
    id: plain.id,
    email: plain.email,
    fullName: plain.fullName ?? plain.full_name,
    role: plain.role,
    status: plain.status,
    lastLoginAt: lastLoginAt instanceof Date ? lastLoginAt.toISOString() : lastLoginAt,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
}

export function createAuthService({
  sequelize = defaultModels.sequelize,
  Admin = defaultModels.Admin,
  AdminRefreshToken = defaultModels.AdminRefreshToken,
  passwordService = defaultPasswordService,
  tokenService = defaultTokenService,
} = {}) {
  async function revokeTokenFamily(familyId, transaction = undefined) {
    const options = {
      where: {
        familyId,
        revokedAt: null,
      },
    };
    if (transaction) {
      options.transaction = transaction;
    }
    await AdminRefreshToken.update({ revokedAt: new Date() }, options);
  }

  async function login({ email, password, ipAddress = null, userAgent = null }) {
    const normalizedEmail = normalizeEmail(email);
    const admin = await Admin.findOne({
      where: { email: normalizedEmail },
    });

    const isPasswordValid = await passwordService.verifyPasswordTimingSafe(
      password,
      admin?.passwordHash,
    );

    if (!admin || !isPasswordValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    if (admin.status !== ADMIN_STATUSES.ACTIVE) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
    }

    const now = new Date();
    const jti = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    const refreshToken = tokenService.signRefreshToken({
      adminId: admin.id,
      jti,
      familyId,
    });
    const tokenHash = tokenService.hashRefreshToken(refreshToken);
    const expiresAt = tokenService.getRefreshTokenExpiresAt();

    await sequelize.transaction(async (transaction) => {
      await admin.update({ lastLoginAt: now }, { transaction });
      await AdminRefreshToken.create(
        {
          id: jti,
          adminId: admin.id,
          tokenHash,
          familyId,
          expiresAt,
          ipAddress: ipAddress || null,
          userAgent: truncateUserAgent(userAgent),
        },
        { transaction },
      );
    });

    const accessToken = tokenService.signAccessToken(admin);

    return {
      admin: sanitizeAdmin(admin),
      accessToken,
      refreshToken,
    };
  }

  async function refreshSession({ rawRefreshToken, ipAddress = null, userAgent = null }) {
    const payload = tokenService.verifyRefreshToken(rawRefreshToken);
    const tokenHash = tokenService.hashRefreshToken(rawRefreshToken);

    const tokenRecord = await AdminRefreshToken.findOne({
      where: { tokenHash },
    });

    if (!tokenRecord) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.');
    }

    if (tokenRecord.revokedAt !== null) {
      await revokeTokenFamily(tokenRecord.familyId);
      throw new AppError(
        401,
        'REFRESH_TOKEN_REUSE_DETECTED',
        'Refresh token reuse detected. Session has been terminated.',
      );
    }

    const now = new Date();
    if (new Date(tokenRecord.expiresAt) <= now) {
      await tokenRecord.update({ revokedAt: now });
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has expired.');
    }

    const admin = await Admin.findByPk(payload.sub);
    if (!admin) {
      await revokeTokenFamily(tokenRecord.familyId);
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Admin account not found.');
    }

    if (admin.status !== ADMIN_STATUSES.ACTIVE) {
      await revokeTokenFamily(tokenRecord.familyId);
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
    }

    const newJti = crypto.randomUUID();
    const newRefreshToken = tokenService.signRefreshToken({
      adminId: admin.id,
      jti: newJti,
      familyId: tokenRecord.familyId,
    });
    const newTokenHash = tokenService.hashRefreshToken(newRefreshToken);
    const newExpiresAt = tokenService.getRefreshTokenExpiresAt();

    await sequelize.transaction(async (transaction) => {
      await AdminRefreshToken.create(
        {
          id: newJti,
          adminId: admin.id,
          tokenHash: newTokenHash,
          familyId: tokenRecord.familyId,
          expiresAt: newExpiresAt,
          ipAddress: ipAddress || null,
          userAgent: truncateUserAgent(userAgent),
        },
        { transaction },
      );

      await tokenRecord.update(
        {
          revokedAt: now,
          replacedByTokenId: newJti,
        },
        { transaction },
      );
    });

    const newAccessToken = tokenService.signAccessToken(admin);

    return {
      admin: sanitizeAdmin(admin),
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async function logout({ rawRefreshToken }) {
    if (typeof rawRefreshToken === 'string' && rawRefreshToken.trim()) {
      const tokenHash = tokenService.hashRefreshToken(rawRefreshToken);
      await AdminRefreshToken.update(
        { revokedAt: new Date() },
        {
          where: {
            tokenHash,
            revokedAt: null,
          },
        },
      );
    }
  }

  async function logoutAll({ adminId }) {
    await AdminRefreshToken.update(
      { revokedAt: new Date() },
      {
        where: {
          adminId,
          revokedAt: null,
        },
      },
    );
  }

  async function getCurrentAdmin({ adminId }) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new AppError(401, 'UNAUTHORIZED', 'Admin account not found.');
    }
    if (admin.status !== ADMIN_STATUSES.ACTIVE) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Admin account is suspended.');
    }
    return {
      admin: sanitizeAdmin(admin),
    };
  }

  return {
    login,
    refreshSession,
    logout,
    logoutAll,
    getCurrentAdmin,
  };
}

const authService = createAuthService();
export default authService;
