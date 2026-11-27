import {
  sequelize,
  ShippingSetting,
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
} from '../models/index.js';
import { parseDecimalToMinorUnits, formatMinorUnits } from './coupon.service.js';
import { AppError } from '../utils/http.js';

export const MAX_ESTIMATED_DAYS = 90;

function logShippingAudit(action, admin, targetCountry, before, after) {
  if (process.env.NODE_ENV === 'test') return;
  console.info(
    JSON.stringify({
      type: 'admin_audit',
      domain: 'shipping_settings',
      action,
      targetCountry,
      adminId: admin?.id ?? null,
      adminRole: admin?.role ?? null,
      before,
      after,
      timestamp: new Date().toISOString(),
    })
  );
}

export function normalizeSupportedCountry(rawCountry) {
  const normalized = typeof rawCountry === 'string' ? rawCountry.trim().toUpperCase() : '';
  if (!normalized || !Object.prototype.hasOwnProperty.call(SUPPORTED_MARKETS, normalized)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Unsupported country "${rawCountry ?? ''}". Supported countries: ${SUPPORTED_COUNTRIES.join(', ')}.`,
      [{ field: 'country', message: `Country must be one of: ${SUPPORTED_COUNTRIES.join(', ')}.` }]
    );
  }
  return normalized;
}

export function validateEstimatedDaysRange(minDays, maxDays) {
  const hasMin = minDays !== null && minDays !== undefined;
  const hasMax = maxDays !== null && maxDays !== undefined;

  if (!hasMin && !hasMax) {
    return { estimatedDaysMin: null, estimatedDaysMax: null };
  }

  if (hasMin !== hasMax) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Both estimatedDaysMin and estimatedDaysMax must be provided together, or both set to null.',
      [
        {
          field: hasMin ? 'estimatedDaysMax' : 'estimatedDaysMin',
          message: 'Both estimated delivery day bounds are required when one is specified.',
        },
      ]
    );
  }

  const min = Number(minDays);
  const max = Number(maxDays);

  if (!Number.isInteger(min) || min < 1 || min > MAX_ESTIMATED_DAYS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `estimatedDaysMin must be an integer between 1 and ${MAX_ESTIMATED_DAYS}.`,
      [{ field: 'estimatedDaysMin', message: 'Invalid minimum estimated days.' }]
    );
  }

  if (!Number.isInteger(max) || max < 1 || max > MAX_ESTIMATED_DAYS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `estimatedDaysMax must be an integer between 1 and ${MAX_ESTIMATED_DAYS}.`,
      [{ field: 'estimatedDaysMax', message: 'Invalid maximum estimated days.' }]
    );
  }

  if (min > max) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'estimatedDaysMin cannot be greater than estimatedDaysMax.',
      [{ field: 'estimatedDaysMin', message: 'Minimum days must be less than or equal to maximum days.' }]
    );
  }

  return { estimatedDaysMin: min, estimatedDaysMax: max };
}

export function sanitizeShippingSetting(instance) {
  if (!instance) return null;

  const plain = typeof instance.get === 'function' ? instance.get({ plain: true }) : instance;
  const flatMinor = parseDecimalToMinorUnits(
    String(plain.flatCharge ?? plain.flat_charge ?? '0'),
    'flatCharge',
    { minMinor: 0 }
  );

  const rawThreshold = plain.freeShippingThreshold ?? plain.free_shipping_threshold ?? null;
  const thresholdMinor =
    rawThreshold !== null && rawThreshold !== undefined && rawThreshold !== ''
      ? parseDecimalToMinorUnits(String(rawThreshold), 'freeShippingThreshold', { minMinor: 0 })
      : null;

  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;

  return {
    id: plain.id,
    country: plain.country,
    currency: plain.currency,
    flatCharge: formatMinorUnits(flatMinor),
    freeShippingThreshold: thresholdMinor !== null ? formatMinorUnits(thresholdMinor) : null,
    estimatedDaysMin: plain.estimatedDaysMin ?? plain.estimated_days_min ?? null,
    estimatedDaysMax: plain.estimatedDaysMax ?? plain.estimated_days_max ?? null,
    isActive: Boolean(plain.isActive ?? plain.is_active ?? true),
    isAlwaysFree: flatMinor === 0 || thresholdMinor === 0,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

export async function listShippingSettings() {
  const rows = await ShippingSetting.findAll({
    order: [['country', 'ASC']],
  });

  return {
    items: rows.map(sanitizeShippingSetting),
  };
}

export async function getShippingSettingByCountry(rawCountry) {
  const country = normalizeSupportedCountry(rawCountry);

  const setting = await ShippingSetting.findOne({
    where: { country },
  });

  if (!setting) {
    throw new AppError(
      404,
      'SHIPPING_SETTING_NOT_FOUND',
      `Shipping setting for country "${country}" was not found.`
    );
  }

  return sanitizeShippingSetting(setting);
}

export async function updateShippingSetting(rawCountry, payload = {}, admin = null) {
  const country = normalizeSupportedCountry(rawCountry);

  const hasUpdatableField =
    payload.flatCharge !== undefined ||
    payload.freeShippingThreshold !== undefined ||
    payload.estimatedDaysMin !== undefined ||
    payload.estimatedDaysMax !== undefined ||
    payload.isActive !== undefined;

  if (!hasUpdatableField) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'At least one shipping setting field must be provided for update.',
      [{ field: 'body', message: 'Provide at least one field to update.' }]
    );
  }

  return sequelize.transaction(async (transaction) => {
    const setting = await ShippingSetting.findOne({
      where: { country },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (!setting) {
      throw new AppError(
        404,
        'SHIPPING_SETTING_NOT_FOUND',
        `Shipping setting for country "${country}" was not found.`
      );
    }

    const beforeSnapshot = sanitizeShippingSetting(setting);
    const updates = {};

    if (payload.flatCharge !== undefined) {
      const flatMinor = parseDecimalToMinorUnits(payload.flatCharge, 'flatCharge', { minMinor: 0 });
      updates.flatCharge = formatMinorUnits(flatMinor);
    }

    if (payload.freeShippingThreshold !== undefined) {
      if (payload.freeShippingThreshold === null || payload.freeShippingThreshold === '') {
        updates.freeShippingThreshold = null;
      } else {
        const thresholdMinor = parseDecimalToMinorUnits(
          payload.freeShippingThreshold,
          'freeShippingThreshold',
          { minMinor: 0 }
        );
        updates.freeShippingThreshold = formatMinorUnits(thresholdMinor);
      }
    }

    if (payload.estimatedDaysMin !== undefined || payload.estimatedDaysMax !== undefined) {
      const mergedMin =
        payload.estimatedDaysMin !== undefined ? payload.estimatedDaysMin : setting.estimatedDaysMin;
      const mergedMax =
        payload.estimatedDaysMax !== undefined ? payload.estimatedDaysMax : setting.estimatedDaysMax;
      const validatedRange = validateEstimatedDaysRange(mergedMin, mergedMax);
      updates.estimatedDaysMin = validatedRange.estimatedDaysMin;
      updates.estimatedDaysMax = validatedRange.estimatedDaysMax;
    }

    if (payload.isActive !== undefined) {
      updates.isActive = Boolean(payload.isActive);
    }

    await setting.update(updates, { transaction });
    await setting.reload({ transaction });

    const afterSnapshot = sanitizeShippingSetting(setting);
    logShippingAudit('shipping_setting.updated', admin, country, beforeSnapshot, afterSnapshot);
    return afterSnapshot;
  });
}

export async function updateShippingSettingStatus(rawCountry, { isActive }, admin = null) {
  const country = normalizeSupportedCountry(rawCountry);

  return sequelize.transaction(async (transaction) => {
    const setting = await ShippingSetting.findOne({
      where: { country },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (!setting) {
      throw new AppError(
        404,
        'SHIPPING_SETTING_NOT_FOUND',
        `Shipping setting for country "${country}" was not found.`
      );
    }

    const beforeSnapshot = sanitizeShippingSetting(setting);
    await setting.update({ isActive: Boolean(isActive) }, { transaction });
    await setting.reload({ transaction });

    const afterSnapshot = sanitizeShippingSetting(setting);
    logShippingAudit('shipping_setting.status_updated', admin, country, beforeSnapshot, afterSnapshot);
    return afterSnapshot;
  });
}
