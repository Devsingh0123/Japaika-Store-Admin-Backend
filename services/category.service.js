import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { sequelize, Category } from '../models/index.js';
import mediaService, { CLOUDINARY_FOLDERS } from './media.service.js';
import { AppError } from '../utils/http.js';

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150)
    .replace(/-+$/g, '');
}

export function resolveAndValidateSlug(rawSlug, fallbackName) {
  const candidate =
    typeof rawSlug === 'string' && rawSlug.trim()
      ? rawSlug.trim().toLowerCase()
      : slugify(fallbackName);

  if (!candidate || candidate.length > 150 || !SLUG_REGEX.test(candidate)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Category slug must contain only lowercase letters, numbers, and single hyphens.',
      [{ field: 'slug', message: 'Invalid slug format.' }]
    );
  }

  return candidate;
}

export function sanitizeCategory(categoryInstance) {
  if (!categoryInstance) return null;

  const plain =
    typeof categoryInstance.get === 'function'
      ? categoryInstance.get({ plain: true })
      : categoryInstance;

  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;

  const result = {
    id: plain.id,
    parentId: plain.parentId ?? plain.parent_id ?? null,
    name: plain.name,
    slug: plain.slug,
    description: plain.description ?? null,
    imageUrl: plain.imageUrl ?? plain.image_url ?? null,
    imagePublicId: plain.imagePublicId ?? plain.image_public_id ?? null,
    isActive: Boolean(plain.isActive ?? plain.is_active ?? true),
    sortOrder: Number(plain.sortOrder ?? plain.sort_order ?? 0),
    seoTitle: plain.seoTitle ?? plain.seo_title ?? null,
    seoDescription: plain.seoDescription ?? plain.seo_description ?? null,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
  };

  if (plain.parent !== undefined) {
    result.parent = plain.parent
      ? {
          id: plain.parent.id,
          name: plain.parent.name,
          slug: plain.parent.slug,
          isActive: Boolean(plain.parent.isActive ?? plain.parent.is_active ?? true),
        }
      : null;
  }

  if (Array.isArray(plain.subcategories)) {
    result.subcategories = plain.subcategories.map(sanitizeCategory);
  }

  return result;
}

async function ensureSlugAvailable(slug, excludeId = null) {
  const existing = await Category.findOne({
    where: { slug },
    paranoid: false,
  });

  if (existing && existing.id !== excludeId) {
    throw new AppError(
      409,
      'CATEGORY_SLUG_EXISTS',
      `A category with slug "${slug}" already exists.`
    );
  }
}

async function validateParentHierarchy(parentId, currentCategoryId = null) {
  if (!parentId) return null;

  if (currentCategoryId && parentId === currentCategoryId) {
    throw new AppError(
      400,
      'INVALID_CATEGORY_HIERARCHY',
      'A category cannot be assigned as its own parent.'
    );
  }

  const parent = await Category.findByPk(parentId);
  if (!parent) {
    throw new AppError(404, 'PARENT_CATEGORY_NOT_FOUND', 'Parent category not found.');
  }

  if (parent.parentId !== null) {
    throw new AppError(
      400,
      'INVALID_CATEGORY_HIERARCHY',
      'Subcategories cannot be nested under another subcategory (maximum 2 hierarchy levels).'
    );
  }

  if (currentCategoryId) {
    const existingChildren = await Category.count({
      where: { parentId: currentCategoryId },
    });

    if (existingChildren > 0) {
      throw new AppError(
        400,
        'INVALID_CATEGORY_HIERARCHY',
        'Cannot convert a category that already has subcategories into a subcategory.'
      );
    }
  }

  return parent;
}

export async function listCategories({
  page = 1,
  limit = 20,
  search = '',
  parentId,
  isActive,
  tree = false,
} = {}) {
  const where = {};

  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const pattern = `%${trimmedSearch}%`;
    where[Op.or] = [
      { name: { [Op.like]: pattern } },
      { slug: { [Op.like]: pattern } },
      { description: { [Op.like]: pattern } },
    ];
  }

  if (tree) {
    const treeWhere = { ...where, parentId: null };
    const subWhere = typeof isActive === 'boolean' ? { isActive } : undefined;

    const roots = await Category.findAll({
      where: treeWhere,
      include: [
        {
          model: Category,
          as: 'subcategories',
          where: subWhere,
          required: false,
        },
      ],
      order: [
        ['sort_order', 'ASC'],
        ['name', 'ASC'],
        [{ model: Category, as: 'subcategories' }, 'sort_order', 'ASC'],
        [{ model: Category, as: 'subcategories' }, 'name', 'ASC'],
      ],
    });

    const items = roots.map(sanitizeCategory);
    return {
      items,
      pagination: {
        page: 1,
        limit: items.length || limit,
        totalItems: items.length,
        totalPages: 1,
      },
    };
  }

  if (parentId === 'root' || parentId === 'null' || parentId === null) {
    where.parentId = null;
  } else if (typeof parentId === 'string' && parentId.trim()) {
    where.parentId = parentId.trim();
  }

  const offset = (page - 1) * limit;

  const { rows, count } = await Category.findAndCountAll({
    where,
    include: [
      {
        model: Category,
        as: 'parent',
        attributes: ['id', 'name', 'slug', 'is_active'],
        required: false,
      },
    ],
    order: [
      ['sort_order', 'ASC'],
      ['name', 'ASC'],
    ],
    limit,
    offset,
    distinct: true,
  });

  return {
    items: rows.map(sanitizeCategory),
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
}

