import crypto from 'node:crypto';
import { Op } from 'sequelize';
import {
  sequelize,
  Coupon,
  COUPON_VISIBILITIES,
} from '../models/index.js';
import { AppError } from '../utils/http.js';

export const COUPON_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const MAX_MONEY_MINOR = 9999999999; // 99,999,999.99 (DECIMAL(10, 2))

const DECIMAL_INPUT_REGEX = /^\d+(?:\.\d{1,2})?$/;

export function normalizeAndValidateCouponCode(rawCode) {
  if (typeof rawCode !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Coupon code is required.', [
      { field: 'code', message: 'Coupon code must be a string.' },
    ]);
  }

  const normalized = rawCode.trim().toUpperCase();
  if (!COUPON_CODE_REGEX.test(normalized)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Coupon code must be 3–32 characters using uppercase letters, numbers, hyphens, or underscores (starting with a letter or number).',
      [{ field: 'code', message: 'Invalid coupon code format.' }]
    );
  }

  return normalized;
}

export function formatMinorUnits(minor) {
  const num = Number(minor);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Invalid minor currency amount.');
  }
  const whole = Math.floor(num / 100);
  const frac = String(num % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

export function parseDecimalToMinorUnits(
  value,
  fieldName,
  { minMinor = 0, maxMinor = MAX_MONEY_MINOR } = {}
) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a valid decimal number.`, [
      { field: fieldName, message: 'Invalid numeric value.' },
    ]);
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a finite number.`, [
      { field: fieldName, message: 'Value must be finite.' },
    ]);
  }

  const str = String(value).trim();
  if (!DECIMAL_INPUT_REGEX.test(str)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be a non-negative number with at most 2 decimal places.`,
      [{ field: fieldName, message: 'Use up to 2 decimal places.' }]
    );
  }

  const [wholeStr, fracStr = ''] = str.split('.');
  const minor = Number(wholeStr) * 100 + Number(fracStr.padEnd(2, '0'));

  if (!Number.isSafeInteger(minor) || minor < minMinor || minor > maxMinor) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be between ${formatMinorUnits(minMinor)} and ${formatMinorUnits(maxMinor)}.`,
      [{ field: fieldName, message: 'Value out of allowed range.' }]
    );
  }

  return minor;
}

export function validateDiscountPercentage(rawPct) {
  const bps = parseDecimalToMinorUnits(rawPct, 'discountPercentage', {
    minMinor: 1,
    maxMinor: 10000,
  });

  return {
    bps,
    formatted: formatMinorUnits(bps),
  };
}

export function validateRegionalThresholds({ minCartSubtotal, maxDiscount }) {
  if (
    !minCartSubtotal ||
    typeof minCartSubtotal !== 'object' ||
    Array.isArray(minCartSubtotal)
  ) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'minCartSubtotal must specify both INR and USD amounts.',
      [{ field: 'minCartSubtotal', message: 'INR and USD minimum subtotals are required.' }]
    );
  }

  const minInrMinor = parseDecimalToMinorUnits(minCartSubtotal.INR, 'minCartSubtotal.INR', {
    minMinor: 0,
  });
  const minUsdMinor = parseDecimalToMinorUnits(minCartSubtotal.USD, 'minCartSubtotal.USD', {
    minMinor: 0,
  });

  if (maxDiscount === null || maxDiscount === undefined) {
    return {
      minCartSubtotalInr: formatMinorUnits(minInrMinor),
      minCartSubtotalUsd: formatMinorUnits(minUsdMinor),
      maxDiscountInr: null,
      maxDiscountUsd: null,
    };
  }

  if (typeof maxDiscount !== 'object' || Array.isArray(maxDiscount)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'maxDiscount must be null or an object with INR and USD caps.',
      [{ field: 'maxDiscount', message: 'Invalid maxDiscount object.' }]
    );
  }

  const hasInr =
    maxDiscount.INR !== undefined && maxDiscount.INR !== null && maxDiscount.INR !== '';
  const hasUsd =
    maxDiscount.USD !== undefined && maxDiscount.USD !== null && maxDiscount.USD !== '';

  if (!hasInr && !hasUsd) {
    return {
      minCartSubtotalInr: formatMinorUnits(minInrMinor),
      minCartSubtotalUsd: formatMinorUnits(minUsdMinor),
      maxDiscountInr: null,
      maxDiscountUsd: null,
    };
  }

  if (!hasInr || !hasUsd) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Both INR and USD maximum discount caps must be provided when capping a coupon.',
      [{ field: 'maxDiscount', message: 'Both maxDiscount.INR and maxDiscount.USD are required.' }]
    );
  }

  const maxInrMinor = parseDecimalToMinorUnits(maxDiscount.INR, 'maxDiscount.INR', {
    minMinor: 1,
  });
  const maxUsdMinor = parseDecimalToMinorUnits(maxDiscount.USD, 'maxDiscount.USD', {
    minMinor: 1,
  });

  return {
    minCartSubtotalInr: formatMinorUnits(minInrMinor),
    minCartSubtotalUsd: formatMinorUnits(minUsdMinor),
    maxDiscountInr: formatMinorUnits(maxInrMinor),
    maxDiscountUsd: formatMinorUnits(maxUsdMinor),
  };
}

