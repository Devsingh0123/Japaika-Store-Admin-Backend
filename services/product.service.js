import crypto from 'node:crypto';
import { Op } from 'sequelize';
import {
  sequelize,
  Category,
  Product,
  ProductVariant,
  ProductImage,
  PRODUCT_TYPES,
  PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
} from '../models/index.js';
import mediaService, { CLOUDINARY_FOLDERS } from './media.service.js';
import { MAX_PRODUCT_IMAGES } from '../middlewares/upload.middleware.js';
import { AppError } from '../utils/http.js';

export const PRODUCT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyProduct(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 220)
    .replace(/-+$/g, '');
}

export function resolveAndValidateProductSlug(rawSlug, fallbackName) {
  const candidate =
    typeof rawSlug === 'string' && rawSlug.trim()
      ? rawSlug.trim().toLowerCase()
      : slugifyProduct(fallbackName);

  if (!candidate || candidate.length > 220 || !PRODUCT_SLUG_REGEX.test(candidate)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Product slug must contain only lowercase letters, numbers, and single hyphens.',
      [{ field: 'slug', message: 'Invalid product slug format.' }]
    );
  }

  return candidate;
}

export function generateVariantSku(productSlug = 'ITEM', index = 0) {
  const prefix = String(productSlug || 'ITEM')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'ITEM';
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `JPK-${prefix}-${index + 1}${rand}`.slice(0, 64);
}

export function normalizeSku(rawSku, productSlug, index = 0) {
  if (typeof rawSku === 'string' && rawSku.trim()) {
    const cleaned = rawSku.trim().toUpperCase();
    if (cleaned.length > 64) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Variant SKU must not exceed 64 characters.', [
        { field: 'sku', message: 'SKU exceeds 64 characters.' },
      ]);
    }
    return cleaned;
  }
  return generateVariantSku(productSlug, index);
}

export function buildOptionSignature(productType, optionValues) {
  if (productType === PRODUCT_TYPES.SIMPLE) {
    return 'default';
  }

  if (!optionValues || typeof optionValues !== 'object' || Array.isArray(optionValues)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Each variant for a variant-type product must specify optionValues.',
      [{ field: 'variants.optionValues', message: 'optionValues object is required.' }]
    );
  }

  const entries = Object.entries(optionValues)
    .map(([k, v]) => [String(k || '').trim().toLowerCase(), String(v ?? '').trim().toLowerCase()])
    .filter(([k, v]) => k.length > 0 && v.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Each variant for a variant-type product must specify non-empty optionValues.',
      [{ field: 'variants.optionValues', message: 'optionValues cannot be empty.' }]
    );
  }

  const signature = entries.map(([k, v]) => `${k}=${v}`).join('|');
  if (signature.length > 255) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Variant option combination signature exceeds maximum length.'
    );
  }

  return signature;
}

export function validateSalePrice(price, salePrice) {
  const regular = Number(price ?? 0);
  if (!Number.isFinite(regular) || regular < 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Variant price must be a non-negative number.');
  }

  if (salePrice === null || salePrice === undefined || salePrice === '') {
    return null;
  }

  const sale = Number(salePrice);
  if (!Number.isFinite(sale) || sale <= 0 || sale >= regular) {
    throw new AppError(
      400,
      'INVALID_SALE_PRICE',
      'Sale price must be greater than 0 and strictly less than regular price.'
    );
  }

  return Number(sale.toFixed(2));
}

export function validateGstRate(gstRate) {
  const rate = Number(gstRate ?? 0);
  if (!ALLOWED_GST_RATES.includes(rate)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `gstRate must be one of the standard GST slabs: ${ALLOWED_GST_RATES.join(', ')}.`,
      [{ field: 'gstRate', message: 'Invalid GST slab.' }]
    );
  }
  return rate;
}

