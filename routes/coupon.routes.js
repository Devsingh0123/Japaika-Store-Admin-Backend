import { Router } from 'express';
import { z } from 'zod';
import { ADMIN_ROLES, ALL_COUPON_VISIBILITIES } from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { AppError } from '../utils/http.js';
import * as couponController from '../controllers/coupon.controller.js';

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

const decimalInputField = z.union([z.number(), z.string()]);
const nullableDecimalInputField = z.union([z.number(), z.string(), z.null()]).optional();

const nullablePositiveIntField = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    return Number(val);
  })
  .refine(
    (val) => val === undefined || val === null || (Number.isInteger(val) && val >= 1),
    { message: 'maxRedemptions must be an integer greater than or equal to 1, or null.' }
  );

export const createCouponSchema = z.object({
  code: z
    .string({ error: 'Coupon code is required.' })
    .trim()
    .min(3, 'Coupon code must be at least 3 characters.')
    .max(32, 'Coupon code must not exceed 32 characters.'),
  description: nullableTextField(255, 'Description'),
  discountPercentage: decimalInputField,
  minCartSubtotal: z.object(
    {
      INR: decimalInputField,
      USD: decimalInputField,
    },
    { error: 'minCartSubtotal must include both INR and USD amounts.' }
  ),
  maxDiscount: z
    .union([
      z.object({
        INR: nullableDecimalInputField,
        USD: nullableDecimalInputField,
      }),
      z.null(),
    ])
    .optional(),
  maxRedemptions: nullablePositiveIntField,
  visibility: z.enum(ALL_COUPON_VISIBILITIES).default('public'),
  isActive: booleanField,
  expiresAt: nullableDatetimeField('expiresAt'),
});

export const updateCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, 'Coupon code must be at least 3 characters.')
    .max(32, 'Coupon code must not exceed 32 characters.')
    .optional(),
  description: nullableTextField(255, 'Description'),
  discountPercentage: decimalInputField.optional(),
  minCartSubtotal: z
    .object({
      INR: decimalInputField.optional(),
      USD: decimalInputField.optional(),
    })
    .optional(),
  maxDiscount: z
    .union([
      z.object({
        INR: nullableDecimalInputField,
        USD: nullableDecimalInputField,
      }),
      z.null(),
    ])
    .optional(),
  maxRedemptions: nullablePositiveIntField,
  visibility: z.enum(ALL_COUPON_VISIBILITIES).optional(),
  isActive: booleanField,
  expiresAt: nullableDatetimeField('expiresAt'),
});

export const updateCouponStatusSchema = z.object({
  isActive: requiredBooleanField,
});

const listCouponsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional().default(''),
  isActive: booleanField,
  visibility: z.enum(ALL_COUPON_VISIBILITIES).optional(),
  status: z.enum(['active', 'inactive', 'expired', 'exhausted']).optional(),
  sortBy: z
    .enum([
      'createdAt',
      'updatedAt',
      'code',
      'discountPercentage',
      'expiresAt',
      'redemptionCount',
    ])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

function validateListCouponsQuery(req, _res, next) {
  const parsed = listCouponsQuerySchema.safeParse(req.query);
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

function validateCouponIdParam(req, _res, next) {
  if (!UUID_REGEX.test(String(req.params.id || ''))) {
    return next(
      new AppError(400, 'VALIDATION_ERROR', 'Invalid coupon ID.', [
        { field: 'id', message: 'Coupon ID must be a valid UUID.' },
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

router.get('/', requireAdminAuth, validateListCouponsQuery, couponController.listCoupons);
router.get('/:id', requireAdminAuth, validateCouponIdParam, couponController.getCouponById);

router.post(
  '/',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateBody(createCouponSchema),
  couponController.createCoupon
);

router.patch(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateCouponIdParam,
  validateBody(updateCouponSchema),
  couponController.updateCoupon
);

router.patch(
  '/:id/status',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateCouponIdParam,
  validateBody(updateCouponStatusSchema),
  couponController.updateCouponStatus
);

router.delete(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateCouponIdParam,
  couponController.deleteCoupon
);

export default router;
