import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Coupon,
  COUPON_VISIBILITIES,
  ALL_COUPON_VISIBILITIES,
} from '../../models/index.js';
import {
  normalizeAndValidateCouponCode,
  parseDecimalToMinorUnits,
  formatMinorUnits,
  validateDiscountPercentage,
  validateRegionalThresholds,
  calculatePercentageDiscountMinor,
  sanitizeCoupon,
} from '../../services/coupon.service.js';

describe('Coupon model alignment with DATABASE_SCHEMA.md', () => {
  it('defines coupons table with exact snake_case columns, visibility enum, and paranoid soft-delete', () => {
    assert.equal(Coupon.getTableName(), 'coupons');
    assert.equal(Coupon.options.paranoid, true);
    assert.equal(Coupon.options.underscored, true);
    assert.deepEqual(
      Object.values(Coupon.rawAttributes).map((a) => a.field),
      [
        'id',
        'code',
        'description',
        'discount_percentage',
        'min_cart_subtotal_inr',
        'min_cart_subtotal_usd',
        'max_discount_inr',
        'max_discount_usd',
        'max_redemptions',
        'redemption_count',
        'visibility',
        'is_active',
        'expires_at',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );

    assert.deepEqual(Coupon.rawAttributes.visibility.values, [...ALL_COUPON_VISIBILITIES]);
    assert.equal(COUPON_VISIBILITIES.PUBLIC, 'public');
    assert.equal(COUPON_VISIBILITIES.HIDDEN, 'hidden');
  });
});

describe('Coupon validation, decimal minor-unit calculation & sanitization helpers', () => {
  it('normalizes and validates coupon codes', () => {
    assert.equal(normalizeAndValidateCouponCode(' festive-15_us '), 'FESTIVE-15_US');
    assert.equal(normalizeAndValidateCouponCode('vip100'), 'VIP100');

    assert.throws(() => normalizeAndValidateCouponCode('AB'), { code: 'VALIDATION_ERROR' });
    assert.throws(() => normalizeAndValidateCouponCode('A'.repeat(33)), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => normalizeAndValidateCouponCode('-BADCODE'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => normalizeAndValidateCouponCode('NO SPACES'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => normalizeAndValidateCouponCode('BAD@CODE'), {
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates decimal minor-unit parsing, discount percentage bounds, and regional INR/USD thresholds', () => {
    assert.equal(parseDecimalToMinorUnits('19.99', 'amount'), 1999);
    assert.equal(parseDecimalToMinorUnits(25, 'amount'), 2500);
    assert.equal(formatMinorUnits(1999), '19.99');

    assert.throws(() => parseDecimalToMinorUnits('19.999', 'amount'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => parseDecimalToMinorUnits(-5, 'amount'), {
      code: 'VALIDATION_ERROR',
    });

    assert.deepEqual(validateDiscountPercentage(15), { bps: 1500, formatted: '15.00' });
    assert.deepEqual(validateDiscountPercentage('100.00'), { bps: 10000, formatted: '100.00' });
    assert.throws(() => validateDiscountPercentage(0), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateDiscountPercentage(100.01), { code: 'VALIDATION_ERROR' });

    assert.deepEqual(
      validateRegionalThresholds({
        minCartSubtotal: { INR: 999, USD: 25.5 },
        maxDiscount: { INR: 500, USD: 10 },
      }),
      {
        minCartSubtotalInr: '999.00',
        minCartSubtotalUsd: '25.50',
        maxDiscountInr: '500.00',
        maxDiscountUsd: '10.00',
      }
    );

    assert.deepEqual(
      validateRegionalThresholds({
        minCartSubtotal: { INR: 0, USD: 0 },
        maxDiscount: null,
      }),
      {
        minCartSubtotalInr: '0.00',
        minCartSubtotalUsd: '0.00',
        maxDiscountInr: null,
        maxDiscountUsd: null,
      }
    );

    // Rejects half-configured maxDiscount caps
    assert.throws(
      () =>
        validateRegionalThresholds({
          minCartSubtotal: { INR: 500, USD: 10 },
          maxDiscount: { INR: 100 },
        }),
      { code: 'VALIDATION_ERROR' }
    );
    assert.throws(
      () =>
        validateRegionalThresholds({
          minCartSubtotal: { INR: 500, USD: 10 },
          maxDiscount: { INR: 0, USD: 10 },
        }),
      { code: 'VALIDATION_ERROR' }
    );
  });

  it('computes exact percentage discounts in minor units with half-up rounding and caps', () => {
    // $19.99 * 15% = 2.9985 -> 3.00 half-up
    assert.deepEqual(
      calculatePercentageDiscountMinor({
        subtotalMinor: 1999,
        discountPercentage: 15,
      }),
      {
        discountMinor: 300,
        finalSubtotalMinor: 1699,
        discountAmount: '3.00',
        finalSubtotal: '16.99',
      }
    );

    // ₹999.00 * 10% = ₹99.90
    assert.deepEqual(
      calculatePercentageDiscountMinor({
        subtotalMinor: 99900,
        discountPercentage: 10,
      }),
      {
        discountMinor: 9990,
        finalSubtotalMinor: 89910,
        discountAmount: '99.90',
        finalSubtotal: '899.10',
      }
    );

    // ₹5000.00 * 20% = ₹1000.00, capped at ₹500.00
    assert.deepEqual(
      calculatePercentageDiscountMinor({
        subtotalMinor: 500000,
        discountPercentage: 20,
        maxDiscountMinor: 50000,
      }),
      {
        discountMinor: 50000,
        finalSubtotalMinor: 450000,
        discountAmount: '500.00',
        finalSubtotal: '4500.00',
      }
    );

    // 100% off cart subtotal
    assert.deepEqual(
      calculatePercentageDiscountMinor({
        subtotalMinor: 10000,
        discountPercentage: 100,
      }),
      {
        discountMinor: 10000,
        finalSubtotalMinor: 0,
        discountAmount: '100.00',
        finalSubtotal: '0.00',
      }
    );

    // $10.00 * 100% capped at $50.00 -> never exceeds subtotal ($10.00)
    assert.deepEqual(
      calculatePercentageDiscountMinor({
        subtotalMinor: 1000,
        discountPercentage: 100,
        maxDiscountMinor: 5000,
      }),
      {
        discountMinor: 1000,
        finalSubtotalMinor: 0,
        discountAmount: '10.00',
        finalSubtotal: '0.00',
      }
    );
  });

  it('sanitizes coupon responses without customer-assignment fields and computes effectiveStatus', () => {
    const now = new Date('2026-11-26T12:00:00.000Z');
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      code: 'FESTIVE15',
      description: 'Festive sitewide 15%',
      discount_percentage: '15.00',
      min_cart_subtotal_inr: '999.00',
      min_cart_subtotal_usd: '25.00',
      max_discount_inr: '500.00',
      max_discount_usd: '10.00',
      max_redemptions: 10,
      redemption_count: 3,
      visibility: 'public',
      is_active: true,
      expires_at: new Date('2026-12-31T23:59:59.000Z'),
      created_at: new Date('2026-11-26T08:00:00.000Z'),
      updated_at: new Date('2026-11-26T08:00:00.000Z'),
    };

    const active = sanitizeCoupon(base, now);
    assert.equal(active.discountType, 'percentage');
    assert.equal(active.effectiveStatus, 'active');
    assert.equal(active.remainingRedemptions, 7);
    assert.deepEqual(active.minCartSubtotal, { INR: '999.00', USD: '25.00' });
    assert.deepEqual(active.maxDiscount, { INR: '500.00', USD: '10.00' });
    assert.equal('assignedUserId' in active, false);
    assert.equal('assignedCustomer' in active, false);

    assert.equal(
      sanitizeCoupon({ ...base, is_active: false }, now).effectiveStatus,
      'inactive'
    );
    assert.equal(
      sanitizeCoupon({ ...base, expires_at: new Date('2026-11-26T11:00:00.000Z') }, now)
        .effectiveStatus,
      'expired'
    );
    assert.equal(
      sanitizeCoupon({ ...base, redemption_count: 10 }, now).effectiveStatus,
      'exhausted'
    );
  });
});
