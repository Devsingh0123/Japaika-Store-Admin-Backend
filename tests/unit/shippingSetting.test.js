import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShippingSetting } from '../../models/index.js';
import {
  normalizeSupportedCountry,
  validateEstimatedDaysRange,
  sanitizeShippingSetting,
} from '../../services/shippingSetting.service.js';

describe('ShippingSetting model & helpers unit tests', () => {
  it('defines shipping_settings schema aligned with docs/DATABASE_SCHEMA.md §12.1', () => {
    assert.equal(ShippingSetting.getTableName(), 'shipping_settings');

    const attrs = ShippingSetting.rawAttributes;
    for (const field of [
      'id',
      'country',
      'currency',
      'flatCharge',
      'freeShippingThreshold',
      'estimatedDaysMin',
      'estimatedDaysMax',
      'isActive',
    ]) {
      assert.ok(attrs[field], `Expected ShippingSetting attribute "${field}"`);
    }

    assert.equal(attrs.flatCharge.field, 'flat_charge');
    assert.equal(attrs.freeShippingThreshold.field, 'free_shipping_threshold');
    assert.equal(attrs.estimatedDaysMin.field, 'estimated_days_min');
    assert.equal(attrs.estimatedDaysMax.field, 'estimated_days_max');
    assert.equal(attrs.isActive.field, 'is_active');
  });

  it('normalizes supported countries and rejects unsupported ones', () => {
    assert.equal(normalizeSupportedCountry('in'), 'IN');
    assert.equal(normalizeSupportedCountry(' US '), 'US');

    assert.throws(
      () => normalizeSupportedCountry('FR'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => normalizeSupportedCountry(''),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  it('validates paired estimatedDaysMin and estimatedDaysMax bounds', () => {
    assert.deepEqual(validateEstimatedDaysRange(null, null), {
      estimatedDaysMin: null,
      estimatedDaysMax: null,
    });
    assert.deepEqual(validateEstimatedDaysRange(3, 7), {
      estimatedDaysMin: 3,
      estimatedDaysMax: 7,
    });

    assert.throws(
      () => validateEstimatedDaysRange(3, null),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateEstimatedDaysRange(null, 7),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateEstimatedDaysRange(10, 5),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateEstimatedDaysRange(0, 5),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateEstimatedDaysRange(1, 91),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  it('serializes shipping setting decimals and computes isAlwaysFree flag', () => {
    const alwaysFreeThreshold = sanitizeShippingSetting({
      id: 'id-1',
      country: 'IN',
      currency: 'INR',
      flatCharge: '99.00',
      freeShippingThreshold: '0.00',
      estimatedDaysMin: 3,
      estimatedDaysMax: 7,
      isActive: true,
      createdAt: '2026-11-27T08:00:00.000Z',
      updatedAt: '2026-11-27T08:00:00.000Z',
    });
    assert.equal(alwaysFreeThreshold.isAlwaysFree, true);
    assert.equal(alwaysFreeThreshold.freeShippingThreshold, '0.00');

    const paidShipping = sanitizeShippingSetting({
      id: 'id-2',
      country: 'US',
      currency: 'USD',
      flatCharge: '15.00',
      freeShippingThreshold: '150.00',
      estimatedDaysMin: 7,
      estimatedDaysMax: 14,
      isActive: true,
    });
    assert.equal(paidShipping.isAlwaysFree, false);
    assert.equal(paidShipping.flatCharge, '15.00');
    assert.equal(paidShipping.freeShippingThreshold, '150.00');

    const flatZeroFree = sanitizeShippingSetting({
      id: 'id-3',
      country: 'IN',
      currency: 'INR',
      flatCharge: '0.00',
      freeShippingThreshold: null,
      estimatedDaysMin: null,
      estimatedDaysMax: null,
      isActive: false,
    });
    assert.equal(flatZeroFree.isAlwaysFree, true);
    assert.equal(flatZeroFree.freeShippingThreshold, null);
    assert.equal(flatZeroFree.isActive, false);
  });
});
