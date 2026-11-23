import { DataTypes } from 'sequelize';

export default function defineProductImageModel(sequelize) {
  return sequelize.define(
    'ProductImage',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      productId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'product_id',
      },
      imageUrl: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'image_url',
      },
      imagePublicId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'image_public_id',
      },
      altText: {
        type: DataTypes.STRING(160),
        allowNull: true,
        defaultValue: null,
        field: 'alt_text',
      },
      isPrimary: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_primary',
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'sort_order',
      },
    },
    {
      tableName: 'product_images',
      timestamps: true,
      updatedAt: false,
      underscored: true,
      createdAt: 'created_at',
    }
  );
}
