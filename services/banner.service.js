import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { sequelize, Banner } from '../models/index.js';
import mediaService, { CLOUDINARY_FOLDERS } from './media.service.js';
import { AppError } from '../utils/http.js';

export function validateBannerCtaUrl(rawUrl) {
  if (rawUrl === undefined) return undefined;
  if (rawUrl === null) return null;

  const trimmed = String(rawUrl).trim();
  if (!trimmed) return null;

  if (trimmed.length > 500) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ctaUrl must not exceed 500 characters.', [
      { field: 'ctaUrl', message: 'ctaUrl exceeds 500 characters.' },
    ]);
  }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return trimmed;
    }
  } catch {
    // Fall through to uniform error
  }

  throw new AppError(
    400,
    'VALIDATION_ERROR',
    'ctaUrl must be a relative storefront path starting with "/" or a valid http(s) URL.',
    [{ field: 'ctaUrl', message: 'Invalid ctaUrl format or protocol.' }]
  );
}

function parseScheduleDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a valid ISO datetime.`, [
      { field: fieldName, message: `Invalid ${fieldName} datetime.` },
    ]);
  }
  return date;
}

export function parseAndValidateSchedule(startsAt, endsAt) {
  const startDate = parseScheduleDate(startsAt, 'startsAt');
  const endDate = parseScheduleDate(endsAt, 'endsAt');

  if (startDate && endDate && endDate <= startDate) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Banner end time (endsAt) must be later than start time (startsAt).',
      [{ field: 'endsAt', message: 'endsAt must be after startsAt.' }]
    );
  }

  return { startsAt: startDate, endsAt: endDate };
}

export function sanitizeBanner(bannerInstance, now = new Date()) {
  if (!bannerInstance) return null;

  const plain =
    typeof bannerInstance.get === 'function'
      ? bannerInstance.get({ plain: true })
      : bannerInstance;

  const rawStartsAt = plain.startsAt ?? plain.starts_at ?? null;
  const rawEndsAt = plain.endsAt ?? plain.ends_at ?? null;
  const createdAt = plain.created_at ?? plain.createdAt ?? null;
  const updatedAt = plain.updated_at ?? plain.updatedAt ?? null;

  const startDate = rawStartsAt ? new Date(rawStartsAt) : null;
  const endDate = rawEndsAt ? new Date(rawEndsAt) : null;
  const isActive = Boolean(plain.isActive ?? plain.is_active ?? true);

  const isCurrentlyLive =
    isActive &&
    (!startDate || startDate <= now) &&
    (!endDate || endDate >= now);

  return {
    id: plain.id,
    title: plain.title,
    subtitle: plain.subtitle ?? null,
    badgeText: plain.badgeText ?? plain.badge_text ?? null,
    imageUrl: plain.imageUrl ?? plain.image_url,
    imagePublicId: plain.imagePublicId ?? plain.image_public_id ?? null,
    mobileImageUrl: plain.mobileImageUrl ?? plain.mobile_image_url ?? null,
    mobileImagePublicId:
      plain.mobileImagePublicId ?? plain.mobile_image_public_id ?? null,
    altText: plain.altText ?? plain.alt_text ?? null,
    ctaLabel: plain.ctaLabel ?? plain.cta_label ?? null,
    ctaUrl: plain.ctaUrl ?? plain.cta_url ?? null,
    placement: plain.placement,
    sortOrder: Number(plain.sortOrder ?? plain.sort_order ?? 0),
    isActive,
    startsAt: startDate ? startDate.toISOString() : null,
    endsAt: endDate ? endDate.toISOString() : null,
    isCurrentlyLive,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
  };
}

export async function listBanners({
  page = 1,
  limit = 20,
  search = '',
  placement,
  isActive,
  scheduleStatus,
} = {}) {
  const where = {};
  const andConditions = [];
  const now = new Date();

  if (placement) {
    where.placement = placement;
  }

  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const pattern = `%${trimmedSearch}%`;
    andConditions.push({
      [Op.or]: [
        { title: { [Op.like]: pattern } },
        { subtitle: { [Op.like]: pattern } },
        { badgeText: { [Op.like]: pattern } },
        { ctaLabel: { [Op.like]: pattern } },
      ],
    });
  }

  if (scheduleStatus === 'live') {
    where.isActive = true;
    andConditions.push(
      { [Op.or]: [{ startsAt: { [Op.is]: null } }, { startsAt: { [Op.lte]: now } }] },
      { [Op.or]: [{ endsAt: { [Op.is]: null } }, { endsAt: { [Op.gte]: now } }] }
    );
  } else if (scheduleStatus === 'scheduled') {
    andConditions.push({ startsAt: { [Op.gt]: now } });
  } else if (scheduleStatus === 'expired') {
    andConditions.push({ endsAt: { [Op.lt]: now } });
  }

  if (andConditions.length > 0) {
    where[Op.and] = andConditions;
  }

  const offset = (page - 1) * limit;

  const { rows, count } = await Banner.findAndCountAll({
    where,
    order: [
      ['sort_order', 'ASC'],
      ['created_at', 'DESC'],
    ],
    limit,
    offset,
  });

  return {
    items: rows.map((row) => sanitizeBanner(row, now)),
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
}

export async function getBannerById(id) {
  const banner = await Banner.findByPk(id);
  if (!banner) {
    throw new AppError(404, 'BANNER_NOT_FOUND', 'Banner not found.');
  }

  return sanitizeBanner(banner);
}

export async function createBanner(payload, files = {}) {
  if (!files.image?.buffer) {
    throw new AppError(
      400,
      'INVALID_IMAGE_FILE',
      'A desktop banner image file is required.'
    );
  }

  const ctaUrl = validateBannerCtaUrl(payload.ctaUrl ?? null);
  const schedule = parseAndValidateSchedule(payload.startsAt ?? null, payload.endsAt ?? null);

  let uploadedDesktop = null;
  let uploadedMobile = null;

  try {
    uploadedDesktop = await mediaService.uploadImageBuffer(files.image.buffer, {
      folder: CLOUDINARY_FOLDERS.BANNERS,
    });

    if (files.mobileImage?.buffer) {
      uploadedMobile = await mediaService.uploadImageBuffer(files.mobileImage.buffer, {
        folder: CLOUDINARY_FOLDERS.BANNERS,
      });
    }

    const created = await Banner.create({
      id: crypto.randomUUID(),
      title: payload.title.trim(),
      subtitle: payload.subtitle ?? null,
      badgeText: payload.badgeText ?? null,
      imageUrl: uploadedDesktop.imageUrl,
      imagePublicId: uploadedDesktop.imagePublicId,
      mobileImageUrl: uploadedMobile?.imageUrl ?? null,
      mobileImagePublicId: uploadedMobile?.imagePublicId ?? null,
      altText: payload.altText ?? null,
      ctaLabel: payload.ctaLabel ?? null,
      ctaUrl,
      placement: payload.placement || 'homepage_hero',
      sortOrder: payload.sortOrder ?? 0,
      isActive: payload.isActive ?? true,
      startsAt: schedule.startsAt,
      endsAt: schedule.endsAt,
    });

    return sanitizeBanner(created);
  } catch (err) {
    if (uploadedDesktop?.imagePublicId) {
      await mediaService.deleteImageByPublicId(uploadedDesktop.imagePublicId);
    }
    if (uploadedMobile?.imagePublicId) {
      await mediaService.deleteImageByPublicId(uploadedMobile.imagePublicId);
    }
    throw err;
  }
}

export async function updateBanner(id, payload, files = {}) {
  const banner = await Banner.findByPk(id);
  if (!banner) {
    throw new AppError(404, 'BANNER_NOT_FOUND', 'Banner not found.');
  }

  const updates = {};

  if (payload.title !== undefined) {
    updates.title = payload.title.trim();
  }

  const optionalFields = ['subtitle', 'badgeText', 'altText', 'ctaLabel', 'placement', 'sortOrder', 'isActive'];
  for (const field of optionalFields) {
    if (payload[field] !== undefined) {
      updates[field] = payload[field];
    }
  }

  if (payload.ctaUrl !== undefined) {
    updates.ctaUrl = validateBannerCtaUrl(payload.ctaUrl);
  }

  if (payload.startsAt !== undefined || payload.endsAt !== undefined) {
    const effectiveStartsAt = payload.startsAt !== undefined ? payload.startsAt : banner.startsAt;
    const effectiveEndsAt = payload.endsAt !== undefined ? payload.endsAt : banner.endsAt;
    const schedule = parseAndValidateSchedule(effectiveStartsAt, effectiveEndsAt);
    updates.startsAt = schedule.startsAt;
    updates.endsAt = schedule.endsAt;
  }

  const oldImagePublicId = banner.imagePublicId;
  const oldMobileImagePublicId = banner.mobileImagePublicId;
  let newDesktopImage = null;
  let newMobileImage = null;

  try {
    if (files.image?.buffer) {
      newDesktopImage = await mediaService.uploadImageBuffer(files.image.buffer, {
        folder: CLOUDINARY_FOLDERS.BANNERS,
      });
      updates.imageUrl = newDesktopImage.imageUrl;
      updates.imagePublicId = newDesktopImage.imagePublicId;
    }

    if (files.mobileImage?.buffer) {
      newMobileImage = await mediaService.uploadImageBuffer(files.mobileImage.buffer, {
        folder: CLOUDINARY_FOLDERS.BANNERS,
      });
      updates.mobileImageUrl = newMobileImage.imageUrl;
      updates.mobileImagePublicId = newMobileImage.imagePublicId;
    } else if (payload.removeMobileImage === true) {
      updates.mobileImageUrl = null;
      updates.mobileImagePublicId = null;
    }

    await banner.update(updates);
  } catch (err) {
    if (newDesktopImage?.imagePublicId) {
      await mediaService.deleteImageByPublicId(newDesktopImage.imagePublicId);
    }
    if (newMobileImage?.imagePublicId) {
      await mediaService.deleteImageByPublicId(newMobileImage.imagePublicId);
    }
    throw err;
  }

  if (
    newDesktopImage &&
    oldImagePublicId &&
    oldImagePublicId !== newDesktopImage.imagePublicId
  ) {
    await mediaService.deleteImageByPublicId(oldImagePublicId);
  }

  if (
    (newMobileImage || payload.removeMobileImage === true) &&
    oldMobileImagePublicId &&
    oldMobileImagePublicId !== newMobileImage?.imagePublicId
  ) {
    await mediaService.deleteImageByPublicId(oldMobileImagePublicId);
  }

  return sanitizeBanner(banner);
}

export async function updateBannerStatus(id, { isActive }) {
  const banner = await Banner.findByPk(id);
  if (!banner) {
    throw new AppError(404, 'BANNER_NOT_FOUND', 'Banner not found.');
  }

  await banner.update({ isActive: Boolean(isActive) });
  return sanitizeBanner(banner);
}

export async function reorderBanners(items = []) {
  const ids = items.map((item) => item.id);
  const uniqueIds = new Set(ids);

  if (uniqueIds.size !== ids.length) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Duplicate banner IDs are not allowed in reorder payload.',
      [{ field: 'items', message: 'Duplicate banner IDs detected.' }]
    );
  }

  const existing = await Banner.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id'],
  });

  if (existing.length !== ids.length) {
    throw new AppError(
      404,
      'BANNER_NOT_FOUND',
      'One or more banner IDs were not found.'
    );
  }

  await sequelize.transaction(async (transaction) => {
    for (const item of items) {
      await Banner.update(
        { sortOrder: item.sortOrder },
        { where: { id: item.id }, transaction }
      );
    }
  });

  const updated = await Banner.findAll({
    where: { id: { [Op.in]: ids } },
    order: [
      ['sort_order', 'ASC'],
      ['created_at', 'DESC'],
    ],
  });

  return {
    items: updated.map((row) => sanitizeBanner(row)),
  };
}

export async function deleteBanner(id) {
  const banner = await Banner.findByPk(id);
  if (!banner) {
    throw new AppError(404, 'BANNER_NOT_FOUND', 'Banner not found.');
  }

  const oldImagePublicId = banner.imagePublicId;
  const oldMobileImagePublicId = banner.mobileImagePublicId;

  await sequelize.transaction(async (transaction) => {
    // Preserve non-null image_url column while clearing nullable Cloudinary/mobile fields
    await banner.update(
      {
        imagePublicId: null,
        mobileImageUrl: null,
        mobileImagePublicId: null,
      },
      { transaction }
    );
    await banner.destroy({ transaction });
  });

  if (oldImagePublicId) {
    await mediaService.deleteImageByPublicId(oldImagePublicId);
  }
  if (oldMobileImagePublicId) {
    await mediaService.deleteImageByPublicId(oldMobileImagePublicId);
  }

  return { id: banner.id, deleted: true };
}
