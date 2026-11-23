import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { sequelize } from '../models/index.js';
import { ensureInitialSuperAdmin } from '../services/auth.service.js';

const rl = createInterface({ input, output });

try {
  await sequelize.authenticate();

  const fullName = (await rl.question('Enter Super Admin Name: ')).trim();
  const email = (await rl.question('Enter Super Admin Email: ')).trim();
  const password = await rl.question('Enter Super Admin Password: ');
  rl.close();

  const result = await ensureInitialSuperAdmin({ fullName, email, password });

  if (result.created) {
    console.info(`Initial super-admin created: ${result.admin.email} (id: ${result.admin.id})`);
  } else {
    console.info(`Super-admin seed skipped (${result.reason}): ${result.admin.email}`);
  }

  await sequelize.close();
  process.exit(0);
} catch (err) {
  rl.close();
  console.error('Super-admin seed failed:', err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
}
