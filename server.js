import app from './app.js';
import env from './config/env.js';
import sequelize from './config/database.js';
import bootstrapService from './services/bootstrap.service.js';

let server;

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log(`[AdminBackend] Connected to MySQL database (${env.db.name})`);

    if (env.bootstrap.superAdminEmail && env.bootstrap.superAdminPassword) {
      const bootstrapResult = await bootstrapService.ensureInitialSuperAdmin();
      if (bootstrapResult.created) {
        console.log(
          `[AdminBackend] Initial Super Admin bootstrapped (${bootstrapResult.admin.email})`,
        );
      }
    }

    server = app.listen(env.port, () => {
      console.log(
        `[AdminBackend] Server running on port ${env.port} in ${env.nodeEnv} mode`,
      );
    });
  } catch (err) {
    console.error('[AdminBackend] Failed to start server:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`[AdminBackend] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await sequelize.close();
  console.log('[AdminBackend] Database connection closed.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();
