import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Category,
  Product,
  ProductVariant,
  ProductImage,
  ALL_PRODUCT_TYPES,
  ALL_PRODUCT_STATUSES,
} from '../../models/index.js';
import {
  slugifyProduct,
  resolveAndValidateProductSlug,
  normalizeSku,
  buildOptionSignature,
  validateSalePrice,
  validateGstRate,
} from '../../services/product.service.js';
import { CLOUDINARY_FOLDERS } from '../../services/media.service.js';
import {
  hasValidPdfSignature,
  hasValidCertificateSignature,
} from '../../middlewares/upload.middleware.js';

describe('Product, ProductVariant & ProductImage models alignment with DATABASE_SCHEMA.md', () => {
  it('defines products, product_variants, and product_images with exact snake_case columns and associations', () => {
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
        'price',
        'sale_price',
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

    assert.equal(ProductImage.getTableName(), 'product_images');
    assert.equal(ProductImage.options.updatedAt, false);
    assert.deepEqual(
      Object.values(ProductImage.rawAttributes).map((a) => a.field),
      [
        'id',
        'product_id',
        'image_url',
        'image_public_id',
        'alt_text',
        'is_primary',
        'sort_order',
        'created_at',
      ]
    );

    assert.ok(Category.associations.products);
    assert.ok(Product.associations.category);
    assert.ok(Product.associations.variants);
    assert.ok(Product.associations.images);
  });
});

describe('Product slug, SKU, option signature, pricing & GST helpers', () => {
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

  it('builds deterministic option signatures and validates sale prices and GST slabs', () => {
    assert.equal(buildOptionSignature('simple', null), 'default');
    assert.equal(
      buildOptionSignature('variant', { Size: '14', Metal: 'Silver' }),
      'metal=silver|size=14'
    );
    assert.throws(() => buildOptionSignature('variant', {}), {
      code: 'VALIDATION_ERROR',
    });

    assert.equal(validateSalePrice(15000, null), null);
    assert.equal(validateSalePrice(15000, 12999), 12999);
    assert.throws(() => validateSalePrice(15000, 15000), {
      code: 'INVALID_SALE_PRICE',
    });
    assert.throws(() => validateSalePrice(15000, 0), {
      code: 'INVALID_SALE_PRICE',
    });

    assert.equal(validateGstRate(3), 3);
    assert.equal(validateGstRate(0.25), 0.25);
    assert.throws(() => validateGstRate(10), {
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates PDF and image certificate magic-byte signatures and Cloudinary folders', () => {
    assert.equal(CLOUDINARY_FOLDERS.PRODUCTS, 'japaika-ecom/products');
    assert.equal(CLOUDINARY_FOLDERS.CERTIFICATES, 'japaika-ecom/certificates');

    const pdfBuf = Buffer.from('%PDF-1.7\nsample laboratory certificate', 'ascii');
    const badBuf = Buffer.from('not a pdf or image file', 'ascii');

    assert.equal(hasValidPdfSignature(pdfBuf), true);
    assert.equal(hasValidPdfSignature(badBuf), false);
    assert.equal(hasValidCertificateSignature(pdfBuf, 'application/pdf'), true);
    assert.equal(hasValidCertificateSignature(badBuf, 'application/pdf'), false);
  });
});
