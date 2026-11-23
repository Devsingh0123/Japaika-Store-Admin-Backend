import sequelize from '../config/database.js';
import defineAdminModel, {
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
} from './admin.model.js';
import defineAdminRefreshTokenModel from './adminRefreshToken.model.js';
import defineCategoryModel from './category.model.js';
import defineProductModel, {
  PRODUCT_TYPES,
  ALL_PRODUCT_TYPES,
  PRODUCT_STATUSES,
  ALL_PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
} from './product.model.js';
import defineProductVariantModel from './productVariant.model.js';
import defineProductMediaModel, {
  PRODUCT_MEDIA_TYPES,
  ALL_PRODUCT_MEDIA_TYPES,
} from './productMedia.model.js';

const Admin = defineAdminModel(sequelize);
const AdminRefreshToken = defineAdminRefreshTokenModel(sequelize);
const Category = defineCategoryModel(sequelize);
const Product = defineProductModel(sequelize);
const ProductVariant = defineProductVariantModel(sequelize);
const ProductMedia = defineProductMediaModel(sequelize);

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

Category.hasMany(Product, {
  foreignKey: { name: 'categoryId', field: 'category_id' },
  as: 'products',
});

Product.belongsTo(Category, {
  foreignKey: { name: 'categoryId', field: 'category_id' },
  as: 'category',
});

Product.hasMany(ProductVariant, {
  foreignKey: { name: 'productId', field: 'product_id' },
  as: 'variants',
});

ProductVariant.belongsTo(Product, {
  foreignKey: { name: 'productId', field: 'product_id' },
  as: 'product',
});

Product.hasMany(ProductMedia, {
  foreignKey: { name: 'productId', field: 'product_id' },
  as: 'media',
});

ProductMedia.belongsTo(Product, {
  foreignKey: { name: 'productId', field: 'product_id' },
  as: 'product',
});

export {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
  PRODUCT_TYPES,
  ALL_PRODUCT_TYPES,
  PRODUCT_STATUSES,
  ALL_PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
  PRODUCT_MEDIA_TYPES,
  ALL_PRODUCT_MEDIA_TYPES,
};

export default {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  ADMIN_ROLES,
  ALL_ADMIN_ROLES,
  ADMIN_STATUSES,
  ALL_ADMIN_STATUSES,
  PRODUCT_TYPES,
  ALL_PRODUCT_TYPES,
  PRODUCT_STATUSES,
  ALL_PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
  PRODUCT_MEDIA_TYPES,
  ALL_PRODUCT_MEDIA_TYPES,
};
