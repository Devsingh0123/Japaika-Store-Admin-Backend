import crypto from 'node:crypto';
import { Op } from 'sequelize';
import {
  sequelize,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  PRODUCT_TYPES,
  PRODUCT_STATUSES,
  ALLOWED_GST_RATES,
  PRODUCT_MEDIA_TYPES,
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
} from '../models/index.js';
import mediaService, { CLOUDINARY_FOLDERS } from './media.service.js';
import {
  MAX_PRODUCT_MEDIA,
  ALLOWED_IMAGE_MIME_TYPES,
} from '../middlewares/upload.middleware.js';
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

function parseJsonField(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export function normalizeAndValidatePrices(rawPrices) {
  if (rawPrices === null || rawPrices === undefined) {
    return {};
  }

  const parsed = typeof rawPrices === 'string' ? parseJsonField(rawPrices, null) : rawPrices;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Variant prices must be an object keyed by country code.',
      [{ field: 'variants.prices', message: 'Invalid prices object.' }]
    );
  }

  const normalized = {};

  for (const [rawCountry, rawEntry] of Object.entries(parsed)) {
    const country = String(rawCountry || '').trim().toUpperCase();
    const market = SUPPORTED_MARKETS[country];

    if (!market) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Unsupported pricing country "${rawCountry}". Supported countries: ${SUPPORTED_COUNTRIES.join(', ')}.`,
        [{ field: `prices.${rawCountry}`, message: 'Unsupported market country.' }]
      );
    }

    if (rawEntry === null || rawEntry === undefined) {
      continue;
    }

    if (typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Pricing entry for ${country} must be an object.`,
        [{ field: `prices.${country}`, message: 'Invalid market pricing object.' }]
      );
    }

    if (
      rawEntry.currency !== undefined &&
      rawEntry.currency !== null &&
      String(rawEntry.currency).trim() !== ''
    ) {
      const currency = String(rawEntry.currency).trim().toUpperCase();
      if (currency !== market.currency) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `Currency for ${country} must be ${market.currency}.`,
          [{ field: `prices.${country}.currency`, message: `Expected ${market.currency}.` }]
        );
      }
    }

    const rawPrice = rawEntry.price;
    const price = Number(rawPrice);
    if (
      rawPrice === undefined ||
      rawPrice === null ||
      rawPrice === '' ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Regular price for ${country} must be a non-negative number.`,
        [{ field: `prices.${country}.price`, message: 'Invalid regular price.' }]
      );
    }

    const roundedPrice = Number(price.toFixed(2));
    let salePrice = null;

    if (
      rawEntry.salePrice !== null &&
      rawEntry.salePrice !== undefined &&
      rawEntry.salePrice !== ''
    ) {
      const sale = Number(rawEntry.salePrice);
      if (!Number.isFinite(sale) || sale <= 0 || sale >= roundedPrice) {
        throw new AppError(
          400,
          'INVALID_SALE_PRICE',
          `Sale price for ${country} must be greater than 0 and strictly less than regular price.`,
          [{ field: `prices.${country}.salePrice`, message: 'Invalid sale price.' }]
        );
      }
      salePrice = Number(sale.toFixed(2));
    }

    normalized[country] = {
      currency: market.currency,
      price: roundedPrice,
      salePrice,
    };
  }

  return normalized;
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

  const rawPrices = parseJsonField(plain.prices, {});
  const prices = {};

  for (const country of SUPPORTED_COUNTRIES) {
    const entry = rawPrices?.[country];
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const price = Number(Number(entry.price ?? 0).toFixed(2));
    const rawSale =
      entry.salePrice !== null && entry.salePrice !== undefined && entry.salePrice !== ''
        ? Number(Number(entry.salePrice).toFixed(2))
        : null;
    const salePrice =
      rawSale !== null && Number.isFinite(rawSale) && rawSale > 0 && rawSale < price
        ? rawSale
        : null;
    const effectivePrice = salePrice !== null ? salePrice : price;

    prices[country] = {
      currency: SUPPORTED_MARKETS[country].currency,
      price,
      salePrice,
      effectivePrice,
    };
  }

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
    optionValues: parseJsonField(plain.optionValues ?? plain.option_values, null),
    optionSignature: plain.optionSignature ?? plain.option_signature ?? null,
    prices,
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

export function sanitizeMediaItem(mediaInstance) {
  if (!mediaInstance) return null;
  const plain =
    typeof mediaInstance.get === 'function'
      ? mediaInstance.get({ plain: true })
      : mediaInstance;

  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const rawDuration = plain.durationSeconds ?? plain.duration_seconds ?? null;

  return {
    id: plain.id,
    productId: plain.productId ?? plain.product_id,
    mediaType: plain.mediaType ?? plain.media_type ?? PRODUCT_MEDIA_TYPES.IMAGE,
    mediaUrl: plain.mediaUrl ?? plain.media_url,
    mediaPublicId: plain.mediaPublicId ?? plain.media_public_id,
    thumbnailUrl: plain.thumbnailUrl ?? plain.thumbnail_url ?? null,
    mimeType: plain.mimeType ?? plain.mime_type ?? null,
    durationSeconds:
      rawDuration !== null && rawDuration !== undefined ? Number(rawDuration) : null,
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

  const media = Array.isArray(plain.media)
    ? [...plain.media]
        .map(sanitizeMediaItem)
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
    specifications: parseJsonField(plain.specifications, []),
    variantOptions: parseJsonField(plain.variantOptions ?? plain.variant_options, null),
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
    media,
    variants,
  };
}

export function sanitizeProductListItem(productInstance) {
  const detail = sanitizeProductDetail(productInstance);
  const activeVariants = detail.variants.filter((v) => v.isActive);
  const pricePool = activeVariants.length > 0 ? activeVariants : detail.variants;

  const priceSummary = {};
  for (const country of SUPPORTED_COUNTRIES) {
    const marketPrices = pricePool
      .map((v) => v.prices?.[country])
      .filter((entry) => entry && Number(entry.price) > 0)
      .map((entry) => Number(entry.effectivePrice));

    if (marketPrices.length > 0) {
      priceSummary[country] = {
        currency: SUPPORTED_MARKETS[country].currency,
        minPrice: Math.min(...marketPrices).toFixed(2),
        maxPrice: Math.max(...marketPrices).toFixed(2),
      };
    }
  }

  const totalStock = pricePool.reduce((sum, v) => sum + v.stockQuantity, 0);
  const hasLowStock = pricePool.some((v) => v.stockQuantity <= v.lowStockThreshold);

  const primaryImageItem =
    detail.media.find((m) => m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE && m.isPrimary) ||
    detail.media.find((m) => m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE) ||
    null;

  const primaryImage = primaryImageItem
    ? {
        id: primaryImageItem.id,
        imageUrl: primaryImageItem.mediaUrl,
        altText: primaryImageItem.altText,
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
    priceSummary,
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

    const prices = normalizeAndValidatePrices(raw.prices);

    return [
      {
        id: raw.id || undefined,
        sku: normalizeSku(raw.sku, productSlug, 0),
        title: raw.title ? String(raw.title).trim() : 'Default',
        optionValues: null,
        optionSignature: 'default',
        prices,
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

    const prices = normalizeAndValidatePrices(raw.prices);
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
      prices,
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
      field: 'media',
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
    const variantPrices = parseJsonField(v.prices, {});
    const hasPositiveMarketPrice = SUPPORTED_COUNTRIES.some(
      (code) => Number(variantPrices?.[code]?.price) > 0
    );

    if (!hasPositiveMarketPrice) {
      issues.push({
        field: 'variants.prices',
        message: `Active variant "${v.sku}" must have a regular price greater than 0 for at least one supported market (${SUPPORTED_COUNTRIES.join(', ')}) to publish.`,
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
  country,
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
        model: ProductMedia,
        as: 'media',
        required: false,
      },
    ],
    order: [[orderCol, orderDir]],
  });

  let items = allMatches.map(sanitizeProductListItem);

  if (country) {
    items = items.filter((item) => Boolean(item.priceSummary?.[country]));
  }

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
        model: ProductMedia,
        as: 'media',
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

  const mediaFiles = Array.isArray(files.media) ? files.media : [];
  if (mediaFiles.length > MAX_PRODUCT_MEDIA) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A product can have at most ${MAX_PRODUCT_MEDIA} media items.`
    );
  }

  const uploadedImageCount = mediaFiles.filter((file) =>
    ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)
  ).length;

  assertPublishRequirements({
    status,
    productType,
    categoryId: payload.categoryId ?? null,
    variantOptions,
    variants: normalizedVariants,
    imageCount: uploadedImageCount,
  });

  const uploadedMedia = [];
  let uploadedCertificate = null;

  try {
    for (const file of mediaFiles) {
      const uploaded = await mediaService.uploadProductMediaBuffer(file.buffer, {
        mimetype: file.mimetype,
        folder: CLOUDINARY_FOLDERS.PRODUCTS,
      });
      uploadedMedia.push(uploaded);
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
            prices: variant.prices,
            stockQuantity: variant.stockQuantity,
            lowStockThreshold: variant.lowStockThreshold,
            isActive: variant.isActive,
            isDefault: variant.isDefault,
            sortOrder: variant.sortOrder,
          },
          { transaction }
        );
      }

      let primaryAssigned = false;
      for (let i = 0; i < uploadedMedia.length; i += 1) {
        const item = uploadedMedia[i];
        const isPrimary =
          !primaryAssigned && item.mediaType === PRODUCT_MEDIA_TYPES.IMAGE;
        if (isPrimary) {
          primaryAssigned = true;
        }

        await ProductMedia.create(
          {
            id: crypto.randomUUID(),
            productId,
            mediaType: item.mediaType,
            mediaUrl: item.mediaUrl,
            mediaPublicId: item.mediaPublicId,
            thumbnailUrl: item.thumbnailUrl,
            mimeType: item.mimeType,
            durationSeconds: item.durationSeconds,
            altText: payload.name.trim().slice(0, 160),
            isPrimary,
            sortOrder: i,
          },
          { transaction }
        );
      }
    });

    return getProductById(productId);
  } catch (err) {
    for (const item of uploadedMedia) {
      await mediaService.deleteAssetByPublicId(item.mediaPublicId, {
        resourceType: item.mediaType,
      });
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
      { model: ProductMedia, as: 'media', required: false },
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
        : parseJsonField(product.variantOptions, null);

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
      prices: parseJsonField(v.prices, {}),
      stockQuantity: Number(v.stockQuantity),
      lowStockThreshold: Number(v.lowStockThreshold),
      isActive: Boolean(v.isActive),
      isDefault: Boolean(v.isDefault),
      sortOrder: Number(v.sortOrder),
    }));
  }

  const currentImageCount = Array.isArray(product.media)
    ? product.media.filter((m) => m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE).length
    : 0;

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
              prices: variant.prices,
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
              prices: variant.prices,
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
      { model: ProductMedia, as: 'media', required: false },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  if (status === PRODUCT_STATUSES.ACTIVE) {
    await validateCategoryAssignment(product.categoryId, true);
    const currentImageCount = (product.media || []).filter(
      (m) => m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE
    ).length;

    assertPublishRequirements({
      status,
      productType: product.productType,
      categoryId: product.categoryId,
      variantOptions: parseJsonField(product.variantOptions, null),
      variants: product.variants || [],
      imageCount: currentImageCount,
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
      { model: ProductMedia, as: 'media', required: false },
    ],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const mediaAssetsToCleanup = (product.media || [])
    .filter((m) => Boolean(m.mediaPublicId))
    .map((m) => ({
      publicId: m.mediaPublicId,
      resourceType: m.mediaType || PRODUCT_MEDIA_TYPES.IMAGE,
    }));

  const certPublicId = product.certificatePublicId;
  const certResourceType = product.certificateResourceType || 'image';

  await sequelize.transaction(async (transaction) => {
    for (const variant of product.variants || []) {
      await variant.update({ optionSignature: null }, { transaction });
      await variant.destroy({ transaction });
    }

    await ProductMedia.destroy({
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

  for (const asset of mediaAssetsToCleanup) {
    await mediaService.deleteAssetByPublicId(asset.publicId, {
      resourceType: asset.resourceType,
    });
  }

  if (certPublicId) {
    await mediaService.deleteAssetByPublicId(certPublicId, {
      resourceType: certResourceType,
    });
  }

  return { id: product.id, deleted: true };
}

export async function addProductMedia(productId, files = [], body = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError(
      400,
      'INVALID_MEDIA_FILE',
      'At least one image or short video file is required.'
    );
  }

  const product = await Product.findByPk(productId, {
    include: [{ model: ProductMedia, as: 'media', required: false }],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const existingMedia = product.media || [];
  if (existingMedia.length + files.length > MAX_PRODUCT_MEDIA) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A product can have at most ${MAX_PRODUCT_MEDIA} media items (currently ${existingMedia.length}).`
    );
  }

  const uploaded = [];
  try {
    for (const file of files) {
      const res = await mediaService.uploadProductMediaBuffer(file.buffer, {
        mimetype: file.mimetype,
        folder: CLOUDINARY_FOLDERS.PRODUCTS,
      });
      uploaded.push(res);
    }

    let hasPrimaryImage = existingMedia.some(
      (m) => m.isPrimary && m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE
    );
    const maxSort = existingMedia.reduce(
      (max, m) => Math.max(max, Number(m.sortOrder || 0)),
      -1
    );
    const defaultAlt =
      typeof body.altText === 'string' && body.altText.trim()
        ? body.altText.trim().slice(0, 160)
        : product.name.slice(0, 160);

    await sequelize.transaction(async (transaction) => {
      for (let i = 0; i < uploaded.length; i += 1) {
        const item = uploaded[i];
        const isPrimary =
          !hasPrimaryImage && item.mediaType === PRODUCT_MEDIA_TYPES.IMAGE;
        if (isPrimary) {
          hasPrimaryImage = true;
        }

        await ProductMedia.create(
          {
            id: crypto.randomUUID(),
            productId: product.id,
            mediaType: item.mediaType,
            mediaUrl: item.mediaUrl,
            mediaPublicId: item.mediaPublicId,
            thumbnailUrl: item.thumbnailUrl,
            mimeType: item.mimeType,
            durationSeconds: item.durationSeconds,
            altText: defaultAlt,
            isPrimary,
            sortOrder: maxSort + 1 + i,
          },
          { transaction }
        );
      }
    });

    const allMedia = await ProductMedia.findAll({
      where: { productId: product.id },
      order: [
        ['is_primary', 'DESC'],
        ['sort_order', 'ASC'],
      ],
    });

    return allMedia.map(sanitizeMediaItem);
  } catch (err) {
    for (const item of uploaded) {
      await mediaService.deleteAssetByPublicId(item.mediaPublicId, {
        resourceType: item.mediaType,
      });
    }
    throw err;
  }
}

export async function updateProductMedia(productId, mediaId, payload) {
  const product = await Product.findByPk(productId);
  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const mediaItem = await ProductMedia.findOne({
    where: { id: mediaId, productId },
  });

  if (!mediaItem) {
    throw new AppError(404, 'MEDIA_NOT_FOUND', 'Product media item not found.');
  }

  if (
    payload.isPrimary === true &&
    mediaItem.mediaType !== PRODUCT_MEDIA_TYPES.IMAGE
  ) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Only image media items can be set as the primary product image.',
      [{ field: 'isPrimary', message: 'Videos cannot be set as primary product image.' }]
    );
  }

  await sequelize.transaction(async (transaction) => {
    if (payload.isPrimary === true) {
      await ProductMedia.update(
        { isPrimary: false },
        { where: { productId, id: { [Op.ne]: mediaId } }, transaction }
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

    await mediaItem.update(updates, { transaction });
  });

  return sanitizeMediaItem(mediaItem);
}

export async function deleteProductMedia(productId, mediaId) {
  const product = await Product.findByPk(productId, {
    include: [{ model: ProductMedia, as: 'media', required: false }],
  });

  if (!product) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  }

  const mediaList = product.media || [];
  const target = mediaList.find((m) => m.id === mediaId);
  if (!target) {
    throw new AppError(404, 'MEDIA_NOT_FOUND', 'Product media item not found.');
  }

  const imageItems = mediaList.filter((m) => m.mediaType === PRODUCT_MEDIA_TYPES.IMAGE);
  if (
    product.status === PRODUCT_STATUSES.ACTIVE &&
    target.mediaType === PRODUCT_MEDIA_TYPES.IMAGE &&
    imageItems.length <= 1
  ) {
    throw new AppError(
      400,
      'CANNOT_REMOVE_LAST_IMAGE',
      'Cannot delete the only image of an active published product.'
    );
  }

  const oldPublicId = target.mediaPublicId;
  const oldMediaType = target.mediaType || PRODUCT_MEDIA_TYPES.IMAGE;
  const wasPrimary = Boolean(target.isPrimary);

  await sequelize.transaction(async (transaction) => {
    await target.destroy({ transaction });

    if (wasPrimary) {
      const remainingImages = imageItems
        .filter((m) => m.id !== mediaId)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      if (remainingImages.length > 0) {
        await remainingImages[0].update({ isPrimary: true }, { transaction });
      }
    }
  });

  if (oldPublicId) {
    await mediaService.deleteAssetByPublicId(oldPublicId, {
      resourceType: oldMediaType,
    });
  }

  return { id: mediaId, deleted: true };
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
