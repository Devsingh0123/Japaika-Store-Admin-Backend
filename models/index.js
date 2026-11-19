import sequelize from '../config/database.js';
import defineAdminModel from './admin.model.js';
import defineAdminRefreshTokenModel from './adminRefreshToken.model.js';

const Admin = defineAdminModel(sequelize);
const AdminRefreshToken = defineAdminRefreshTokenModel(sequelize);

Admin.hasMany(AdminRefreshToken, {
  foreignKey: 'admin_id',
  as: 'refreshTokens',
});

AdminRefreshToken.belongsTo(Admin, {
  foreignKey: 'admin_id',
  as: 'admin',
});

export { sequelize, Admin, AdminRefreshToken };
export default { sequelize, Admin, AdminRefreshToken };
