import sequelize from '../config/database.js';
import bootstrapService from '../services/bootstrap.service.js';

async function runSeed() {
  try {
    await sequelize.authenticate();
    const result = await bootstrapService.ensureInitialSuperAdmin();
    if (result.created) {
      console.log(
        `[AdminBackend] Initial super-admin created: ${result.admin.email} (id: ${result.admin.id})`,
      );
    } else {
      console.log(
        `[AdminBackend] Super-admin bootstrap skipped (${result.reason}): ${result.admin.email}`,
      );
    }
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('[AdminBackend] Super-admin seed failed:', err.message);
    try {
      await sequelize.close();
    } catch {
      // Ignore close error on failure
    }
    process.exit(1);
  }
}

runSeed();