export async function getCategoryById(id) {
  const category = await Category.findByPk(id, {
    include: [
      {
        model: Category,
        as: 'parent',
        attributes: ['id', 'name', 'slug', 'is_active'],
        required: false,
      },
      {
        model: Category,
        as: 'subcategories',
        required: false,
      },
    ],
    order: [
      [{ model: Category, as: 'subcategories' }, 'sort_order', 'ASC'],
      [{ model: Category, as: 'subcategories' }, 'name', 'ASC'],
    ],
  });

  if (!category) {
    throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  }

  return sanitizeCategory(category);
}

export async function createCategory(payload, file = null) {
  const slug = resolveAndValidateSlug(payload.slug, payload.name);
  await ensureSlugAvailable(slug);
  await validateParentHierarchy(payload.parentId ?? null);

  let uploadedImage = null;
  if (file?.buffer) {
    uploadedImage = await mediaService.uploadImageBuffer(file.buffer, {
      folder: CLOUDINARY_FOLDERS.CATEGORIES,
    });
  }

  try {
    const created = await Category.create({
      id: crypto.randomUUID(),
      parentId: payload.parentId ?? null,
      name: payload.name.trim(),
      slug,
      description: payload.description ?? null,
      imageUrl: uploadedImage?.imageUrl ?? null,
      imagePublicId: uploadedImage?.imagePublicId ?? null,
      isActive: payload.isActive ?? true,
      sortOrder: payload.sortOrder ?? 0,
      seoTitle: payload.seoTitle ?? null,
      seoDescription: payload.seoDescription ?? null,
    });

    return sanitizeCategory(created);
  } catch (err) {
    if (uploadedImage?.imagePublicId) {
      await mediaService.deleteImageByPublicId(uploadedImage.imagePublicId);
    }

    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(
        409,
        'CATEGORY_SLUG_EXISTS',
        `A category with slug "${slug}" already exists.`
      );
    }

    throw err;
  }
}

export async function updateCategory(id, payload, file = null) {
  const category = await Category.findByPk(id);
  if (!category) {
    throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  }

  const updates = {};

  if (payload.name !== undefined) {
    updates.name = payload.name.trim();
  }

  if (payload.slug !== undefined) {
    const nextSlug = resolveAndValidateSlug(payload.slug, updates.name || category.name);
    if (nextSlug !== category.slug) {
      await ensureSlugAvailable(nextSlug, category.id);
    }
    updates.slug = nextSlug;
  }

  if (payload.parentId !== undefined) {
    await validateParentHierarchy(payload.parentId, category.id);
    updates.parentId = payload.parentId;
  }

  if (payload.description !== undefined) {
    updates.description = payload.description;
  }

  if (payload.isActive !== undefined) {
    updates.isActive = payload.isActive;
  }

  if (payload.sortOrder !== undefined) {
    updates.sortOrder = payload.sortOrder;
  }

  if (payload.seoTitle !== undefined) {
    updates.seoTitle = payload.seoTitle;
  }

  if (payload.seoDescription !== undefined) {
    updates.seoDescription = payload.seoDescription;
  }

  const oldImagePublicId = category.imagePublicId;
  let newUploadedImage = null;

  if (file?.buffer) {
    newUploadedImage = await mediaService.uploadImageBuffer(file.buffer, {
      folder: CLOUDINARY_FOLDERS.CATEGORIES,
    });
    updates.imageUrl = newUploadedImage.imageUrl;
    updates.imagePublicId = newUploadedImage.imagePublicId;
  } else if (payload.removeImage === true) {
    updates.imageUrl = null;
    updates.imagePublicId = null;
  }

  try {
    await category.update(updates);
  } catch (err) {
    if (newUploadedImage?.imagePublicId) {
      await mediaService.deleteImageByPublicId(newUploadedImage.imagePublicId);
    }

    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(
        409,
        'CATEGORY_SLUG_EXISTS',
        `A category with slug "${updates.slug}" already exists.`
      );
    }

    throw err;
  }

  if (
    (newUploadedImage || payload.removeImage === true) &&
    oldImagePublicId &&
    oldImagePublicId !== newUploadedImage?.imagePublicId
  ) {
    await mediaService.deleteImageByPublicId(oldImagePublicId);
  }

  return sanitizeCategory(category);
}

export async function deleteCategory(id) {
  const category = await Category.findByPk(id);
  if (!category) {
    throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  }

  const childCount = await Category.count({
    where: { parentId: id },
  });

  if (childCount > 0) {
    throw new AppError(
      409,
      'CATEGORY_HAS_SUBCATEGORIES',
      'Cannot delete a category that still has subcategories. Delete or reassign its subcategories first.'
    );
  }

  const oldImagePublicId = category.imagePublicId;

  await sequelize.transaction(async (transaction) => {
    if (oldImagePublicId || category.imageUrl) {
      await category.update({ imageUrl: null, imagePublicId: null }, { transaction });
    }
    await category.destroy({ transaction });
  });

  if (oldImagePublicId) {
    await mediaService.deleteImageByPublicId(oldImagePublicId);
  }

  return { id: category.id, deleted: true };
}