function formatMoney(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

export function sanitizeVariant(variantInstance) {
  if (!variantInstance) return null;
  const plain =
    typeof variantInstance.get === 'function'
      ? variantInstance.get({ plain: true })
      : variantInstance;

  const price = formatMoney(plain.price ?? 0);
  const salePrice =
    plain.salePrice !== null && plain.salePrice !== undefined
      ? formatMoney(plain.salePrice)
      : plain.sale_price !== null && plain.sale_price !== undefined
        ? formatMoney(plain.sale_price)
        : null;
  const effectivePrice = salePrice !== null ? salePrice : price;

  const stockQuantity = Number(plain.stockQuantity ?? plain.stock_quantity ?? 0);
  const lowStockThreshold = Number(
    plain.lowStockThreshold ?? plain.low_stock_threshold ?? 5
  );
  const isActive = Boolean(plain.isActive ?? plain.is_active ?? true);
  const isDefault = Boolean(plain.isDefault ?? plain.is_default ?? false);
  const isOutOfStock = stockQuantity === 0;
  const isLowStock = stockQuantity > 0 && stockQuantity <= lowStockThreshold;
  const isPurchasable = isActive && stockQuantity > 0;

  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;

  return {
    id: plain.id,
    productId: plain.productId ?? plain.product_id,
    sku: plain.sku,
    title: plain.title ?? null,
    optionValues: plain.optionValues ?? plain.option_values ?? null,
    optionSignature: plain.optionSignature ?? plain.option_signature ?? null,
    price,
    salePrice,
    effectivePrice,
    stockQuantity,
    lowStockThreshold,
    isActive,
    isDefault,
    isOutOfStock,
    isLowStock,
    isPurchasable,
    sortOrder: Number(plain.sortOrder ?? plain.sort_order ?? 0),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
  };
}

export function sanitizeImage(imageInstance) {
  if (!imageInstance) return null;
  const plain =
    typeof imageInstance.get === 'function'
      ? imageInstance.get({ plain: true })
      : imageInstance;

  const createdAt = plain.created_at ?? plain.createdAt ?? null;

  return {
    id: plain.id,
    productId: plain.productId ?? plain.product_id,
    imageUrl: plain.imageUrl ?? plain.image_url,
    imagePublicId: plain.imagePublicId ?? plain.image_public_id,
    altText: plain.altText ?? plain.alt_text ?? null,
    isPrimary: Boolean(plain.isPrimary ?? plain.is_primary ?? false),
    sortOrder: Number(plain.sortOrder ?? plain.sort_order ?? 0),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
}

export function sanitizeCertificate(plainProduct) {
  const url = plainProduct.certificateUrl ?? plainProduct.certificate_url ?? null;
  if (!url) return null;

  return {
    url,
    publicId: plainProduct.certificatePublicId ?? plainProduct.certificate_public_id ?? null,
    resourceType:
      plainProduct.certificateResourceType ?? plainProduct.certificate_resource_type ?? 'image',
    label: plainProduct.certificateLabel ?? plainProduct.certificate_label ?? null,
  };
}

export function sanitizeProductDetail(productInstance) {
  if (!productInstance) return null;
  const plain =
    typeof productInstance.get === 'function'
      ? productInstance.get({ plain: true })
      : productInstance;

  const images = Array.isArray(plain.images)
    ? [...plain.images]
        .map(sanitizeImage)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder)
    : [];

  const variants = Array.isArray(plain.variants)
    ? [...plain.variants]
        .map(sanitizeVariant)
        .sort((a, b) => a.sortOrder - b.sortOrder || String(a.sku).localeCompare(String(b.sku)))
    : [];

  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;
  const publishedAt = plain.publishedAt ?? plain.published_at ?? null;

  return {
    id: plain.id,
    categoryId: plain.categoryId ?? plain.category_id ?? null,
    category: plain.category
      ? {
          id: plain.category.id,
          name: plain.category.name,
          slug: plain.category.slug,
          parentId: plain.category.parentId ?? plain.category.parent_id ?? null,
          isActive: Boolean(plain.category.isActive ?? plain.category.is_active ?? true),
        }
      : null,
    name: plain.name,
    slug: plain.slug,
    productType: plain.productType ?? plain.product_type,
    status: plain.status,
    shortDescription: plain.shortDescription ?? plain.short_description ?? null,
    description: plain.description ?? null,
    traditionalSignificance:
      plain.traditionalSignificance ?? plain.traditional_significance ?? null,
    wearingInstructions: plain.wearingInstructions ?? plain.wearing_instructions ?? null,
    careInstructions: plain.careInstructions ?? plain.care_instructions ?? null,
    specifications: plain.specifications ?? [],
    variantOptions: plain.variantOptions ?? plain.variant_options ?? null,
    gstRate: formatMoney(plain.gstRate ?? plain.gst_rate ?? 0),
    hsnCode: plain.hsnCode ?? plain.hsn_code ?? null,
    certificate: sanitizeCertificate(plain),
    shipping: {
      weightGrams: plain.weightGrams ?? plain.weight_grams ?? null,
      lengthCm: formatMoney(plain.lengthCm ?? plain.length_cm),
      widthCm: formatMoney(plain.widthCm ?? plain.width_cm),
      heightCm: formatMoney(plain.heightCm ?? plain.height_cm),
      shippingNotes: plain.shippingNotes ?? plain.shipping_notes ?? null,
    },
    isFeatured: Boolean(plain.isFeatured ?? plain.is_featured ?? false),
    seoTitle: plain.seoTitle ?? plain.seo_title ?? null,
    seoDescription: plain.seoDescription ?? plain.seo_description ?? null,
    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : publishedAt,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
    images,
    variants,
  };
}

export function sanitizeProductListItem(productInstance) {
  const detail = sanitizeProductDetail(productInstance);
  const activeVariants = detail.variants.filter((v) => v.isActive);
  const pricePool = activeVariants.length > 0 ? activeVariants : detail.variants;
  const effectivePrices = pricePool.map((v) => Number(v.effectivePrice || 0));

  const minPrice =
    effectivePrices.length > 0 ? Math.min(...effectivePrices).toFixed(2) : '0.00';
  const maxPrice =
    effectivePrices.length > 0 ? Math.max(...effectivePrices).toFixed(2) : '0.00';
  const totalStock = pricePool.reduce((sum, v) => sum + v.stockQuantity, 0);
  const hasLowStock = pricePool.some((v) => v.stockQuantity <= v.lowStockThreshold);
  const primaryImage = detail.images[0]
    ? {
        id: detail.images[0].id,
        imageUrl: detail.images[0].imageUrl,
        altText: detail.images[0].altText,
      }
    : null;

  return {
    id: detail.id,
    name: detail.name,
    slug: detail.slug,
    productType: detail.productType,
    status: detail.status,
    category: detail.category
      ? { id: detail.category.id, name: detail.category.name, slug: detail.category.slug }
      : null,
    primaryImage,
    gstRate: detail.gstRate,
    hsnCode: detail.hsnCode,
    isFeatured: detail.isFeatured,
    variantCount: detail.variants.length,
    minPrice,
    maxPrice,
    totalStock,
    hasLowStock,
    publishedAt: detail.publishedAt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

async function ensureProductSlugAvailable(slug, excludeProductId = null) {
  const existing = await Product.findOne({
    where: { slug },
    paranoid: false,
  });

  if (existing && existing.id !== excludeProductId) {
    throw new AppError(
      409,
      'PRODUCT_SLUG_EXISTS',
      `A product with slug "${slug}" already exists.`
    );
  }
}

async function validateCategoryAssignment(categoryId, requireActive = false) {
  if (!categoryId) {
    if (requireActive) {
      throw new AppError(
        400,
        'PUBLISH_VALIDATION_FAILED',
        'A valid active category is required to publish a product.',
        [{ field: 'categoryId', message: 'Category is required to publish.' }]
      );
    }
    return null;
  }

  const category = await Category.findByPk(categoryId);
  if (!category) {
    throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Assigned category not found.');
  }

  if (requireActive && !category.isActive) {
    throw new AppError(
      400,
      'PUBLISH_VALIDATION_FAILED',
      'Cannot publish a product under an inactive category.',
      [{ field: 'categoryId', message: 'Assigned category is inactive.' }]
    );
  }

  return category;
}

function normalizeAndValidateVariantsInput({
  productType,
  productSlug,
  variantOptions,
  variantsInput,
}) {
  if (productType === PRODUCT_TYPES.SIMPLE) {
    const raw =
      Array.isArray(variantsInput) && variantsInput.length > 0
        ? variantsInput[0]
        : variantsInput && typeof variantsInput === 'object' && !Array.isArray(variantsInput)
          ? variantsInput
          : {};

    const price = Number(raw.price ?? 0);
    const salePrice = validateSalePrice(price, raw.salePrice);

    return [
      {
        id: raw.id || undefined,
        sku: normalizeSku(raw.sku, productSlug, 0),
        title: raw.title ? String(raw.title).trim() : 'Default',
        optionValues: null,
        optionSignature: 'default',
        price: Number(price.toFixed(2)),
        salePrice,
        stockQuantity: Number(raw.stockQuantity ?? 0),
        lowStockThreshold: Number(raw.lowStockThreshold ?? 5),
        isActive: raw.isActive !== undefined ? Boolean(raw.isActive) : true,
        isDefault: true,
        sortOrder: 0,
      },
    ];
  }

  if (!Array.isArray(variantsInput) || variantsInput.length === 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'At least one variant must be provided for a variant-type product.',
      [{ field: 'variants', message: 'At least one variant is required.' }]
    );
  }

  const definedOptionNames = Array.isArray(variantOptions)
    ? variantOptions.map((opt) => String(opt.name || '').trim().toLowerCase()).filter(Boolean)
    : [];

  const seenSkus = new Set();
  const seenSignatures = new Set();

  const normalized = variantsInput.map((raw, idx) => {
    const sku = normalizeSku(raw.sku, productSlug, idx);
    if (seenSkus.has(sku)) {
      throw new AppError(
        409,
        'VARIANT_SKU_EXISTS',
        `Duplicate SKU "${sku}" in submitted variants.`
      );
    }
    seenSkus.add(sku);

    const signature = buildOptionSignature(PRODUCT_TYPES.VARIANT, raw.optionValues);
    if (seenSignatures.has(signature)) {
      throw new AppError(
        409,
        'DUPLICATE_VARIANT_COMBINATION',
        `Duplicate variant option combination (${signature}) for this product.`
      );
    }
    seenSignatures.add(signature);

    if (definedOptionNames.length > 0) {
      const providedKeys = Object.keys(raw.optionValues || {}).map((k) =>
        k.trim().toLowerCase()
      );
      for (const reqKey of definedOptionNames) {
        if (!providedKeys.includes(reqKey)) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `Variant #${idx + 1} is missing option value for "${reqKey}".`,
            [{ field: `variants.${idx}.optionValues`, message: `Missing option "${reqKey}".` }]
          );
        }
      }
    }

    const price = Number(raw.price ?? 0);
    const salePrice = validateSalePrice(price, raw.salePrice);
    const autoTitle =
      raw.title && String(raw.title).trim()
        ? String(raw.title).trim()
        : Object.values(raw.optionValues || {}).join(' / ');

    return {
      id: raw.id || undefined,
      sku,
      title: autoTitle.slice(0, 160),
      optionValues: raw.optionValues,
      optionSignature: signature,
      price: Number(price.toFixed(2)),
      salePrice,
      stockQuantity: Number(raw.stockQuantity ?? 0),
      lowStockThreshold: Number(raw.lowStockThreshold ?? 5),
      isActive: raw.isActive !== undefined ? Boolean(raw.isActive) : true,
      isDefault: Boolean(raw.isDefault),
      sortOrder: raw.sortOrder !== undefined ? Number(raw.sortOrder) : idx,
    };
  });

  if (!normalized.some((v) => v.isDefault)) {
    normalized[0].isDefault = true;
  } else {
    let foundDefault = false;
    for (const v of normalized) {
      if (v.isDefault) {
        if (foundDefault) v.isDefault = false;
        foundDefault = true;
      }
    }
  }

  return normalized;
}

