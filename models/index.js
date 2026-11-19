import sequelize from '../config/database.js';
import defineAdminModel, {
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
} from './admin.model.js';
import defineAdminRefreshTokenModel from './adminRefreshToken.model.js';

const Admin = defineAdminModel(sequelize);
const AdminRefreshToken = defineAdminRefreshTokenModel(sequelize);

Admin.hasMany(AdminRefreshToken, {
  foreignKey: { name: 'adminId', field: 'admin_id' },
  as: 'refreshTokens',
});

AdminRefreshToken.belongsTo(Admin, {
  foreignKey: { name: 'adminId', field: 'admin_id' },
  as: 'admin',
});

export {
  sequelize,
  Admin,
  AdminRefreshToken,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
};
export default {
  sequelize,
  Admin,
  AdminRefreshToken,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
};
