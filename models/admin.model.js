import { DataTypes } from 'sequelize';

export const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  CATALOG_MANAGER: 'catalog_manager',
  OPERATIONS_MANAGER: 'operations_manager',
  SUPPORT_MODERATOR: 'support_moderator',
});

export const ALL_ADMIN_ROLES = Object.freeze(Object.values(ADMIN_ROLES));

export const ADMIN_STATUSES = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
});

export const ALL_ADMIN_STATUSES = Object.freeze(Object.values(ADMIN_STATUSES));

export default function defineAdminModel(sequelize) {
  return sequelize.define(
    'Admin',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      passwordHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'password_hash',
      },
      fullName: {
        type: DataTypes.STRING(120),
        allowNull: false,
        field: 'full_name',
      },
      role: {
        type: DataTypes.ENUM(...ALL_ADMIN_ROLES),
        allowNull: false,
        defaultValue: ADMIN_ROLES.SUPPORT_MODERATOR,
      },
      status: {
        type: DataTypes.ENUM(...ALL_ADMIN_STATUSES),
        allowNull: false,
        defaultValue: ADMIN_STATUSES.ACTIVE,
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_login_at',
      },
    },
    {
      tableName: 'admins',
      timestamps: true,
      paranoid: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
    }
  );
}
