import { DataTypes } from 'sequelize';

export const BANNER_PLACEMENTS = Object.freeze({
  HOMEPAGE_HERO: 'homepage_hero',
  HOMEPAGE_PROMO: 'homepage_promo',
});

export const ALL_BANNER_PLACEMENTS = Object.freeze(Object.values(BANNER_PLACEMENTS));

export default function defineBannerModel(sequelize) {
  return sequelize.define(
    'Banner',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      subtitle: {
        type: DataTypes.STRING(320),
        allowNull: true,
        defaultValue: null,
      },
      badgeText: {
        type: DataTypes.STRING(60),
        allowNull: true,
        defaultValue: null,
        field: 'badge_text',
      },
      imageUrl: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'image_url',
      },
      imagePublicId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: null,
        field: 'image_public_id',
      },
      mobileImageUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        defaultValue: null,
        field: 'mobile_image_url',
      },
      mobileImagePublicId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: null,
        field: 'mobile_image_public_id',
      },
      altText: {
        type: DataTypes.STRING(160),
        allowNull: true,
        defaultValue: null,
        field: 'alt_text',
      },
      ctaLabel: {
        type: DataTypes.STRING(60),
        allowNull: true,
        defaultValue: null,
        field: 'cta_label',
      },
      ctaUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        defaultValue: null,
        field: 'cta_url',
      },
      placement: {
        type: DataTypes.ENUM(...ALL_BANNER_PLACEMENTS),
        allowNull: false,
        defaultValue: BANNER_PLACEMENTS.HOMEPAGE_HERO,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'sort_order',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
      },
      startsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        field: 'starts_at',
      },
      endsAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        field: 'ends_at',
      },
    },
    {
      tableName: 'banners',
      timestamps: true,
      paranoid: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
    }
  );
}
