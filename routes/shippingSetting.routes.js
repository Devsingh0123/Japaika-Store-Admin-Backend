import { Router } from 'express';
import { z } from 'zod';
import { ADMIN_ROLES } from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { normalizeSupportedCountry } from '../services/shippingSetting.service.js';
import * as shippingSettingController from '../controllers/shippingSetting.controller.js';

const decimalInputField = z.union([z.number(), z.string()]);
const nullableDecimalInputField = z.union([z.number(), z.string(), z.null()]).optional();

const nullableIntField = (label) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      return Number(val);
    })
    .refine((val) => val === undefined || val === null || Number.isInteger(val), {
      message: `${label} must be an integer or null.`,
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

export const updateShippingSettingSchema = z.object({
  flatCharge: decimalInputField.optional(),
  freeShippingThreshold: nullableDecimalInputField,
  estimatedDaysMin: nullableIntField('estimatedDaysMin'),
  estimatedDaysMax: nullableIntField('estimatedDaysMax'),
  isActive: booleanField,
});

export const updateShippingSettingStatusSchema = z.object({
  isActive: requiredBooleanField,
});

function validateCountryParam(req, _res, next) {
  try {
    req.params.country = normalizeSupportedCountry(req.params.country);
    return next();
  } catch (err) {
    return next(err);
  }
}

const requireShippingWriteRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.OPERATIONS_MANAGER
);

const router = Router();

router.get('/', requireAdminAuth, shippingSettingController.listShippingSettings);
router.get(
  '/:country',
  requireAdminAuth,
  validateCountryParam,
  shippingSettingController.getShippingSetting
);

router.patch(
  '/:country',
  requireAdminAuth,
  requireShippingWriteRole,
  validateCountryParam,
  validateBody(updateShippingSettingSchema),
  shippingSettingController.updateShippingSetting
);

router.patch(
  '/:country/status',
  requireAdminAuth,
  requireShippingWriteRole,
  validateCountryParam,
  validateBody(updateShippingSettingStatusSchema),
  shippingSettingController.updateShippingSettingStatus
);

export default router;