export function calculatePercentageDiscountMinor({
  subtotalMinor,
  discountPercentage,
  maxDiscountMinor = null,
}) {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'subtotalMinor must be a non-negative integer.');
  }

  const pctBps = BigInt(
    parseDecimalToMinorUnits(discountPercentage, 'discountPercentage', {
      minMinor: 1,
      maxMinor: 10000,
    })
  );
  const sub = BigInt(subtotalMinor);

  // Deterministic half-up rounding in integer minor units (100.00% = 10000 bps)
  let disc = (sub * pctBps + 5000n) / 10000n;

  if (maxDiscountMinor !== null && maxDiscountMinor !== undefined) {
    if (!Number.isSafeInteger(maxDiscountMinor) || maxDiscountMinor < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'maxDiscountMinor must be a non-negative integer.');
    }
    const cap = BigInt(maxDiscountMinor);
    if (disc > cap) {
      disc = cap;
    }
  }

  if (disc > sub) {
    disc = sub;
  }

  const finalSub = sub - disc;
  const discountMinor = Number(disc);
  const finalSubtotalMinor = Number(finalSub);

  return {
    discountMinor,
    finalSubtotalMinor,
    discountAmount: formatMinorUnits(discountMinor),
    finalSubtotal: formatMinorUnits(finalSubtotalMinor),
  };
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : null;
}

export function sanitizeCoupon(couponInstance, now = new Date()) {
  if (!couponInstance) return null;

  const plain =
    typeof couponInstance.get === 'function'
      ? couponInstance.get({ plain: true })
      : couponInstance;

  const rawExpiresAt = plain.expiresAt ?? plain.expires_at ?? null;
  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;

  const expiresDate = rawExpiresAt ? new Date(rawExpiresAt) : null;
  const isActive = Boolean(plain.isActive ?? plain.is_active ?? true);

  const rawMaxRedemptions = plain.maxRedemptions ?? plain.max_redemptions ?? null;
  const maxRedemptions =
    rawMaxRedemptions !== null && rawMaxRedemptions !== undefined
      ? Number(rawMaxRedemptions)
      : null;
  const redemptionCount = Number(plain.redemptionCount ?? plain.redemption_count ?? 0);

  const isExpired = Boolean(expiresDate && expiresDate <= now);
  const isExhausted = maxRedemptions !== null && redemptionCount >= maxRedemptions;
  const remainingRedemptions =
    maxRedemptions === null ? null : Math.max(0, maxRedemptions - redemptionCount);

  let effectiveStatus = 'active';
  if (!isActive) {
    effectiveStatus = 'inactive';
  } else if (isExpired) {
    effectiveStatus = 'expired';
  } else if (isExhausted) {
    effectiveStatus = 'exhausted';
  }

  const maxInr = formatMoney(plain.maxDiscountInr ?? plain.max_discount_inr);
  const maxUsd = formatMoney(plain.maxDiscountUsd ?? plain.max_discount_usd);

  return {
    id: plain.id,
    code: plain.code,
    description: plain.description ?? null,
    discountType: 'percentage',
    discountPercentage: formatMoney(
      plain.discountPercentage ?? plain.discount_percentage ?? 0
    ),
    minCartSubtotal: {
      INR: formatMoney(plain.minCartSubtotalInr ?? plain.min_cart_subtotal_inr ?? 0),
      USD: formatMoney(plain.minCartSubtotalUsd ?? plain.min_cart_subtotal_usd ?? 0),
    },
    maxDiscount:
      maxInr !== null && maxUsd !== null
        ? {
            INR: maxInr,
            USD: maxUsd,
          }
        : null,
    maxRedemptions,
    redemptionCount,
    remainingRedemptions,
    visibility: plain.visibility || COUPON_VISIBILITIES.PUBLIC,
    isActive,
    expiresAt: expiresDate ? expiresDate.toISOString() : null,
    isExpired,
    isExhausted,
    effectiveStatus,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
  };
}