async function ensureSkusAvailableInDb(variants, excludeProductId = null) {
  const skus = variants.map((v) => v.sku);
  if (skus.length === 0) return;

  const existing = await ProductVariant.findAll({
    where: { sku: { [Op.in]: skus } },
    paranoid: false,
  });

  for (const row of existing) {
    if (!excludeProductId || row.productId !== excludeProductId) {
      throw new AppError(
        409,
        'VARIANT_SKU_EXISTS',
        `A product variant with SKU "${row.sku}" already exists.`
      );
    }
    const matchingInput = variants.find((v) => v.sku === row.sku);
    if (matchingInput && matchingInput.id && matchingInput.id !== row.id) {
      throw new AppError(
        409,
        'VARIANT_SKU_EXISTS',
        `SKU "${row.sku}" is already assigned to another variant.`
      );
    }
  }
}

function assertPublishRequirements({
  status,
  productType,
  categoryId,
  variantOptions,
  variants,
  imageCount,
}) {
  if (status !== PRODUCT_STATUSES.ACTIVE) return;

  const issues = [];

  if (!categoryId) {
    issues.push({
      field: 'categoryId',
      message: 'An active category is required to publish a product.',
    });
  }

  if (imageCount < 1) {
    issues.push({
      field: 'images',
      message: 'At least one product image is required to publish a product.',
    });
  }

  if (
    productType === PRODUCT_TYPES.VARIANT &&
    (!Array.isArray(variantOptions) || variantOptions.length === 0)
  ) {
    issues.push({
      field: 'variantOptions',
      message: 'Variant options must be defined to publish a variant product.',
    });
  }

  const activeVariants = variants.filter((v) => v.isActive);
  if (activeVariants.length === 0) {
    issues.push({
      field: 'variants',
      message: 'At least one active variant is required to publish a product.',
    });
  }

  for (const v of activeVariants) {
    if (Number(v.price) <= 0) {
      issues.push({
        field: 'variants.price',
        message: `Active variant "${v.sku}" must have a regular price greater than 0 to publish.`,
      });
    }
  }

  if (issues.length > 0) {
    throw new AppError(
      400,
      'PUBLISH_VALIDATION_FAILED',
      issues[0].message,
      issues
    );
  }
}

