import { Router } from 'express';
import { z } from 'zod';
import {
  ADMIN_ROLES,
  ALL_PRODUCT_TYPES,
  ALL_PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
} from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import {
  uploadProductCreateFiles,
  uploadProductMedia,
  uploadProductCertificate,
} from '../middlewares/upload.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { AppError } from '../utils/http.js';
import * as productController from '../controllers/product.controller.js';

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

const nullableUuidField = (label = 'ID') =>
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
    .refine((val) => val === undefined || val === null || UUID_REGEX.test(val), {
      message: `${label} must be a valid UUID or null.`,
    });

const booleanField = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  });

const nullablePositiveDecimalField = (label) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      return Number(val);
    })
    .refine((val) => val === undefined || val === null || (Number.isFinite(val) && val >= 0), {
      message: `${label} must be a non-negative number.`,
    });

const nullablePositiveIntField = (label) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      return Number(val);
    })
    .refine(
      (val) => val === undefined || val === null || (Number.isInteger(val) && val >= 0),
      { message: `${label} must be a non-negative integer.` }
    );

const specificationItemSchema = z.object({
  key: z.string().trim().min(1, 'Specification key is required.').max(80),
  value: z.string().trim().min(1, 'Specification value is required.').max(255),
});

const variantOptionItemSchema = z.object({
  name: z.string().trim().min(1, 'Option name is required.').max(60),
  values: z
    .array(z.string().trim().min(1).max(80))
    .min(1, 'At least one option value is required.')
    .max(30),
});

const variantInputSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().trim().max(64).optional(),
  title: z.union([z.string().trim().max(160), z.null()]).optional(),
  optionValues: z
    .union([z.record(z.string(), z.union([z.string(), z.number()])), z.null()])
    .optional(),
  price: z.coerce.number().min(0, 'Price must be non-negative.').default(0),
  salePrice: nullablePositiveDecimalField('Sale price'),
  stockQuantity: z.coerce.number().int().min(0, 'Stock quantity must be >= 0.').default(0),
  lowStockThreshold: z.coerce
    .number()
    .int()
    .min(0, 'Low stock threshold must be >= 0.')
    .default(5),
  isActive: booleanField,
  isDefault: booleanField,
  sortOrder: z.coerce.number().int().optional(),
});

const hsnCodeField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    const trimmed = val.trim();
    return trimmed === '' ? null : trimmed;
  })
  .refine((val) => val === undefined || val === null || /^\d{4,8}$/.test(val), {
    message: 'HSN code must be a 4 to 8 digit number.',
  });

const gstRateField = z
  .union([z.number(), z.string()])
  .optional()
  .transform((val) => (val === undefined || val === '' ? undefined : Number(val)))
  .refine((val) => val === undefined || ALLOWED_GST_RATES.includes(val), {
    message: `gstRate must be one of: ${ALLOWED_GST_RATES.join(', ')}.`,
  });

export const createProductSchema = z.object({
  name: z
    .string({ error: 'Product name is required.' })
    .trim()
    .min(1, 'Product name is required.')
    .max(200, 'Product name must not exceed 200 characters.'),
  slug: z.string().trim().max(220).optional(),
  productType: z.enum(ALL_PRODUCT_TYPES).default('simple'),
  status: z.enum(['draft', 'active']).default('draft'),
  categoryId: nullableUuidField('categoryId'),
  shortDescription: nullableTextField(500, 'Short description'),
  description: nullableTextField(20000, 'Description'),
  traditionalSignificance: nullableTextField(10000, 'Traditional significance'),
  wearingInstructions: nullableTextField(10000, 'Wearing instructions'),
  careInstructions: nullableTextField(10000, 'Care instructions'),
  specifications: z
    .union([z.array(specificationItemSchema).max(50), z.null()])
    .optional(),
  variantOptions: z
    .union([z.array(variantOptionItemSchema).max(5), z.null()])
    .optional(),
  gstRate: gstRateField,
  hsnCode: hsnCodeField,
  certificateLabel: nullableTextField(150, 'Certificate label'),
  weightGrams: nullablePositiveIntField('weightGrams'),
  lengthCm: nullablePositiveDecimalField('lengthCm'),
  widthCm: nullablePositiveDecimalField('widthCm'),
  heightCm: nullablePositiveDecimalField('heightCm'),
  shippingNotes: nullableTextField(255, 'Shipping notes'),
  isFeatured: booleanField,
  seoTitle: nullableTextField(160, 'SEO title'),
  seoDescription: nullableTextField(320, 'SEO description'),
  variants: z
    .union([z.array(variantInputSchema).min(1).max(100), variantInputSchema])
    .optional(),
});

