import sequelize from '../config/database.js';
import defineAdminModel, {
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
} from './admin.model.js';
import defineAdminRefreshTokenModel from './adminRefreshToken.model.js';
import defineCategoryModel from './category.model.js';

const Admin = defineAdminModel(sequelize);
const AdminRefreshToken = defineAdminRefreshTokenModel(sequelize);
const Category = defineCategoryModel(sequelize);

Admin.hasMany(AdminRefreshToken, {
  foreignKey: { name: 'adminId', field: 'admin_id' },
  as: 'refreshTokens',
});

AdminRefreshToken.belongsTo(Admin, {
  foreignKey: { name: 'adminId', field: 'admin_id' },
  as: 'admin',
});

Category.belongsTo(Category, {
  foreignKey: { name: 'parentId', field: 'parent_id' },
  as: 'parent',
});

Category.hasMany(Category, {
  foreignKey: { name: 'parentId', field: 'parent_id' },
  as: 'subcategories',
});

export {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
};
export default {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
};