export async function listProducts({
  page = 1,
  limit = 20,
  search = '',
  status,
  categoryId,
  productType,
  isFeatured,
  stockStatus,
  sortBy = 'createdAt',
  sortOrder = 'desc',
} = {}) {
  const where = {};

  if (status) {
    where.status = status;
  }

  if (categoryId) {
    where.categoryId = categoryId;
  }

  if (productType) {
    where.productType = productType;
  }

  if (typeof isFeatured === 'boolean') {
    where.isFeatured = isFeatured;
  }

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const pattern = `%${trimmedSearch}%`;
    const matchingVariants = await ProductVariant.findAll({
      where: { sku: { [Op.like]: pattern } },
      attributes: ['productId'],
    });
    const skuProductIds = [...new Set(matchingVariants.map((v) => v.productId))];

    where[Op.or] = [
      { name: { [Op.like]: pattern } },
      { slug: { [Op.like]: pattern } },
      ...(skuProductIds.length > 0 ? [{ id: { [Op.in]: skuProductIds } }] : []),
    ];
  }

  const sortColumnMap = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    name: 'name',
    status: 'status',
  };
  const orderCol = sortColumnMap[sortBy] || 'created_at';
  const orderDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const allMatches = await Product.findAll({
    where,
    include: [
      {
        model: Category,
        as: 'category',
        attributes: ['id', 'name', 'slug', 'parent_id', 'is_active'],
        required: false,
      },
      {
        model: ProductVariant,
        as: 'variants',
        required: false,
      },
      {
        model: ProductImage,
        as: 'images',
        required: false,
      },
    ],
    order: [[orderCol, orderDir]],
  });

  let items = allMatches.map(sanitizeProductListItem);

  if (stockStatus === 'out_of_stock') {
    items = items.filter((item) => item.totalStock === 0);
  } else if (stockStatus === 'low_stock') {
    items = items.filter((item) => item.totalStock > 0 && item.hasLowStock);
  } else if (stockStatus === 'in_stock') {
    items = items.filter((item) => item.totalStock > 0);
  }

  const totalItems = items.length;
  const offset = (page - 1) * limit;
  const pagedItems = items.slice(offset, offset + limit);

  return {
    items: pagedItems,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    },
  };
}

