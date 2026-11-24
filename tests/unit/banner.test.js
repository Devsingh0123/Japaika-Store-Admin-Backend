import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Banner,
  BANNER_PLACEMENTS,
  ALL_BANNER_PLACEMENTS,
} from '../../models/index.js';
import {
  validateBannerCtaUrl,
  parseAndValidateSchedule,
  sanitizeBanner,
} from '../../services/banner.service.js';
import { CLOUDINARY_FOLDERS } from '../../services/media.service.js';

describe('Banner model alignment with DATABASE_SCHEMA.md', () => {
  it('defines banners table with exact snake_case columns, enums, and paranoid soft-delete', () => {
    assert.equal(Banner.getTableName(), 'banners');
    assert.equal(Banner.options.paranoid, true);
    assert.equal(Banner.options.underscored, true);

    assert.deepEqual(
      Object.values(Banner.rawAttributes).map((attr) => attr.field),
      [
        'id',
        'title',
        'subtitle',
        'badge_text',
        'image_url',
        'image_public_id',
        'mobile_image_url',
        'mobile_image_public_id',
        'alt_text',
        'cta_label',
        'cta_url',
        'placement',
        'sort_order',
        'is_active',
        'starts_at',
        'ends_at',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );

    assert.deepEqual(Banner.rawAttributes.placement.values, [...ALL_BANNER_PLACEMENTS]);
    assert.equal(BANNER_PLACEMENTS.HOMEPAGE_HERO, 'homepage_hero');
    assert.equal(BANNER_PLACEMENTS.HOMEPAGE_PROMO, 'homepage_promo');
    assert.equal(CLOUDINARY_FOLDERS.BANNERS, 'japaika-ecom/banners');
  });
});

describe('Banner CTA URL, schedule validation & sanitization helpers', () => {
  it('validates safe CTA URLs and rejects unsafe protocols', () => {
    assert.equal(validateBannerCtaUrl('/categories/gemstones'), '/categories/gemstones');
    assert.equal(validateBannerCtaUrl('https://japaika.com/offer'), 'https://japaika.com/offer');
    assert.equal(validateBannerCtaUrl('http://localhost:3000/sale'), 'http://localhost:3000/sale');
    assert.equal(validateBannerCtaUrl('   '), null);
    assert.equal(validateBannerCtaUrl(null), null);
    assert.equal(validateBannerCtaUrl(undefined), undefined);

    assert.throws(() => validateBannerCtaUrl('javascript:alert(1)'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => validateBannerCtaUrl('data:text/html,<script>alert(1)</script>'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => validateBannerCtaUrl('//evil.example.com'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => validateBannerCtaUrl('not-a-valid-path'), {
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates optional UTC start/end schedules', () => {
    const open = parseAndValidateSchedule(null, null);
    assert.deepEqual(open, { startsAt: null, endsAt: null });

    const valid = parseAndValidateSchedule(
      '2026-11-24T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z'
    );
    assert.ok(valid.startsAt instanceof Date);
    assert.ok(valid.endsAt instanceof Date);

    assert.throws(
      () => parseAndValidateSchedule('2026-12-01T00:00:00.000Z', '2026-11-24T00:00:00.000Z'),
      { code: 'VALIDATION_ERROR' }
    );
    assert.throws(
      () => parseAndValidateSchedule('2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z'),
      { code: 'VALIDATION_ERROR' }
    );
    assert.throws(() => parseAndValidateSchedule('not-a-date', null), {
      code: 'VALIDATION_ERROR',
    });
  });

  it('computes isCurrentlyLive accurately across active, scheduled, and expired banners', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Certified Gemstones',
      image_url: 'https://res.cloudinary.com/demo/image/upload/japaika-ecom/banners/b1.png',
      image_public_id: 'japaika-ecom/banners/b1',
      placement: 'homepage_hero',
      sort_order: 0,
      is_active: true,
      created_at: new Date('2026-11-24T08:00:00.000Z'),
      updated_at: new Date('2026-11-24T08:00:00.000Z'),
    };

    assert.equal(sanitizeBanner({ ...base }, now).isCurrentlyLive, true);
    assert.equal(sanitizeBanner({ ...base, is_active: false }, now).isCurrentlyLive, false);
    assert.equal(
      sanitizeBanner({ ...base, starts_at: new Date('2026-11-25T00:00:00.000Z') }, now)
        .isCurrentlyLive,
      false
    );
    assert.equal(
      sanitizeBanner({ ...base, ends_at: new Date('2026-11-24T11:00:00.000Z') }, now)
        .isCurrentlyLive,
      false
    );
    assert.equal(
      sanitizeBanner(
        {
          ...base,
          starts_at: new Date('2026-11-24T00:00:00.000Z'),
          ends_at: new Date('2026-11-25T00:00:00.000Z'),
        },
        now
      ).isCurrentlyLive,
      true
    );
  });
});
