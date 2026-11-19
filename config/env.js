import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const DEV_SECRETS = {
  access: 'dev_only_admin_jwt_access_secret_replace_in_prod_32',
  refresh: 'dev_only_admin_jwt_refresh_secret_replace_in_prod_32',
};

const PLACEHOLDER_SECRETS = new Set([
  DEV_SECRETS.access,
  DEV_SECRETS.refresh,
  'change_me_admin_access_secret_min_32_chars',
  'change_me_admin_refresh_secret_min_32_chars',
]);

export function loadEnv(raw = process.env) {
  const nodeEnv = raw.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  const accessSecret = raw.ADMIN_JWT_ACCESS_SECRET || DEV_SECRETS.access;
  const refreshSecret = raw.ADMIN_JWT_REFRESH_SECRET || DEV_SECRETS.refresh;
  const saltRounds = Number(raw.BCRYPT_SALT_ROUNDS || 12);

  if (accessSecret.length < 32 || refreshSecret.length < 32) {
    throw new Error('Admin JWT secrets (access and refresh) must be at least 32 characters.');
  }

  if (accessSecret === refreshSecret) {
    throw new Error('ADMIN_JWT_REFRESH_SECRET must differ from ADMIN_JWT_ACCESS_SECRET.');
  }

  if (!Number.isInteger(saltRounds) || saltRounds < 10 || saltRounds > 15) {
    throw new Error('BCRYPT_SALT_ROUNDS must be an integer between 10 and 15.');
  }

  if (isProd && (PLACEHOLDER_SECRETS.has(accessSecret) || PLACEHOLDER_SECRETS.has(refreshSecret))) {
    throw new Error('Production requires custom ADMIN_JWT_ACCESS_SECRET and ADMIN_JWT_REFRESH_SECRET.');
  }

  return {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port: Number(raw.PORT || 5001),
    adminFrontendUrl: raw.ADMIN_FRONTEND_URL || 'http://localhost:3001',
    trustProxy: Number(raw.TRUST_PROXY || 0),
    db: {
      host: raw.DB_HOST || '127.0.0.1',
      port: Number(raw.DB_PORT || 3306),
      name: raw.DB_NAME || 'japaika_ecommerce',
      user: raw.DB_USER || 'root',
      password: raw.DB_PASSWORD || '',
      logging: raw.DB_LOGGING === 'true',
    },
    jwt: {
      accessSecret,
      refreshSecret,
      accessExpiresIn: raw.ADMIN_JWT_ACCESS_EXPIRES_IN || '15m',
      refreshExpiresIn: raw.ADMIN_JWT_REFRESH_EXPIRES_IN || '7d',
      issuer: 'japaika-admin-backend',
      audience: 'japaika-admin',
    },
    bcrypt: {
      saltRounds,
    },
    cookie: {
      domain: raw.COOKIE_DOMAIN || undefined,
      accessName: 'japaika_admin_access',
      refreshName: 'japaika_admin_refresh',
    },
    bootstrap: {
      superAdminEmail: (raw.INITIAL_SUPER_ADMIN_EMAIL || '').trim(),
      superAdminPassword: raw.INITIAL_SUPER_ADMIN_PASSWORD || '',
      superAdminName: (raw.INITIAL_SUPER_ADMIN_NAME || 'Japaika Super Admin').trim(),
    },
  };
}

const env = loadEnv();
export default env;
