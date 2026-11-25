import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  ALL_PRODUCT_TYPES,
  ALL_PRODUCT_STATUSES,
  ALL_PRODUCT_MEDIA_TYPES,
  SUPPORTED_MARKETS,
  SUPPORTED_COUNTRIES,
  DEFAULT_COUNTRY,
} from '../../models/index.js';
import {
  slugifyProduct,
  resolveAndValidateProductSlug,
  normalizeSku,
  buildOptionSignature,
  normalizeAndValidatePrices,
  sanitizeVariant,
  validateGstRate,
  sanitizeMediaItem,
} from '../../services/product.service.js';
import { CLOUDINARY_FOLDERS } from '../../services/media.service.js';
import {
  hasValidPdfSignature,
  hasValidCertificateSignature,
  hasValidVideoSignature,
  hasValidProductMediaSignature,
} from '../../middlewares/upload.middleware.js';

describe('Product, ProductVariant & ProductMedia models alignment with DATABASE_SCHEMA.md', () => {
  it('defines products, product_variants (prices JSON), and product_media with exact snake_case columns and associations', () => {
    assert.equal(Product.getTableName(), 'products');
    assert.equal(Product.options.paranoid, true);
    assert.deepEqual(
      Object.values(Product.rawAttributes).map((a) => a.field),
      [
        'id',
        'category_id',
        'name',
        'slug',
        'product_type',
        'status',
        'short_description',
        'description',
        'traditional_significance',
        'wearing_instructions',
        'care_instructions',
        'specifications',
        'variant_options',
        'gst_rate',
        'hsn_code',
        'certificate_url',
        'certificate_public_id',
        'certificate_resource_type',
        'certificate_label',
        'weight_grams',
        'length_cm',
        'width_cm',
        'height_cm',
        'shipping_notes',
        'is_featured',
        'seo_title',
        'seo_description',
        'published_at',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );
    assert.deepEqual(Product.rawAttributes.productType.values, [...ALL_PRODUCT_TYPES]);
    assert.deepEqual(Product.rawAttributes.status.values, [...ALL_PRODUCT_STATUSES]);

    assert.equal(ProductVariant.getTableName(), 'product_variants');
    assert.equal(ProductVariant.options.paranoid, true);
    assert.deepEqual(
      Object.values(ProductVariant.rawAttributes).map((a) => a.field),
      [
        'id',
        'product_id',
        'sku',
        'title',
        'option_values',
        'option_signature',
        'prices',
        'stock_quantity',
        'low_stock_threshold',
        'is_active',
        'is_default',
        'sort_order',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );

    assert.equal(SUPPORTED_MARKETS.IN.currency, 'INR');
    assert.equal(SUPPORTED_MARKETS.US.currency, 'USD');
    assert.deepEqual(SUPPORTED_COUNTRIES, ['IN', 'US']);
    assert.equal(DEFAULT_COUNTRY, 'IN');

    assert.equal(ProductMedia.getTableName(), 'product_media');
    assert.equal(ProductMedia.options.updatedAt, false);
    assert.deepEqual(
      Object.values(ProductMedia.rawAttributes).map((a) => a.field),
      [
        'id',
        'product_id',
        'media_type',
        'media_url',
        'media_public_id',
        'thumbnail_url',
        'mime_type',
        'duration_seconds',
        'alt_text',
        'is_primary',
        'sort_order',
        'created_at',
      ]
    );
    assert.deepEqual(ProductMedia.rawAttributes.mediaType.values, [...ALL_PRODUCT_MEDIA_TYPES]);

    assert.ok(Category.associations.products);
    assert.ok(Product.associations.category);
    assert.ok(Product.associations.variants);
    assert.ok(Product.associations.media);
  });
});

describe('Product slug, SKU, option signature, regional pricing, GST & unified media helpers', () => {
  it('generates and validates product slugs and SKUs', () => {
    assert.equal(
      slugifyProduct('  Ceylon Yellow Sapphire (Pukhraj) 5.25 Ratti! '),
      'ceylon-yellow-sapphire-pukhraj-5-25-ratti'
    );
    assert.equal(
      resolveAndValidateProductSlug('', 'Nepali 5 Mukhi Rudraksha'),
      'nepali-5-mukhi-rudraksha'
    );
    assert.throws(() => resolveAndValidateProductSlug('bad__slug!!', 'Fallback'), {
      code: 'VALIDATION_ERROR',
    });

    assert.equal(normalizeSku(' jpk-puk-001 ', 'pukhraj'), 'JPK-PUK-001');
    assert.match(normalizeSku('', 'pukhraj', 0), /^JPK-PUKHRAJ-1[A-F0-9]{6}$/);
  });

  it('validates regional prices (IN/INR & US/USD), omits null entries, and rejects invalid currencies or sale prices', () => {
    assert.equal(buildOptionSignature('simple', null), 'default');
    assert.equal(
      buildOptionSignature('variant', { Size: '14', Metal: 'Silver' }),
      'metal=silver|size=14'
    );
    assert.throws(() => buildOptionSignature('variant', {}), {
      code: 'VALIDATION_ERROR',
    });

    assert.deepEqual(normalizeAndValidatePrices({}), {});
    assert.deepEqual(normalizeAndValidatePrices(null), {});

    // Dual-market + currency inference + null entry removal
    assert.deepEqual(
      normalizeAndValidatePrices({
        in: { price: 20000, salePrice: 18000 },
        US: { currency: 'USD', price: 280 },
      }),
      {
        IN: { currency: 'INR', price: 20000, salePrice: 18000 },
        US: { currency: 'USD', price: 280, salePrice: null },
      }
    );

    // Single-market US-only + null IN omission
    assert.deepEqual(
      normalizeAndValidatePrices({
        IN: null,
        US: { currency: 'USD', price: 150, salePrice: 120 },
      }),
      {
        US: { currency: 'USD', price: 150, salePrice: 120 },
      }
    );

    // Unsupported country
    assert.throws(() => normalizeAndValidatePrices({ UK: { price: 100 } }), {
      code: 'VALIDATION_ERROR',
    });

    // Currency mismatch
    assert.throws(
      () => normalizeAndValidatePrices({ IN: { currency: 'USD', price: 100 } }),
      { code: 'VALIDATION_ERROR' }
    );

    // Invalid sale prices
    assert.throws(
      () => normalizeAndValidatePrices({ IN: { currency: 'INR', price: 15000, salePrice: 15000 } }),
      { code: 'INVALID_SALE_PRICE' }
    );
    assert.throws(
      () => normalizeAndValidatePrices({ US: { currency: 'USD', price: 200, salePrice: 0 } }),
      { code: 'INVALID_SALE_PRICE' }
    );

    // Sanitized variant computes per-market effectivePrice and omits flat price fields
    const sanitized = sanitizeVariant({
      id: '11111111-1111-4111-8111-111111111111',
      product_id: '22222222-2222-4222-8222-222222222222',
      sku: 'JPK-PUKH-1',
      prices: JSON.stringify({
        IN: { currency: 'INR', price: 20000, salePrice: 18000 },
        US: { currency: 'USD', price: 280, salePrice: null },
      }),
      stock_quantity: 5,
      low_stock_threshold: 2,
      is_active: true,
      is_default: true,
      sort_order: 0,
    });

    assert.deepEqual(sanitized.prices, {
      IN: { currency: 'INR', price: 20000, salePrice: 18000, effectivePrice: 18000 },
      US: { currency: 'USD', price: 280, salePrice: null, effectivePrice: 280 },
    });
    assert.equal('price' in sanitized, false);
    assert.equal('salePrice' in sanitized, false);
    assert.equal('effectivePrice' in sanitized, false);

    assert.equal(validateGstRate(3), 3);
    assert.equal(validateGstRate(0.25), 0.25);
    assert.throws(() => validateGstRate(10), {
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates image, video (MP4/WebM), and PDF certificate magic-byte signatures and sanitizes media items', () => {
    assert.equal(CLOUDINARY_FOLDERS.PRODUCTS, 'japaika-ecom/products');
    assert.equal(CLOUDINARY_FOLDERS.CERTIFICATES, 'japaika-ecom/certificates');

    const pdfBuf = Buffer.from('%PDF-1.7\nsample laboratory certificate', 'ascii');
    const mp4Buf = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    const webmBuf = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    ]);
    const badBuf = Buffer.from('not a pdf, image, or video file', 'ascii');

    assert.equal(hasValidPdfSignature(pdfBuf), true);
    assert.equal(hasValidPdfSignature(badBuf), false);
    assert.equal(hasValidCertificateSignature(pdfBuf, 'application/pdf'), true);
    assert.equal(hasValidCertificateSignature(badBuf, 'application/pdf'), false);

    assert.equal(hasValidVideoSignature(mp4Buf, 'video/mp4'), true);
    assert.equal(hasValidVideoSignature(webmBuf, 'video/webm'), true);
    assert.equal(hasValidVideoSignature(badBuf, 'video/mp4'), false);
    assert.equal(hasValidProductMediaSignature(mp4Buf, 'video/mp4'), true);
    assert.equal(hasValidProductMediaSignature(webmBuf, 'video/webm'), true);
    assert.equal(hasValidProductMediaSignature(badBuf, 'image/png'), false);

    const sanitizedVideo = sanitizeMediaItem({
      id: '11111111-1111-4111-8111-111111111111',
      product_id: '22222222-2222-4222-8222-222222222222',
      media_type: 'video',
      media_url: 'https://res.cloudinary.com/demo/video/upload/japaika-ecom/products/vid1.mp4',
      media_public_id: 'japaika-ecom/products/vid1',
      thumbnail_url: 'https://res.cloudinary.com/demo/video/upload/japaika-ecom/products/vid1.jpg',
      mime_type: 'video/mp4',
      duration_seconds: '12.50',
      alt_text: '360 gemstone preview',
      is_primary: false,
      sort_order: 1,
      created_at: new Date('2026-11-23T10:00:00.000Z'),
    });

    assert.equal(sanitizedVideo.mediaType, 'video');
    assert.equal(sanitizedVideo.durationSeconds, 12.5);
    assert.equal(sanitizedVideo.isPrimary, false);
  });
});
