import { Router } from 'express';
import { z } from 'zod';
import { ADMIN_ROLES } from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import { uploadSingleImage } from '../middlewares/upload.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { AppError } from '../utils/http.js';
import * as categoryController from '../controllers/category.controller.js';

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

const nullableParentIdField = z
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
    message: 'parentId must be a valid UUID or null.',
  });

const booleanField = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
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
    message: 'sortOrder must be an integer.',
  });

export const createCategorySchema = z.object({
  name: z
    .string({ error: 'Category name is required.' })
    .trim()
    .min(1, 'Category name is required.')
    .max(120, 'Category name must not exceed 120 characters.'),
  slug: z
    .string()
    .trim()
    .max(150, 'Slug must not exceed 150 characters.')
    .optional(),
  parentId: nullableParentIdField,
  description: nullableTextField(5000, 'Description'),
  isActive: booleanField,
  sortOrder: sortOrderField,
  seoTitle: nullableTextField(160, 'SEO title'),
  seoDescription: nullableTextField(320, 'SEO description'),
});

export const updateCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Category name cannot be empty.')
    .max(120, 'Category name must not exceed 120 characters.')
    .optional(),
  slug: z
    .string()
    .trim()
    .min(1, 'Slug cannot be empty.')
    .max(150, 'Slug must not exceed 150 characters.')
    .optional(),
  parentId: nullableParentIdField,
  description: nullableTextField(5000, 'Description'),
  isActive: booleanField,
  sortOrder: sortOrderField,
  seoTitle: nullableTextField(160, 'SEO title'),
  seoDescription: nullableTextField(320, 'SEO description'),
  removeImage: booleanField,
});

const listCategoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional().default(''),
  parentId: z
    .string()
    .trim()
    .optional()
    .refine(
      (val) =>
        val === undefined ||
        val === '' ||
        val === 'root' ||
        val === 'null' ||
        UUID_REGEX.test(val),
      { message: 'parentId filter must be a valid UUID, "root", or "null".' }
    ),
  isActive: booleanField,
  tree: booleanField.transform((val) => Boolean(val)),
});

function validateCategoryQuery(req, _res, next) {
  const parsed = listCategoriesQuerySchema.safeParse(req.query);
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

function validateCategoryIdParam(req, _res, next) {
  if (!UUID_REGEX.test(String(req.params.id || ''))) {
    return next(
      new AppError(400, 'VALIDATION_ERROR', 'Invalid category ID.', [
        { field: 'id', message: 'Category ID must be a valid UUID.' },
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

router.get('/', requireAdminAuth, validateCategoryQuery, categoryController.listCategories);
router.get('/:id', requireAdminAuth, validateCategoryIdParam, categoryController.getCategoryById);

router.post(
  '/',
  requireAdminAuth,
  requireCatalogWriteRole,
  uploadSingleImage('image'),
  validateBody(createCategorySchema),
  categoryController.createCategory
);

router.patch(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateCategoryIdParam,
  uploadSingleImage('image'),
  validateBody(updateCategorySchema),
  categoryController.updateCategory
);

router.delete(
  '/:id',
  requireAdminAuth,
  requireCatalogWriteRole,
  validateCategoryIdParam,
  categoryController.deleteCategory
);

export default router;
