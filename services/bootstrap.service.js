import { z } from 'zod';
import defaultModels from '../models/index.js';
import defaultPasswordService from './password.service.js';
import { normalizeEmail, sanitizeAdmin } from './auth.service.js';
import { ADMIN_ROLES, ADMIN_STATUSES } from '../config/constants.js';
import env from '../config/env.js';
import AppError from '../utils/appError.js';

const bootstrapInputSchema = z.object({
  email: z.string().trim().email('Valid initial super-admin email is required'),
  password: z.string().min(8, 'Initial super-admin password must be at least 8 characters'),
  fullName: z.string().trim().min(2).max(120).default('Japaika Super Admin'),
});

export function createBootstrapService({
  sequelize = defaultModels.sequelize,
  Admin = defaultModels.Admin,
  passwordService = defaultPasswordService,
} = {}) {
  async function ensureInitialSuperAdmin({
    email = env.bootstrap.superAdminEmail,
    password = env.bootstrap.superAdminPassword,
    fullName = env.bootstrap.superAdminName,
  } = {}) {
    const parsed = bootstrapInputSchema.safeParse({ email, password, fullName });
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new AppError(
        400,
        'INVALID_BOOTSTRAP_CONFIG',
        'Invalid initial super-admin configuration.',
        details,
      );
    }

    const normalizedEmail = normalizeEmail(parsed.data.email);
    passwordService.validatePasswordStrength(parsed.data.password);

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

      const passwordHash = await passwordService.hashPassword(parsed.data.password);

      const created = await Admin.create(
        {
          email: normalizedEmail,
          passwordHash,
          fullName: parsed.data.fullName,
          role: ADMIN_ROLES.SUPER_ADMIN,
          status: ADMIN_STATUSES.ACTIVE,
        },
        { transaction },
      );

      return {
        created: true,
        reason: 'CREATED',
        admin: sanitizeAdmin(created),
      };
    });
  }

  return {
    ensureInitialSuperAdmin,
  };
}

const bootstrapService = createBootstrapService();
export default bootstrapService;
