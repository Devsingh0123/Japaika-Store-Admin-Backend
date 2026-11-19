import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Category } from '../../models/index.js';
import {
  slugify,
  resolveAndValidateSlug,
} from '../../services/category.service.js';
import {
  CLOUDINARY_FOLDERS,
  ALLOWED_CLOUDINARY_PREFIX,
  isSafeJapaikaEcomPublicId,
  uploadImageBuffer,
  deleteImageByPublicId,
} from '../../services/media.service.js';
import { hasValidImageSignature } from '../../middlewares/upload.middleware.js';

describe('Category model schema & associations', () => {
  it('matches docs/DATABASE_SCHEMA.md columns, paranoid soft-delete, and self-referencing associations', () => {
    assert.equal(Category.getTableName(), 'categories');
    assert.equal(Category.options.paranoid, true);
    assert.equal(Category.options.underscored, true);

    assert.deepEqual(
      Object.values(Category.rawAttributes).map((attr) => attr.field),
      [
        'id',
        'parent_id',
        'name',
        'slug',
        'description',
        'image_url',
        'image_public_id',
        'is_active',
        'sort_order',
        'seo_title',
        'seo_description',
        'created_at',
        'updated_at',
        'deleted_at',
      ]
    );

    assert.ok(Category.associations.parent);
    assert.ok(Category.associations.subcategories);
  });
});

describe('Category slug helpers', () => {
  it('generates URL-safe lowercase slugs from category names', () => {
    assert.equal(slugify('  Natural Gemstones & Rings!  '), 'natural-gemstones-rings');
    assert.equal(slugify('Rudraksha (1 to 14 Mukhi)'), 'rudraksha-1-to-14-mukhi');
    assert.equal(resolveAndValidateSlug('', 'Puja Kits & Yantras'), 'puja-kits-yantras');
    assert.equal(resolveAndValidateSlug('  Custom-Slug-01 ', 'Ignored Name'), 'custom-slug-01');
  });

  it('rejects invalid slugs', () => {
    assert.throws(() => resolveAndValidateSlug('invalid__slug!!', 'Fallback'), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => resolveAndValidateSlug('', '!!!'), {
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('Image magic-byte signature validation & Cloudinary safety guards', () => {
  it('accepts valid PNG, JPEG, WebP, and AVIF signatures and rejects invalid buffers', () => {
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const webpBuffer = Buffer.from('RIFF\x00\x00\x00\x00WEBPvp8 ', 'ascii');
    const avifBuffer = Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'ascii');
    const textBuffer = Buffer.from('not an image file at all', 'utf8');

    assert.equal(hasValidImageSignature(pngBuffer), true);
    assert.equal(hasValidImageSignature(jpegBuffer), true);
    assert.equal(hasValidImageSignature(webpBuffer), true);
    assert.equal(hasValidImageSignature(avifBuffer), true);
    assert.equal(hasValidImageSignature(textBuffer), false);
    assert.equal(hasValidImageSignature(Buffer.from('short')), false);
  });

  it('enforces japaika-ecom/ folder isolation and protects legacy japaika assets from deletion', async () => {
    assert.equal(CLOUDINARY_FOLDERS.CATEGORIES, 'japaika-ecom/categories');
    assert.equal(ALLOWED_CLOUDINARY_PREFIX, 'japaika-ecom/');

    assert.equal(isSafeJapaikaEcomPublicId('japaika-ecom/categories/gemstone_123'), true);
    assert.equal(isSafeJapaikaEcomPublicId('japaika/banners/legacy_asset'), false);
    assert.equal(isSafeJapaikaEcomPublicId('categories/gemstone_123'), false);
    assert.equal(isSafeJapaikaEcomPublicId(''), false);

    // Refuses to delete legacy/external assets outside japaika-ecom/
    const legacyResult = await deleteImageByPublicId('japaika/products/legacy_gemstone');
    assert.deepEqual(legacyResult, {
      deleted: false,
      reason: 'PROTECTED_EXTERNAL_ASSET',
    });

    const emptyResult = await deleteImageByPublicId('');
    assert.deepEqual(emptyResult, {
      deleted: false,
      reason: 'EMPTY_PUBLIC_ID',
    });

    // Rejects empty upload buffer or non-japaika-ecom folder
    await assert.rejects(() => uploadImageBuffer(Buffer.alloc(0)), {
      code: 'INVALID_IMAGE_FILE',
    });
    await assert.rejects(
      () => uploadImageBuffer(Buffer.from([1, 2, 3]), { folder: 'japaika/legacy' }),
      { code: 'INVALID_UPLOAD_FOLDER' }
    );
  });
});
