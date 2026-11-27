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
import defineProductVariantModel, {
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
  DEFAULT_COUNTRY,
} from './productVariant.model.js';
import defineProductMediaModel, {
  PRODUCT_MEDIA_TYPES,
  ALL_PRODUCT_MEDIA_TYPES,
} from './productMedia.model.js';
import defineBannerModel, {
  BANNER_PLACEMENTS,
  ALL_BANNER_PLACEMENTS,
} from './banner.model.js';
import defineCouponModel, {
  COUPON_VISIBILITIES,
  ALL_COUPON_VISIBILITIES,
} from './coupon.model.js';
import defineUserModel from './user.model.js';
import defineShippingSettingModel from './shippingSetting.model.js';
import defineOrderModel, {
  ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  PAYMENT_METHODS,
  ALL_PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ALL_PAYMENT_STATUSES,
  CANCELLED_BY_ACTORS,
  ALL_CANCELLED_BY_ACTORS,
} from './order.model.js';
import defineOrderItemModel from './orderItem.model.js';

const Admin = defineAdminModel(sequelize);
const AdminRefreshToken = defineAdminRefreshTokenModel(sequelize);
const Category = defineCategoryModel(sequelize);
const Product = defineProductModel(sequelize);
const ProductVariant = defineProductVariantModel(sequelize);
const ProductMedia = defineProductMediaModel(sequelize);
const Banner = defineBannerModel(sequelize);
const Coupon = defineCouponModel(sequelize);
const User = defineUserModel(sequelize);
const ShippingSetting = defineShippingSettingModel(sequelize);
const Order = defineOrderModel(sequelize);
const OrderItem = defineOrderItemModel(sequelize);

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

User.hasMany(Order, {
  foreignKey: { name: 'userId', field: 'user_id' },
  as: 'orders',
});

Order.belongsTo(User, {
  foreignKey: { name: 'userId', field: 'user_id' },
  as: 'user',
});

Coupon.hasMany(Order, {
  foreignKey: { name: 'couponId', field: 'coupon_id' },
  as: 'orders',
});

Order.belongsTo(Coupon, {
  foreignKey: { name: 'couponId', field: 'coupon_id' },
  as: 'coupon',
});

Order.hasMany(OrderItem, {
  foreignKey: { name: 'orderId', field: 'order_id' },
  as: 'items',
});

OrderItem.belongsTo(Order, {
  foreignKey: { name: 'orderId', field: 'order_id' },
  as: 'order',
});

export {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  Banner,
  Coupon,
  User,
  ShippingSetting,
  Order,
  OrderItem,
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
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
  DEFAULT_COUNTRY,
  BANNER_PLACEMENTS,
  ALL_BANNER_PLACEMENTS,
  COUPON_VISIBILITIES,
  ALL_COUPON_VISIBILITIES,
  ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  PAYMENT_METHODS,
  ALL_PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ALL_PAYMENT_STATUSES,
  CANCELLED_BY_ACTORS,
  ALL_CANCELLED_BY_ACTORS,
};

export default {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  Banner,
  Coupon,
  User,
  ShippingSetting,
  Order,
  OrderItem,
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
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
  DEFAULT_COUNTRY,
  BANNER_PLACEMENTS,
  ALL_BANNER_PLACEMENTS,
  COUPON_VISIBILITIES,
  ALL_COUPON_VISIBILITIES,
  ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  PAYMENT_METHODS,
  ALL_PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ALL_PAYMENT_STATUSES,
  CANCELLED_BY_ACTORS,
  ALL_CANCELLED_BY_ACTORS,
};
