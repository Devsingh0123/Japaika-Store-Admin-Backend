import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../app.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  Category,
  Product,
  ProductVariant,
  ProductMedia,
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../../models/index.js';
import { hashPassword } from '../../services/auth.service.js';
import mediaService from '../../services/media.service.js';

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const VALID_MP4_BUFFER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);

const VALID_PDF_BUFFER = Buffer.from('%PDF-1.7\n%Japaika IGI Certificate Test\n%%EOF', 'ascii');

function extractCookies(setCookieHeaders = []) {
  const cookies = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const eqIndex = pair.indexOf('=');
    cookies[pair.slice(0, eqIndex).trim()] = {
      value: pair.slice(eqIndex + 1).trim(),
      raw: header,
    };
  }
  return cookies;
}

describe('Product Management API integration tests (/api/v1/products)', () => {
  const testAdminEmails = new Set();
  const createdProductIds = new Set();
  const createdCategoryIds = new Set();

  let uploadedAssets = [];
  let deletedAssets = [];
  let assetCounter = 0;
  let uploadProductMediaMock;
  let uploadCertMock;
  let deleteImageMock;
  let deleteAssetMock;

  async function createAndLoginAdmin(role = ADMIN_ROLES.CATALOG_MANAGER) {
    const email = `test.prod.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminProductPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Product ${role}`,
      role,
      status: ADMIN_STATUSES.ACTIVE,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessCookie = extractCookies(loginRes.headers['set-cookie']).japaika_admin_access.value;
    return `japaika_admin_access=${accessCookie}`;
  }

  async function createTestCategory(suffix) {
    const category = await Category.create({
      id: crypto.randomUUID(),
      name: `Gemstones ${suffix}`,
      slug: `gemstones-${suffix}`,
      isActive: true,
      sortOrder: 1,
    });
    createdCategoryIds.add(category.id);
    return category;
  }

  beforeEach(() => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    uploadedAssets = [];
    deletedAssets = [];
    assetCounter = 0;

    uploadProductMediaMock = mock.method(
      mediaService,
      'uploadProductMediaBuffer',
      async (_buffer, { mimetype, folder } = {}) => {
        assetCounter += 1;
        const isVideo = typeof mimetype === 'string' && mimetype.startsWith('video/');
        const mediaType = isVideo ? 'video' : 'image';
        const ext = isVideo ? 'mp4' : 'png';
        const mediaPublicId = `${folder}/prod_media_${assetCounter}_${crypto.randomUUID().slice(0, 8)}`;
        uploadedAssets.push({ publicId: mediaPublicId, resourceType: mediaType });
        return {
          mediaType,
          mediaUrl: `https://res.cloudinary.com/demo/${mediaType}/upload/${mediaPublicId}.${ext}`,
          mediaPublicId,
          thumbnailUrl: isVideo
            ? `https://res.cloudinary.com/demo/video/upload/${mediaPublicId}.jpg`
            : null,
          mimeType: mimetype || 'image/png',
          durationSeconds: isVideo ? 8.5 : null,
        };
      }
    );

    uploadCertMock = mock.method(
      mediaService,
      'uploadCertificateBuffer',
      async (_buffer, { mimetype, folder } = {}) => {
        assetCounter += 1;
        const resourceType = mimetype === 'application/pdf' ? 'raw' : 'image';
        const ext = resourceType === 'raw' ? 'pdf' : 'png';
        const certificatePublicId = `${folder}/cert_${assetCounter}_${crypto.randomUUID().slice(0, 8)}`;
        uploadedAssets.push({ publicId: certificatePublicId, resourceType });
        return {
          certificateUrl: `https://res.cloudinary.com/demo/${resourceType}/upload/${certificatePublicId}.${ext}`,
          certificatePublicId,
          certificateResourceType: resourceType,
        };
      }
    );

    deleteImageMock = mock.method(mediaService, 'deleteImageByPublicId', async (publicId) => {
      if (!publicId || !String(publicId).startsWith('japaika-ecom/')) {
        return { deleted: false, reason: 'PROTECTED_EXTERNAL_ASSET' };
      }
      deletedAssets.push({ publicId, resourceType: 'image' });
      return { deleted: true, reason: 'ok' };
    });

    deleteAssetMock = mock.method(
      mediaService,
      'deleteAssetByPublicId',
      async (publicId, { resourceType = 'image' } = {}) => {
        if (!publicId || !String(publicId).startsWith('japaika-ecom/')) {
          return { deleted: false, reason: 'PROTECTED_EXTERNAL_ASSET' };
        }
        deletedAssets.push({ publicId, resourceType });
        return { deleted: true, reason: 'ok' };
      }
    );
  });

  afterEach(async () => {
    uploadProductMediaMock?.mock.restore();
    uploadCertMock?.mock.restore();
    deleteImageMock?.mock.restore();
    deleteAssetMock?.mock.restore();
    delete process.env.DISABLE_RATE_LIMIT;

    for (const productId of [...createdProductIds]) {
      await ProductMedia.destroy({ where: { productId } });
      await ProductVariant.destroy({ where: { productId }, force: true });
      await Product.destroy({ where: { id: productId }, force: true });
    }
    createdProductIds.clear();

    for (const categoryId of [...createdCategoryIds].reverse()) {
      await Category.destroy({ where: { id: categoryId }, force: true });
    }
    createdCategoryIds.clear();

    for (const email of testAdminEmails) {
      const admin = await Admin.findOne({ where: { email }, paranoid: false });
      if (admin) {
        await AdminRefreshToken.destroy({ where: { adminId: admin.id } });
        await Admin.destroy({ where: { id: admin.id }, force: true });
      }
    }
    testAdminEmails.clear();
  });

  after(async () => {
    await sequelize.close();
  });

  it('supports simple product draft creation with regional prices, publish validation, unified gallery media (images + short video) & PDF certificate management, and category delete protection', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const suffix = crypto.randomUUID().slice(0, 8);
    const category = await createTestCategory(suffix);

    // 1. Create a simple product in draft mode without category, media, or regional prices
    const draftRes = await request(app)
      .post('/api/v1/products')
      .set('Cookie', cookie)
      .send({
        name: `Natural Pearl (Moti) ${suffix}`,
        productType: 'simple',
        status: 'draft',
        gstRate: 3,
        hsnCode: '7101',
        specifications: [
          { key: 'Origin', value: 'South Sea' },
          { key: 'Weight', value: '6.5 Ratti' },
        ],
        variants: {
          prices: {},
          stockQuantity: 4,
          lowStockThreshold: 5,
        },
      });

    assert.equal(draftRes.status, 201);
    const draftProduct = draftRes.body.data.product;
    createdProductIds.add(draftProduct.id);

    assert.equal(draftProduct.status, 'draft');
    assert.equal(draftProduct.productType, 'simple');
    assert.equal(draftProduct.variants.length, 1);
    assert.equal(draftProduct.variants[0].isDefault, true);
    assert.deepEqual(draftProduct.variants[0].prices, {});
    assert.equal(draftProduct.variants[0].isLowStock, true);
    assert.equal(draftProduct.variants[0].isPurchasable, true);
    assert.equal('price' in draftProduct.variants[0], false);

    // 2. Attempting to publish before category, images & positive market price fails with 400 PUBLISH_VALIDATION_FAILED
    const prematurePublish = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    assert.equal(prematurePublish.status, 400);
    assert.equal(prematurePublish.body.error.code, 'PUBLISH_VALIDATION_FAILED');

    // 3. Assign category via PATCH, upload 2 gallery images + 1 short MP4 video
    const assignCatRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}`)
      .set('Cookie', cookie)
      .send({ categoryId: category.id });
    assert.equal(assignCatRes.status, 200);

    const mediaUploadRes = await request(app)
      .post(`/api/v1/products/${draftProduct.id}/media`)
      .set('Cookie', cookie)
      .attach('media', VALID_PNG_BUFFER, { filename: 'pearl-1.png', contentType: 'image/png' })
      .attach('media', VALID_PNG_BUFFER, { filename: 'pearl-2.png', contentType: 'image/png' })
      .attach('media', VALID_MP4_BUFFER, { filename: 'pearl-360.mp4', contentType: 'video/mp4' });
    assert.equal(mediaUploadRes.status, 201);
    assert.equal(mediaUploadRes.body.data.media.length, 3);
    assert.equal(mediaUploadRes.body.data.media[0].isPrimary, true);
    assert.equal(mediaUploadRes.body.data.media[0].mediaType, 'image');

    const videoItem = mediaUploadRes.body.data.media.find((m) => m.mediaType === 'video');
    assert.ok(videoItem);
    assert.equal(videoItem.isPrimary, false);
    assert.ok(videoItem.thumbnailUrl);
    assert.equal(videoItem.durationSeconds, 8.5);

    // 3b. Attempting to publish with category & media but without any positive regional price fails with variants.prices detail
    const unpricedPublish = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    assert.equal(unpricedPublish.status, 400);
    assert.equal(unpricedPublish.body.error.code, 'PUBLISH_VALIDATION_FAILED');
    assert.ok(
      unpricedPublish.body.error.details.some((d) => d.field === 'variants.prices')
    );

    // 3c. Set India regional pricing via PATCH
    const assignPriceRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}`)
      .set('Cookie', cookie)
      .send({
        variants: [
          {
            id: draftProduct.variants[0].id,
            prices: {
              IN: { currency: 'INR', price: 8500, salePrice: 7499 },
            },
            stockQuantity: 4,
            lowStockThreshold: 5,
          },
        ],
      });
    assert.equal(assignPriceRes.status, 200);
    assert.deepEqual(assignPriceRes.body.data.product.variants[0].prices.IN, {
      currency: 'INR',
      price: 8500,
      salePrice: 7499,
      effectivePrice: 7499,
    });
    assert.equal(assignPriceRes.body.data.product.variants[0].prices.US, undefined);

    // 4. Setting a video as primary image is rejected with 400 VALIDATION_ERROR
    const setVideoPrimaryRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/media/${videoItem.id}`)
      .set('Cookie', cookie)
      .send({ isPrimary: true });
    assert.equal(setVideoPrimaryRes.status, 400);
    assert.equal(setVideoPrimaryRes.body.error.code, 'VALIDATION_ERROR');

    const certUploadRes = await request(app)
      .put(`/api/v1/products/${draftProduct.id}/certificate`)
      .set('Cookie', cookie)
      .field('certificateLabel', 'GIA Lab Report')
      .attach('certificate', VALID_PDF_BUFFER, {
        filename: 'certificate.pdf',
        contentType: 'application/pdf',
      });
    assert.equal(certUploadRes.status, 200);
    assert.equal(certUploadRes.body.data.certificate.resourceType, 'raw');
    assert.equal(certUploadRes.body.data.certificate.label, 'GIA Lab Report');

    // 5. Publish product -> 200 OK and sets publishedAt
    const publishRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    assert.equal(publishRes.status, 200);
    assert.equal(publishRes.body.data.product.status, 'active');
    assert.ok(publishRes.body.data.product.publishedAt);

    // 6. Category delete protection: cannot delete category while product is assigned (409 CATEGORY_HAS_PRODUCTS)
    const blockedCatDelete = await request(app)
      .delete(`/api/v1/categories/${category.id}`)
      .set('Cookie', cookie);
    assert.equal(blockedCatDelete.status, 409);
    assert.equal(blockedCatDelete.body.error.code, 'CATEGORY_HAS_PRODUCTS');

    // 7. Delete first (primary) image -> second image auto-promoted to primary; trying to delete last remaining image on active product fails with 400 CANNOT_REMOVE_LAST_IMAGE
    const imageItems = mediaUploadRes.body.data.media.filter((m) => m.mediaType === 'image');
    const firstImgId = imageItems[0].id;
    const secondImgId = imageItems[1].id;

    const delFirstImg = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}/media/${firstImgId}`)
      .set('Cookie', cookie);
    assert.equal(delFirstImg.status, 200);

    const blockLastImg = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}/media/${secondImgId}`)
      .set('Cookie', cookie);
    assert.equal(blockLastImg.status, 400);
    assert.equal(blockLastImg.body.error.code, 'CANNOT_REMOVE_LAST_IMAGE');

    // 8. Delete product -> soft-deletes product/variants and cleans up Cloudinary image, video & certificate with matching resourceType
    const delProdRes = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}`)
      .set('Cookie', cookie);
    assert.equal(delProdRes.status, 200);
    assert.ok(
      deletedAssets.some(
        (a) => a.publicId === videoItem.mediaPublicId && a.resourceType === 'video'
      )
    );
    assert.ok(
      deletedAssets.some(
        (a) =>
          a.publicId === certUploadRes.body.data.certificate.publicId &&
          a.resourceType === 'raw'
      )
    );
  });

  it('creates multi-variant product with independent IN/US pricing, filters by country & stock, updates/clears market prices, and enforces RBAC', async () => {
    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const suffix = crypto.randomUUID().slice(0, 8);
    const category = await createTestCategory(suffix);

    const multipartPayload = {
      name: `Ceylon Yellow Sapphire Ring ${suffix}`,
      productType: 'variant',
      status: 'active',
      categoryId: category.id,
      gstRate: 3,
      hsnCode: '7103',
      isFeatured: true,
      variantOptions: [
        { name: 'Metal', values: ['Silver', 'Gold'] },
        { name: 'Ring Size', values: ['14', '16'] },
      ],
      variants: [
        {
          sku: `JPK-YS-${suffix.toUpperCase()}-1`,
          optionValues: { Metal: 'Silver', 'Ring Size': '14' },
          prices: {
            IN: { currency: 'INR', price: 18500, salePrice: 16999 },
            US: { currency: 'USD', price: 240, salePrice: 215 },
          },
          stockQuantity: 1,
          lowStockThreshold: 2,
          isDefault: true,
        },
        {
          sku: `JPK-YS-${suffix.toUpperCase()}-2`,
          optionValues: { Metal: 'Gold', 'Ring Size': '16' },
          prices: {
            IN: { currency: 'INR', price: 42000 },
          },
          stockQuantity: 0,
          lowStockThreshold: 2,
        },
      ],
    };

    const createRes = await request(app)
      .post('/api/v1/products')
      .set('Cookie', catalogCookie)
      .field('payload', JSON.stringify(multipartPayload))
      .attach('media', VALID_PNG_BUFFER, { filename: 'ring.png', contentType: 'image/png' })
      .attach('media', VALID_MP4_BUFFER, { filename: 'ring-video.mp4', contentType: 'video/mp4' })
      .attach('certificate', VALID_PDF_BUFFER, {
        filename: 'igi-cert.pdf',
        contentType: 'application/pdf',
      });

    assert.equal(createRes.status, 201);
    const product = createRes.body.data.product;
    createdProductIds.add(product.id);

    assert.equal(product.productType, 'variant');
    assert.equal(product.media.length, 2);
    assert.equal(product.variants.length, 2);
    assert.deepEqual(product.variants[0].prices.US, {
      currency: 'USD',
      price: 240,
      salePrice: 215,
      effectivePrice: 215,
    });
    assert.equal(product.variants[1].prices.US, undefined); // No INR fallback
    assert.equal(product.variants[1].isOutOfStock, true);
    assert.equal(product.variants[1].isPurchasable, false);

    // Search by variant SKU in GET /api/v1/products and verify per-market priceSummary
    const listRes = await request(app)
      .get(`/api/v1/products?search=JPK-YS-${suffix.toUpperCase()}-2&stockStatus=in_stock`)
      .set('Cookie', catalogCookie);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.items.length, 1);
    const listItem = listRes.body.data.items[0];
    assert.deepEqual(listItem.priceSummary, {
      IN: { currency: 'INR', minPrice: '16999.00', maxPrice: '42000.00' },
      US: { currency: 'USD', minPrice: '215.00', maxPrice: '215.00' },
    });
    assert.equal('minPrice' in listItem, false);
    assert.equal('maxPrice' in listItem, false);
    assert.equal(listItem.totalStock, 1);
    assert.ok(listItem.primaryImage.imageUrl);

    // Country filter (?country=US) returns the product
    const usFilterRes = await request(app)
      .get(`/api/v1/products?search=${suffix}&country=US`)
      .set('Cookie', catalogCookie);
    assert.equal(usFilterRes.status, 200);
    assert.equal(usFilterRes.body.data.items.length, 1);

    // Validation errors on PATCH: invalid salePrice (400 INVALID_SALE_PRICE) and mismatched currency (400 VALIDATION_ERROR)
    const badSaleRes = await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set('Cookie', catalogCookie)
      .send({
        variants: [
          {
            id: product.variants[0].id,
            sku: product.variants[0].sku,
            optionValues: product.variants[0].optionValues,
            prices: {
              IN: { currency: 'INR', price: 18500, salePrice: 19000 },
            },
          },
        ],
      });
    assert.equal(badSaleRes.status, 400);
    assert.equal(badSaleRes.body.error.code, 'INVALID_SALE_PRICE');

    const badCurrencyRes = await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set('Cookie', catalogCookie)
      .send({
        variants: [
          {
            id: product.variants[0].id,
            sku: product.variants[0].sku,
            optionValues: product.variants[0].optionValues,
            prices: {
              IN: { currency: 'USD', price: 200 },
            },
          },
        ],
      });
    assert.equal(badCurrencyRes.status, 400);
    assert.equal(badCurrencyRes.body.error.code, 'VALIDATION_ERROR');

    // Clearing US pricing via PATCH { US: null } removes US entry cleanly
    const clearUsRes = await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set('Cookie', catalogCookie)
      .send({
        variants: [
          {
            id: product.variants[0].id,
            sku: product.variants[0].sku,
            optionValues: product.variants[0].optionValues,
            prices: {
              IN: { currency: 'INR', price: 18500, salePrice: 16999 },
              US: null,
            },
            stockQuantity: 1,
            lowStockThreshold: 2,
            isDefault: true,
          },
          {
            id: product.variants[1].id,
            sku: product.variants[1].sku,
            optionValues: product.variants[1].optionValues,
            prices: {
              IN: { currency: 'INR', price: 42000 },
            },
            stockQuantity: 0,
            lowStockThreshold: 2,
          },
        ],
      });
    assert.equal(clearUsRes.status, 200);
    assert.equal(clearUsRes.body.data.product.variants[0].prices.US, undefined);

    const usFilterAfterClear = await request(app)
      .get(`/api/v1/products?search=${suffix}&country=US`)
      .set('Cookie', catalogCookie);
    assert.equal(usFilterAfterClear.status, 200);
    assert.equal(usFilterAfterClear.body.data.items.length, 0);

    // Operations Manager CAN update variant stock (200), but CANNOT edit product details (403)
    const variantId = product.variants[1].id;
    const opsStockRes = await request(app)
      .patch(`/api/v1/products/${product.id}/variants/${variantId}/stock`)
      .set('Cookie', opsCookie)
      .send({ stockQuantity: 5 });
    assert.equal(opsStockRes.status, 200);
    assert.equal(opsStockRes.body.data.variant.stockQuantity, 5);
    assert.equal(opsStockRes.body.data.variant.isOutOfStock, false);
    assert.equal(opsStockRes.body.data.variant.isPurchasable, true);

    const opsEditForbidden = await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set('Cookie', opsCookie)
      .send({ name: 'Unauthorized Rename' });
    assert.equal(opsEditForbidden.status, 403);

    // Support Moderator CANNOT update variant stock (403)
    const modStockForbidden = await request(app)
      .patch(`/api/v1/products/${product.id}/variants/${variantId}/stock`)
      .set('Cookie', modCookie)
      .send({ stockQuantity: 10 });
    assert.equal(modStockForbidden.status, 403);
  });
});
