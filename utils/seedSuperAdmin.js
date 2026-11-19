import { sequelize } from '../models/index.js';
import { ensureInitialSuperAdmin } from '../services/auth.service.js';

try {
  await sequelize.authenticate();
  const result = await ensureInitialSuperAdmin();
  if (result.created) {
    console.info(`Initial super-admin created: ${result.admin.email} (id: ${result.admin.id})`);
  } else {
    console.info(`Super-admin bootstrap skipped (${result.reason}): ${result.admin.email}`);
  }
  await sequelize.close();
  process.exit(0);
} catch (err) {
  console.error('Super-admin seed failed:', err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
}