function parseFutureExpiry(rawExpiresAt) {
  if (rawExpiresAt === null || rawExpiresAt === undefined || rawExpiresAt === '') {
    return null;
  }

  const date = rawExpiresAt instanceof Date ? rawExpiresAt : new Date(rawExpiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'expiresAt must be a valid ISO 8601 datetime.', [
      { field: 'expiresAt', message: 'Invalid expiresAt datetime.' },
    ]);
  }

  if (date <= new Date()) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Expiration date (expiresAt) must be in the future.',
      [{ field: 'expiresAt', message: 'expiresAt must be in the future.' }]
    );
  }

  return date;
}

async function ensureCouponCodeAvailable(code, excludeId = null) {
  const existing = await Coupon.findOne({
    where: { code },
    paranoid: false,
  });

  if (existing && existing.id !== excludeId) {
    throw new AppError(
      409,
      'COUPON_CODE_EXISTS',
      `A coupon with code "${code}" already exists.`
    );
  }
}

export async function listCoupons({
  page = 1,
  limit = 20,
  search = '',
  isActive,
  visibility,
  status,
  sortBy = 'createdAt',
  sortOrder = 'desc',
} = {}) {
  const where = {};
  const andConditions = [];
  const now = new Date();

  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  if (visibility) {
    where.visibility = visibility;
  }

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const pattern = `%${trimmedSearch}%`;
    andConditions.push({
      [Op.or]: [
        { code: { [Op.like]: pattern } },
        { description: { [Op.like]: pattern } },
      ],
    });
  }

  if (status === 'inactive') {
    andConditions.push({ isActive: false });
  } else if (status === 'expired') {
    andConditions.push({ expiresAt: { [Op.not]: null, [Op.lte]: now } });
  } else if (status === 'exhausted') {
    andConditions.push(
      sequelize.literal(
        'Coupon.max_redemptions IS NOT NULL AND Coupon.redemption_count >= Coupon.max_redemptions'
      )
    );
  } else if (status === 'active') {
    andConditions.push(
      { isActive: true },
      { [Op.or]: [{ expiresAt: { [Op.is]: null } }, { expiresAt: { [Op.gt]: now } }] },
      sequelize.literal(
        '(Coupon.max_redemptions IS NULL OR Coupon.redemption_count < Coupon.max_redemptions)'
      )
    );
  }

  if (andConditions.length > 0) {
    where[Op.and] = andConditions;
  }

  const sortColumnMap = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    code: 'code',
    discountPercentage: 'discount_percentage',
    expiresAt: 'expires_at',
    redemptionCount: 'redemption_count',
  };
  const orderCol = sortColumnMap[sortBy] || 'created_at';
  const orderDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;

  const { rows, count } = await Coupon.findAndCountAll({
    where,
    order: [[orderCol, orderDir]],
    limit,
    offset,
  });

  return {
    items: rows.map((row) => sanitizeCoupon(row, now)),
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
}

export async function getCouponById(id) {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(404, 'COUPON_NOT_FOUND', 'Coupon not found.');
  }

  return sanitizeCoupon(coupon);
}

export async function createCoupon(payload) {
  const code = normalizeAndValidateCouponCode(payload.code);
  const { formatted: discountPercentage } = validateDiscountPercentage(
    payload.discountPercentage
  );
  const thresholds = validateRegionalThresholds({
    minCartSubtotal: payload.minCartSubtotal,
    maxDiscount: payload.maxDiscount ?? null,
  });

  const expiresAt = parseFutureExpiry(payload.expiresAt ?? null);

  await ensureCouponCodeAvailable(code);

  try {
    const created = await Coupon.create({
      id: crypto.randomUUID(),
      code,
      description: payload.description ?? null,
      discountPercentage,
      minCartSubtotalInr: thresholds.minCartSubtotalInr,
      minCartSubtotalUsd: thresholds.minCartSubtotalUsd,
      maxDiscountInr: thresholds.maxDiscountInr,
      maxDiscountUsd: thresholds.maxDiscountUsd,
      maxRedemptions: payload.maxRedemptions ?? null,
      redemptionCount: 0,
      visibility: payload.visibility || COUPON_VISIBILITIES.PUBLIC,
      isActive: payload.isActive ?? true,
      expiresAt,
    });

    return getCouponById(created.id);
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(
        409,
        'COUPON_CODE_EXISTS',
        `A coupon with code "${code}" already exists.`
      );
    }
    throw err;
  }
}