export async function getProductById(id) {
  const product = await Product.findByPk(id, {
    include: [
      {
        model: Category,
        as: 'category',
        attributes: ['id', 'name', 'slug', 'parent_id', 'is_active'],
        required: false,
      },
      {
        model: ProductVariant,
        as: 'variants',
        required: false,
      },
      {
        model: ProductImage,
        as: 'images',
        required: false,
      },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  return sanitizeProductDetail(product);
}

export async function createProduct(payload, files = {}) {
  const productType = payload.productType || PRODUCT_TYPES.SIMPLE;
  const status = payload.status || PRODUCT_STATUSES.DRAFT;
  const slug = resolveAndValidateProductSlug(payload.slug, payload.name);
  const gstRate = validateGstRate(payload.gstRate ?? 0);

  await ensureProductSlugAvailable(slug);
  await validateCategoryAssignment(
    payload.categoryId ?? null,
    status === PRODUCT_STATUSES.ACTIVE
  );

  const variantOptions =
    productType === PRODUCT_TYPES.VARIANT ? payload.variantOptions ?? [] : null;

  const normalizedVariants = normalizeAndValidateVariantsInput({
    productType,
    productSlug: slug,
    variantOptions,
    variantsInput: payload.variants,
  });

  await ensureSkusAvailableInDb(normalizedVariants);

  const imageFiles = Array.isArray(files.images) ? files.images : [];
  if (imageFiles.length > MAX_PRODUCT_IMAGES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A product can have at most ${MAX_PRODUCT_IMAGES} images.`
    );
  }

  assertPublishRequirements({
    status,
    productType,
    categoryId: payload.categoryId ?? null,
    variantOptions,
    variants: normalizedVariants,
    imageCount: imageFiles.length,
  });

  const uploadedImages = [];
  let uploadedCertificate = null;

  try {
    for (const file of imageFiles) {
      const uploaded = await mediaService.uploadImageBuffer(file.buffer, {
        folder: CLOUDINARY_FOLDERS.PRODUCTS,
      });
      uploadedImages.push(uploaded);
    }

    if (files.certificate?.buffer) {
      uploadedCertificate = await mediaService.uploadCertificateBuffer(
        files.certificate.buffer,
        {
          mimetype: files.certificate.mimetype,
          folder: CLOUDINARY_FOLDERS.CERTIFICATES,
        }
      );
    }

    const productId = crypto.randomUUID();
    const now = new Date();

    await sequelize.transaction(async (transaction) => {
      await Product.create(
        {
          id: productId,
          categoryId: payload.categoryId ?? null,
          name: payload.name.trim(),
          slug,
          productType,
          status,
          shortDescription: payload.shortDescription ?? null,
          description: payload.description ?? null,
          traditionalSignificance: payload.traditionalSignificance ?? null,
          wearingInstructions: payload.wearingInstructions ?? null,
          careInstructions: payload.careInstructions ?? null,
          specifications: payload.specifications ?? null,
          variantOptions,
          gstRate,
          hsnCode: payload.hsnCode ?? null,
          certificateUrl: uploadedCertificate?.certificateUrl ?? null,
          certificatePublicId: uploadedCertificate?.certificatePublicId ?? null,
          certificateResourceType: uploadedCertificate?.certificateResourceType ?? null,
          certificateLabel: payload.certificateLabel ?? null,
          weightGrams: payload.weightGrams ?? null,
          lengthCm: payload.lengthCm ?? null,
          widthCm: payload.widthCm ?? null,
          heightCm: payload.heightCm ?? null,
          shippingNotes: payload.shippingNotes ?? null,
          isFeatured: Boolean(payload.isFeatured ?? false),
          seoTitle: payload.seoTitle ?? null,
          seoDescription: payload.seoDescription ?? null,
          publishedAt: status === PRODUCT_STATUSES.ACTIVE ? now : null,
        },
        { transaction }
      );

      for (const variant of normalizedVariants) {
        await ProductVariant.create(
          {
            id: crypto.randomUUID(),
            productId,
            sku: variant.sku,
            title: variant.title,
            optionValues: variant.optionValues,
            optionSignature: variant.optionSignature,
            price: variant.price,
            salePrice: variant.salePrice,
            stockQuantity: variant.stockQuantity,
            lowStockThreshold: variant.lowStockThreshold,
            isActive: variant.isActive,
            isDefault: variant.isDefault,
            sortOrder: variant.sortOrder,
          },
          { transaction }
        );
      }

      for (let i = 0; i < uploadedImages.length; i += 1) {
        await ProductImage.create(
          {
            id: crypto.randomUUID(),
            productId,
            imageUrl: uploadedImages[i].imageUrl,
            imagePublicId: uploadedImages[i].imagePublicId,
            altText: payload.name.trim().slice(0, 160),
            isPrimary: i === 0,
            sortOrder: i,
          },
          { transaction }
        );
      }
    });

    return getProductById(productId);
  } catch (err) {
    for (const img of uploadedImages) {
      await mediaService.deleteImageByPublicId(img.imagePublicId);
    }
    if (uploadedCertificate?.certificatePublicId) {
      await mediaService.deleteAssetByPublicId(uploadedCertificate.certificatePublicId, {
        resourceType: uploadedCertificate.certificateResourceType,
      });
    }

    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(
        409,
        'PRODUCT_SLUG_EXISTS',
        'A product slug or variant SKU conflict occurred.'
      );
    }

    throw err;
  }
}

export async function updateProduct(id, payload) {
  const product = await Product.findByPk(id, {
    include: [
      { model: ProductVariant, as: 'variants', required: false },
      { model: ProductImage, as: 'images', required: false },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const nextName = payload.name !== undefined ? payload.name.trim() : product.name;
  const nextSlug =
    payload.slug !== undefined
      ? resolveAndValidateProductSlug(payload.slug, nextName)
      : product.slug;

  if (nextSlug !== product.slug) {
    await ensureProductSlugAvailable(nextSlug, product.id);
  }

  const nextProductType = payload.productType ?? product.productType;
  const nextStatus = payload.status ?? product.status;
  const nextCategoryId =
    payload.categoryId !== undefined ? payload.categoryId : product.categoryId;

  await validateCategoryAssignment(
    nextCategoryId,
    nextStatus === PRODUCT_STATUSES.ACTIVE
  );

  const nextGstRate =
    payload.gstRate !== undefined ? validateGstRate(payload.gstRate) : Number(product.gstRate);

  const nextVariantOptions =
    nextProductType === PRODUCT_TYPES.SIMPLE
      ? null
      : payload.variantOptions !== undefined
        ? payload.variantOptions
        : product.variantOptions;

  let normalizedVariants;
  if (payload.variants !== undefined) {
    normalizedVariants = normalizeAndValidateVariantsInput({
      productType: nextProductType,
      productSlug: nextSlug,
      variantOptions: nextVariantOptions,
      variantsInput: payload.variants,
    });
    await ensureSkusAvailableInDb(normalizedVariants, product.id);
  } else {
    normalizedVariants = (product.variants || []).map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      optionValues: v.optionValues,
      optionSignature: v.optionSignature,
      price: Number(v.price),
      salePrice: v.salePrice !== null ? Number(v.salePrice) : null,
      stockQuantity: Number(v.stockQuantity),
      lowStockThreshold: Number(v.lowStockThreshold),
      isActive: Boolean(v.isActive),
      isDefault: Boolean(v.isDefault),
      sortOrder: Number(v.sortOrder),
    }));
  }

  const currentImageCount = Array.isArray(product.images) ? product.images.length : 0;

  assertPublishRequirements({
    status: nextStatus,
    productType: nextProductType,
    categoryId: nextCategoryId,
    variantOptions: nextVariantOptions,
    variants: normalizedVariants,
    imageCount: currentImageCount,
  });

  await sequelize.transaction(async (transaction) => {
    const productUpdates = {
      name: nextName,
      slug: nextSlug,
      productType: nextProductType,
      status: nextStatus,
      categoryId: nextCategoryId,
      gstRate: nextGstRate,
      variantOptions: nextVariantOptions,
    };

    const optionalFields = [
      'shortDescription',
      'description',
      'traditionalSignificance',
      'wearingInstructions',
      'careInstructions',
      'specifications',
      'hsnCode',
      'certificateLabel',
      'weightGrams',
      'lengthCm',
      'widthCm',
      'heightCm',
      'shippingNotes',
      'isFeatured',
      'seoTitle',
      'seoDescription',
    ];

    for (const field of optionalFields) {
      if (payload[field] !== undefined) {
        productUpdates[field] = payload[field];
      }
    }

    if (nextStatus === PRODUCT_STATUSES.ACTIVE && !product.publishedAt) {
      productUpdates.publishedAt = new Date();
    }

    await product.update(productUpdates, { transaction });

    if (payload.variants !== undefined) {
      const existingVariants = product.variants || [];
      const incomingIds = new Set(
        normalizedVariants.map((v) => v.id).filter(Boolean)
      );

      // Soft-delete removed variants and clear optionSignature so combination can be reused
      for (const existing of existingVariants) {
        if (!incomingIds.has(existing.id)) {
          await existing.update({ optionSignature: null }, { transaction });
          await existing.destroy({ transaction });
        }
      }

      for (const variant of normalizedVariants) {
        const match = variant.id
          ? existingVariants.find((ev) => ev.id === variant.id)
          : null;

        if (match) {
          await match.update(
            {
              sku: variant.sku,
              title: variant.title,
              optionValues: variant.optionValues,
              optionSignature: variant.optionSignature,
              price: variant.price,
              salePrice: variant.salePrice,
              stockQuantity: variant.stockQuantity,
              lowStockThreshold: variant.lowStockThreshold,
              isActive: variant.isActive,
              isDefault: variant.isDefault,
              sortOrder: variant.sortOrder,
            },
            { transaction }
          );
        } else {
          await ProductVariant.create(
            {
              id: crypto.randomUUID(),
              productId: product.id,
              sku: variant.sku,
              title: variant.title,
              optionValues: variant.optionValues,
              optionSignature: variant.optionSignature,
              price: variant.price,
              salePrice: variant.salePrice,
              stockQuantity: variant.stockQuantity,
              lowStockThreshold: variant.lowStockThreshold,
              isActive: variant.isActive,
              isDefault: variant.isDefault,
              sortOrder: variant.sortOrder,
            },
            { transaction }
          );
        }
      }
    }
  });

  return getProductById(product.id);
}

export async function updateProductStatus(id, { status }) {
  const product = await Product.findByPk(id, {
    include: [
      { model: ProductVariant, as: 'variants', required: false },
      { model: ProductImage, as: 'images', required: false },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  if (status === PRODUCT_STATUSES.ACTIVE) {
    await validateCategoryAssignment(product.categoryId, true);
    assertPublishRequirements({
      status,
      productType: product.productType,
      categoryId: product.categoryId,
      variantOptions: product.variantOptions,
      variants: product.variants || [],
      imageCount: (product.images || []).length,
    });
  }

  const updates = { status };
  if (status === PRODUCT_STATUSES.ACTIVE && !product.publishedAt) {
    updates.publishedAt = new Date();
  }

  await product.update(updates);
  return getProductById(product.id);
}

export async function updateVariantStock(productId, variantId, payload) {
  const product = await Product.findByPk(productId, {
    include: [{ model: ProductVariant, as: 'variants', required: false }],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const variant = (product.variants || []).find((v) => v.id === variantId);
  if (!variant) {
    throw new AppError(404, 'VARIANT_NOT_FOUND', 'Product variant not found.');
  }

  if (
    payload.isActive === false &&
    product.status === PRODUCT_STATUSES.ACTIVE
  ) {
    const otherActiveCount = (product.variants || []).filter(
      (v) => v.id !== variantId && v.isActive
    ).length;
    if (otherActiveCount === 0) {
      throw new AppError(
        400,
        'PUBLISH_VALIDATION_FAILED',
        'An active product must retain at least one active variant.'
      );
    }
  }

  const updates = {};
  if (payload.stockQuantity !== undefined) {
    updates.stockQuantity = payload.stockQuantity;
  }
  if (payload.lowStockThreshold !== undefined) {
    updates.lowStockThreshold = payload.lowStockThreshold;
  }
  if (payload.isActive !== undefined) {
    updates.isActive = payload.isActive;
  }

  await variant.update(updates);
  return sanitizeVariant(variant);
}

export async function deleteProduct(id) {
  const product = await Product.findByPk(id, {
    include: [
      { model: ProductVariant, as: 'variants', required: false },
      { model: ProductImage, as: 'images', required: false },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const imagePublicIds = (product.images || [])
    .map((img) => img.imagePublicId)
    .filter(Boolean);
  const certPublicId = product.certificatePublicId;
  const certResourceType = product.certificateResourceType || 'image';

  await sequelize.transaction(async (transaction) => {
    for (const variant of product.variants || []) {
      await variant.update({ optionSignature: null }, { transaction });
      await variant.destroy({ transaction });
    }

    await ProductImage.destroy({
      where: { productId: product.id },
      transaction,
    });

    await product.update(
      {
        certificateUrl: null,
        certificatePublicId: null,
        certificateResourceType: null,
      },
      { transaction }
    );

    await product.destroy({ transaction });
  });

  for (const pubId of imagePublicIds) {
    await mediaService.deleteImageByPublicId(pubId);
  }

  if (certPublicId) {
    await mediaService.deleteAssetByPublicId(certPublicId, {
      resourceType: certResourceType,
    });
  }

  return { id: product.id, deleted: true };
}

export async function addProductImages(productId, files = [], body = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError(400, 'INVALID_IMAGE_FILE', 'At least one image file is required.');
  }

  const product = await Product.findByPk(productId, {
    include: [{ model: ProductImage, as: 'images', required: false }],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const existingImages = product.images || [];
  if (existingImages.length + files.length > MAX_PRODUCT_IMAGES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A product can have at most ${MAX_PRODUCT_IMAGES} images (currently ${existingImages.length}).`
    );
  }

  const uploaded = [];
  try {
    for (const file of files) {
      const res = await mediaService.uploadImageBuffer(file.buffer, {
        folder: CLOUDINARY_FOLDERS.PRODUCTS,
      });
      uploaded.push(res);
    }

    const hasPrimary = existingImages.some((img) => img.isPrimary);
    const maxSort = existingImages.reduce(
      (max, img) => Math.max(max, Number(img.sortOrder || 0)),
      -1
    );
    const defaultAlt =
      typeof body.altText === 'string' && body.altText.trim()
        ? body.altText.trim().slice(0, 160)
        : product.name.slice(0, 160);

    await sequelize.transaction(async (transaction) => {
      for (let i = 0; i < uploaded.length; i += 1) {
        await ProductImage.create(
          {
            id: crypto.randomUUID(),
            productId: product.id,
            imageUrl: uploaded[i].imageUrl,
            imagePublicId: uploaded[i].imagePublicId,
            altText: defaultAlt,
            isPrimary: !hasPrimary && i === 0,
            sortOrder: maxSort + 1 + i,
          },
          { transaction }
        );
      }
    });

    const allImages = await ProductImage.findAll({
      where: { productId: product.id },
      order: [
        ['is_primary', 'DESC'],
        ['sort_order', 'ASC'],
      ],
    });

    return allImages.map(sanitizeImage);
  } catch (err) {
    for (const img of uploaded) {
      await mediaService.deleteImageByPublicId(img.imagePublicId);
    }
    throw err;
  }
}

export async function updateProductImage(productId, imageId, payload) {
  const product = await Product.findByPk(productId);
  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const image = await ProductImage.findOne({
    where: { id: imageId, productId },
  });

  if (!image) {
    throw new AppError(404, 'IMAGE_NOT_FOUND', 'Product image not found.');
  }

  await sequelize.transaction(async (transaction) => {
    if (payload.isPrimary === true) {
      await ProductImage.update(
        { isPrimary: false },
        { where: { productId, id: { [Op.ne]: imageId } }, transaction }
      );
    }

    const updates = {};
    if (payload.altText !== undefined) {
      updates.altText = payload.altText;
    }
    if (payload.sortOrder !== undefined) {
      updates.sortOrder = payload.sortOrder;
    }
    if (payload.isPrimary === true) {
      updates.isPrimary = true;
    }

    await image.update(updates, { transaction });
  });

  return sanitizeImage(image);
}

export async function deleteProductImage(productId, imageId) {
  const product = await Product.findByPk(productId, {
    include: [{ model: ProductImage, as: 'images', required: false }],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const images = product.images || [];
  const target = images.find((img) => img.id === imageId);
  if (!target) {
    throw new AppError(404, 'IMAGE_NOT_FOUND', 'Product image not found.');
  }

  if (product.status === PRODUCT_STATUSES.ACTIVE && images.length <= 1) {
    throw new AppError(
      400,
      'CANNOT_REMOVE_LAST_IMAGE',
      'Cannot delete the only image of an active published product.'
    );
  }

  const oldPublicId = target.imagePublicId;
  const wasPrimary = Boolean(target.isPrimary);

  await sequelize.transaction(async (transaction) => {
    await target.destroy({ transaction });

    if (wasPrimary) {
      const remaining = images
        .filter((img) => img.id !== imageId)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      if (remaining.length > 0) {
        await remaining[0].update({ isPrimary: true }, { transaction });
      }
    }
  });

  if (oldPublicId) {
    await mediaService.deleteImageByPublicId(oldPublicId);
  }

  return { id: imageId, deleted: true };
}

export async function upsertProductCertificate(productId, file = null, payload = {}) {
  const product = await Product.findByPk(productId);
  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  if (!file?.buffer && !product.certificateUrl) {
    throw new AppError(
      400,
      'INVALID_CERTIFICATE_FILE',
      'A certificate image or PDF file is required.'
    );
  }

  const oldPublicId = product.certificatePublicId;
  const oldResourceType = product.certificateResourceType || 'image';
  let newCert = null;

  if (file?.buffer) {
    newCert = await mediaService.uploadCertificateBuffer(file.buffer, {
      mimetype: file.mimetype,
      folder: CLOUDINARY_FOLDERS.CERTIFICATES,
    });
  }

  const updates = {};
  if (newCert) {
    updates.certificateUrl = newCert.certificateUrl;
    updates.certificatePublicId = newCert.certificatePublicId;
    updates.certificateResourceType = newCert.certificateResourceType;
  }
  if (payload.certificateLabel !== undefined) {
    updates.certificateLabel = payload.certificateLabel;
  }

  try {
    await product.update(updates);
  } catch (err) {
    if (newCert?.certificatePublicId) {
      await mediaService.deleteAssetByPublicId(newCert.certificatePublicId, {
        resourceType: newCert.certificateResourceType,
      });
    }
    throw err;
  }

  if (newCert && oldPublicId && oldPublicId !== newCert.certificatePublicId) {
    await mediaService.deleteAssetByPublicId(oldPublicId, {
      resourceType: oldResourceType,
    });
  }

  return sanitizeCertificate(product);
}

export async function deleteProductCertificate(productId) {
  const product = await Product.findByPk(productId);
  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const oldPublicId = product.certificatePublicId;
  const oldResourceType = product.certificateResourceType || 'image';

  await product.update({
    certificateUrl: null,
    certificatePublicId: null,
    certificateResourceType: null,
    certificateLabel: null,
  });

  if (oldPublicId) {
    await mediaService.deleteAssetByPublicId(oldPublicId, {
      resourceType: oldResourceType,
    });
  }

  return { deleted: true };
}
