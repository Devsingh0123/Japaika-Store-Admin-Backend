import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const DEV_ACCESS_DEFAULT = 'dev_only_admin_jwt_access_secret_replace_in_prod_32';
const DEV_REFRESH_DEFAULT = 'dev_only_admin_jwt_refresh_secret_replace_in_prod_32';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5001),
    ADMIN_FRONTEND_URL: z.string().url().default('http://localhost:3001'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_NAME: z.string().min(1).default('japaika_ecommerce'),
    DB_USER: z.string().min(1).default('root'),
    DB_PASSWORD: z.string().default(''),
    DB_LOGGING: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),

    TEST_DB_NAME: z.string().optional().default(''),

    ADMIN_JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'ADMIN_JWT_ACCESS_SECRET must be at least 32 characters')
      .default(DEV_ACCESS_DEFAULT),
    ADMIN_JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'ADMIN_JWT_REFRESH_SECRET must be at least 32 characters')
      .default(DEV_REFRESH_DEFAULT),
    ADMIN_JWT_ACCESS_EXPIRES_IN: z.string().min(1).default('15m'),
    ADMIN_JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('7d'),

    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    COOKIE_DOMAIN: z.string().optional().default(''),

    INITIAL_SUPER_ADMIN_EMAIL: z.string().optional().default(''),
    INITIAL_SUPER_ADMIN_PASSWORD: z.string().optional().default(''),
    INITIAL_SUPER_ADMIN_NAME: z.string().min(1).default('Japaika Super Admin'),
  })
  .superRefine((data, ctx) => {
    if (data.ADMIN_JWT_ACCESS_SECRET === data.ADMIN_JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_JWT_REFRESH_SECRET'],
        message: 'ADMIN_JWT_REFRESH_SECRET must differ from ADMIN_JWT_ACCESS_SECRET',
      });
    }

    if (data.NODE_ENV === 'production') {
      const placeholderSecrets = [
        DEV_ACCESS_DEFAULT,
        DEV_REFRESH_DEFAULT,
        'change_me_admin_access_secret_min_32_chars',
        'change_me_admin_refresh_secret_min_32_chars',
      ];

      if (placeholderSecrets.includes(data.ADMIN_JWT_ACCESS_SECRET)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_JWT_ACCESS_SECRET'],
          message: 'Production requires a custom ADMIN_JWT_ACCESS_SECRET',
        });
      }

      if (placeholderSecrets.includes(data.ADMIN_JWT_REFRESH_SECRET)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_JWT_REFRESH_SECRET'],
          message: 'Production requires a custom ADMIN_JWT_REFRESH_SECRET',
        });
      }
    }
  });

export function parseEnv(rawEnv = process.env) {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }
  return parsed.data;
}

const raw = parseEnv(process.env);

const env = {
  nodeEnv: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  adminFrontendUrl: raw.ADMIN_FRONTEND_URL,
  trustProxy: raw.TRUST_PROXY,
  db: {
    host: raw.DB_HOST,
    port: raw.DB_PORT,
    name: raw.NODE_ENV === 'test' && raw.TEST_DB_NAME ? raw.TEST_DB_NAME : raw.DB_NAME,
    user: raw.DB_USER,
    password: raw.DB_PASSWORD,
    logging: raw.DB_LOGGING,
  },
  jwt: {
    accessSecret: raw.ADMIN_JWT_ACCESS_SECRET,
    refreshSecret: raw.ADMIN_JWT_REFRESH_SECRET,
    accessExpiresIn: raw.ADMIN_JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: raw.ADMIN_JWT_REFRESH_EXPIRES_IN,
    issuer: 'japaika-admin-backend',
    audience: 'japaika-admin',
  },
  bcrypt: {
    saltRounds: raw.BCRYPT_SALT_ROUNDS,
  },
  cookie: {
    domain: raw.COOKIE_DOMAIN || undefined,
    accessName: 'japaika_admin_access',
    refreshName: 'japaika_admin_refresh',
  },
  bootstrap: {
    superAdminEmail: raw.INITIAL_SUPER_ADMIN_EMAIL.trim(),
    superAdminPassword: raw.INITIAL_SUPER_ADMIN_PASSWORD,
    superAdminName: raw.INITIAL_SUPER_ADMIN_NAME.trim(),
  },
};

export default env;
