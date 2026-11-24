import { Router } from 'express';
import { z } from 'zod';
import { ADMIN_ROLES, ALL_BANNER_PLACEMENTS } from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import { uploadBannerImages } from '../middlewares/upload.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { AppError } from '../utils/http.js';
import * as bannerController from '../controllers/banner.controller.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const nullableTextField = (maxLen, label) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      const trimmed = val.trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine((val) => val === undefined || val === null || val.length <= maxLen, {
      message: `${label} must not exceed ${maxLen} characters.`,
    });

const nullableDatetimeField = (label) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      const trimmed = val.trim();
      if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
      return trimmed;
    })
    .refine((val) => val === undefined || val === null || !Number.isNaN(Date.parse(val)), {
      message: `${label} must be a valid ISO 8601 datetime or null.`,
    });

const booleanField = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  });

const requiredBooleanField = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  });

const sortOrderField = z
  .union([z.number(), z.string()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === '') return undefined;
    return Number(val);
  })
  .refine((val) => val === undefined || (Number.isInteger(val) && val >= -10000 && val <= 100000), {
    message: 'sortOrder must be an integer between -10000 and 100000.',
  });

export const createBannerSchema = z.object({
  title: z
    .string({ error: 'Banner title is required.' })
    .trim()
    .min(1, 'Banner title is required.')
    .max(160, 'Banner title must not exceed 160 characters.'),
  subtitle: nullableTextField(320, 'Subtitle'),
  badgeText: nullableTextField(60, 'Badge text'),
  altText: nullableTextField(160, 'Alt text'),
  ctaLabel: nullableTextField(60, 'CTA label'),
  ctaUrl: nullableTextField(500, 'CTA URL'),
  placement: z.enum(ALL_BANNER_PLACEMENTS).default('homepage_hero'),
  sortOrder: sortOrderField,
  isActive: booleanField,
  startsAt: nullableDatetimeField('startsAt'),
  endsAt: nullableDatetimeField('endsAt'),
});

export const updateBannerSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Banner title cannot be empty.')
    .max(160, 'Banner title must not exceed 160 characters.')
    .optional(),
  subtitle: nullableTextField(320, 'Subtitle'),
  badgeText: nullableTextField(60, 'Badge text'),
  altText: nullableTextField(160, 'Alt text'),
  ctaLabel: nullableTextField(60, 'CTA label'),
  ctaUrl: nullableTextField(500, 'CTA URL'),
  placement: z.enum(ALL_BANNER_PLACEMENTS).optional(),
  sortOrder: sortOrderField,
  isActive: booleanField,
  startsAt: nullableDatetimeField('startsAt'),
  endsAt: nullableDatetimeField('endsAt'),
  removeMobileImage: booleanField,
});

export const updateBannerStatusSchema = z.object({
  isActive: requiredBooleanField,
});

export const reorderBannersSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().regex(UUID_REGEX, 'Each banner id must be a valid UUID.'),
        sortOrder: z
          .number({ error: 'sortOrder must be an integer.' })
          .int('sortOrder must be an integer.')
          .min(-10000)
          .max(100000),
      })
    )
    .min(1, 'At least one banner item is required.')
    .max(100, 'Cannot reorder more than 100 banners in a single request.'),
});

const listBannersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional().default(''),
  placement: z.enum(ALL_BANNER_PLACEMENTS).optional(),
  isActive: booleanField,
  scheduleStatus: z.enum(['live', 'scheduled', 'expired']).optional(),
});

function validateListBannersQuery(req, _res, next) {
  const parsed = listBannersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'query',
      message: issue.message,
    }));
    return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters.', details));
  }
  req.validatedQuery = parsed.data;
  return next();
}

function validateBannerIdParam(req, _res, next) {
  if (!UUID_REGEX.test(String(req.params.id || ''))) {
    return next(
      new AppError(400, 'VALIDATION_ERROR', 'Invalid banner ID.', [
        { field: 'id', message: 'Banner ID must be a valid UUID.' },
      ])
    );
  }
  return next();
}

const requireCatalogWriteRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.CATALOG_MANAGER
);

const router = Router();

router.get('/', requireAdminAuth, validateListBannersQuery, bannerController.listBanners);
router.get('/:id', requireAdminAuth, validateBannerIdParam, bannerController.getBannerById);

router.post(
  '/',
  requireAdminAuth,
  requireCatalogWriteRole,
  uploadBannerImages(),
  validateBody(createBannerSchema),
  bannerController.createBanner
);

// Must be mounted BEFORE PATCH /:id so /reorder is not matched as an :id parameter
router.patch(
  '/reorder',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateBody(reorderBannersSchema),
  bannerController.reorderBanners
);

router.patch(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateBannerIdParam,
  uploadBannerImages(),
  validateBody(updateBannerSchema),
  bannerController.updateBanner
);

router.patch(
  '/:id/status',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateBannerIdParam,
  validateBody(updateBannerStatusSchema),
  bannerController.updateBannerStatus
);

router.delete(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateBannerIdParam,
  bannerController.deleteBanner
);

export default router;