export const updateProductSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Product name cannot be empty.')
    .max(200, 'Product name must not exceed 200 characters.')
    .optional(),
  slug: z.string().trim().min(1).max(220).optional(),
  productType: z.enum(ALL_PRODUCT_TYPES).optional(),
  status: z.enum(ALL_PRODUCT_STATUSES).optional(),
  categoryId: nullableUuidField('categoryId'),
  shortDescription: nullableTextField(500, 'Short description'),
  description: nullableTextField(20000, 'Description'),
  traditionalSignificance: nullableTextField(10000, 'Traditional significance'),
  wearingInstructions: nullableTextField(10000, 'Wearing instructions'),
  careInstructions: nullableTextField(10000, 'Care instructions'),
  specifications: z
    .union([z.array(specificationItemSchema).max(50), z.null()])
    .optional(),
  variantOptions: z
    .union([z.array(variantOptionItemSchema).max(5), z.null()])
    .optional(),
  gstRate: gstRateField,
  hsnCode: hsnCodeField,
  certificateLabel: nullableTextField(150, 'Certificate label'),
  weightGrams: nullablePositiveIntField('weightGrams'),
  lengthCm: nullablePositiveDecimalField('lengthCm'),
  widthCm: nullablePositiveDecimalField('widthCm'),
  heightCm: nullablePositiveDecimalField('heightCm'),
  shippingNotes: nullableTextField(255, 'Shipping notes'),
  isFeatured: booleanField,
  seoTitle: nullableTextField(160, 'SEO title'),
  seoDescription: nullableTextField(320, 'SEO description'),
  variants: z
    .union([z.array(variantInputSchema).min(1).max(100), variantInputSchema])
    .optional(),
});

export const updateProductStatusSchema = z.object({
  status: z.enum(ALL_PRODUCT_STATUSES, {
    error: 'Status must be draft, active, or archived.',
  }),
});

export const updateVariantStockSchema = z
  .object({
    stockQuantity: z.coerce.number().int().min(0).optional(),
    lowStockThreshold: z.coerce.number().int().min(0).optional(),
    isActive: booleanField,
  })
  .refine(
    (data) =>
      data.stockQuantity !== undefined ||
      data.lowStockThreshold !== undefined ||
      data.isActive !== undefined,
    {
      message:
        'At least one of stockQuantity, lowStockThreshold, or isActive must be provided.',
    }
  );

export const updateProductMediaSchema = z
  .object({
    altText: nullableTextField(160, 'Alt text'),
    sortOrder: z.coerce.number().int().min(0).optional(),
    isPrimary: booleanField,
  })
  .refine(
    (data) =>
      data.altText !== undefined ||
      data.sortOrder !== undefined ||
      data.isPrimary !== undefined,
    { message: 'At least one of altText, sortOrder, or isPrimary must be provided.' }
  );

export const upsertCertificateSchema = z.object({
  certificateLabel: nullableTextField(150, 'Certificate label'),
});

const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional().default(''),
  status: z.enum(ALL_PRODUCT_STATUSES).optional(),
  categoryId: z
    .string()
    .trim()
    .optional()
    .refine((val) => !val || UUID_REGEX.test(val), {
      message: 'categoryId filter must be a valid UUID.',
    }),
  productType: z.enum(ALL_PRODUCT_TYPES).optional(),
  isFeatured: booleanField,
  stockStatus: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

function validateListProductsQuery(req, _res, next) {
  const parsed = listProductsQuerySchema.safeParse(req.query);
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

function validateUuidParams(...paramNames) {
  return (req, _res, next) => {
    for (const name of paramNames) {
      if (!UUID_REGEX.test(String(req.params[name] || ''))) {
        return next(
          new AppError(400, 'VALIDATION_ERROR', `Invalid ${name} parameter.`, [
            { field: name, message: `${name} must be a valid UUID.` },
          ])
        );
      }
    }
    return next();
  };
}

const requireCatalogWriteRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.CATALOG_MANAGER
);

const requireStockWriteRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.CATALOG_MANAGER,
  ADMIN_ROLES.OPERATIONS_MANAGER
);

const router = Router();

router.get('/', requireAdminAuth, validateListProductsQuery, productController.listProducts);
router.get(
  '/:id',
  requireAdminAuth,
  validateUuidParams('id'),
  productController.getProductById
);

router.post(
  '/',
  requireAdminAuth,
  requireCatalogWriteRole,
  uploadProductCreateFiles(),
  validateBody(createProductSchema),
  productController.createProduct
);

router.patch(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  validateBody(updateProductSchema),
  productController.updateProduct
);

router.patch(
  '/:id/status',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  validateBody(updateProductStatusSchema),
  productController.updateProductStatus
);

router.patch(
  '/:id/variants/:variantId/stock',
  requireAdminAuth,
  requireStockWriteRole,
  validateUuidParams('id', 'variantId'),
  validateBody(updateVariantStockSchema),
  productController.updateVariantStock
);

router.delete(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  productController.deleteProduct
);

router.post(
  '/:id/media',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  uploadProductMedia('media', 10),
  productController.addProductMedia
);

router.patch(
  '/:id/media/:mediaId',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id', 'mediaId'),
  validateBody(updateProductMediaSchema),
  productController.updateProductMedia
);

router.delete(
  '/:id/media/:mediaId',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id', 'mediaId'),
  productController.deleteProductMedia
);

router.put(
  '/:id/certificate',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  uploadProductCertificate('certificate'),
  validateBody(upsertCertificateSchema),
  productController.upsertProductCertificate
);

router.delete(
  '/:id/certificate',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateUuidParams('id'),
  productController.deleteProductCertificate
);

export default router;