export async function updateCoupon(id, payload) {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(404, 'COUPON_NOT_FOUND', 'Coupon not found.');
  }

  const updates = {};

  if (payload.code !== undefined) {
    const nextCode = normalizeAndValidateCouponCode(payload.code);
    if (nextCode !== coupon.code) {
      if (Number(coupon.redemptionCount || 0) > 0) {
        throw new AppError(
          409,
          'COUPON_CODE_LOCKED',
          'Coupon code cannot be modified after it has already been redeemed.'
        );
      }
      await ensureCouponCodeAvailable(nextCode, coupon.id);
      updates.code = nextCode;
    }
  }

  if (payload.description !== undefined) {
    updates.description = payload.description;
  }

  if (payload.discountPercentage !== undefined) {
    const { formatted } = validateDiscountPercentage(payload.discountPercentage);
    updates.discountPercentage = formatted;
  }

  if (payload.minCartSubtotal !== undefined || payload.maxDiscount !== undefined) {
    const mergedMin =
      payload.minCartSubtotal !== undefined
        ? {
            INR:
              payload.minCartSubtotal.INR !== undefined
                ? payload.minCartSubtotal.INR
                : Number(coupon.minCartSubtotalInr),
            USD:
              payload.minCartSubtotal.USD !== undefined
                ? payload.minCartSubtotal.USD
                : Number(coupon.minCartSubtotalUsd),
          }
        : {
            INR: Number(coupon.minCartSubtotalInr),
            USD: Number(coupon.minCartSubtotalUsd),
          };

    let mergedMax;
    if (payload.maxDiscount === null) {
      mergedMax = null;
    } else if (payload.maxDiscount !== undefined) {
      mergedMax = {
        INR:
          payload.maxDiscount.INR !== undefined
            ? payload.maxDiscount.INR
            : coupon.maxDiscountInr !== null
              ? Number(coupon.maxDiscountInr)
              : null,
        USD:
          payload.maxDiscount.USD !== undefined
            ? payload.maxDiscount.USD
            : coupon.maxDiscountUsd !== null
              ? Number(coupon.maxDiscountUsd)
              : null,
      };
    } else {
      mergedMax =
        coupon.maxDiscountInr !== null && coupon.maxDiscountUsd !== null
          ? {
              INR: Number(coupon.maxDiscountInr),
              USD: Number(coupon.maxDiscountUsd),
            }
          : null;
    }

    const thresholds = validateRegionalThresholds({
      minCartSubtotal: mergedMin,
      maxDiscount: mergedMax,
    });

    updates.minCartSubtotalInr = thresholds.minCartSubtotalInr;
    updates.minCartSubtotalUsd = thresholds.minCartSubtotalUsd;
    updates.maxDiscountInr = thresholds.maxDiscountInr;
    updates.maxDiscountUsd = thresholds.maxDiscountUsd;
  }

  if (payload.maxRedemptions !== undefined) {
    if (
      payload.maxRedemptions !== null &&
      payload.maxRedemptions < Number(coupon.redemptionCount || 0)
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `maxRedemptions cannot be less than current redemptionCount (${coupon.redemptionCount}).`,
        [{ field: 'maxRedemptions', message: 'Cannot be below existing redemptionCount.' }]
      );
    }
    updates.maxRedemptions = payload.maxRedemptions;
  }

  if (payload.visibility !== undefined) {
    updates.visibility = payload.visibility;
  }

  if (payload.isActive !== undefined) {
    updates.isActive = payload.isActive;
  }

  if (payload.expiresAt !== undefined) {
    updates.expiresAt = parseFutureExpiry(payload.expiresAt);
  }

  try {
    await coupon.update(updates);
    return getCouponById(coupon.id);
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new AppError(
        409,
        'COUPON_CODE_EXISTS',
        `A coupon with code "${updates.code}" already exists.`
      );
    }
    throw err;
  }
}

export async function updateCouponStatus(id, { isActive }) {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(404, 'COUPON_NOT_FOUND', 'Coupon not found.');
  }

  await coupon.update({ isActive: Boolean(isActive) });
  return getCouponById(coupon.id);
}

export async function deleteCoupon(id) {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(404, 'COUPON_NOT_FOUND', 'Coupon not found.');
  }

  await sequelize.transaction(async (transaction) => {
    await coupon.update({ isActive: false }, { transaction });
    await coupon.destroy({ transaction });
  });

  return { id: coupon.id, deleted: true };
}
