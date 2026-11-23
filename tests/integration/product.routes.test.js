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
  ProductImage,
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../../models/index.js';
import { hashPassword } from '../../services/auth.service.js';
import mediaService from '../../services/media.service.js';

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
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
  let uploadImageMock;
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

    uploadImageMock = mock.method(
      mediaService,
      'uploadImageBuffer',
      async (_buffer, { folder } = {}) => {
        assetCounter += 1;
        const imagePublicId = `${folder}/prod_img_${assetCounter}_${crypto.randomUUID().slice(0, 8)}`;
        uploadedAssets.push(imagePublicId);
        return {
          imageUrl: `https://res.cloudinary.com/demo/image/upload/${imagePublicId}.png`,
          imagePublicId,
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
        uploadedAssets.push(certificatePublicId);
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
      deletedAssets.push(publicId);
      return { deleted: true, reason: 'ok' };
    });

    deleteAssetMock = mock.method(mediaService, 'deleteAssetByPublicId', async (publicId) => {
      if (!publicId || !String(publicId).startsWith('japaika-ecom/')) {
        return { deleted: false, reason: 'PROTECTED_EXTERNAL_ASSET' };
      }
      deletedAssets.push(publicId);
      return { deleted: true, reason: 'ok' };
    });
  });

  afterEach(async () => {
    uploadImageMock?.mock.restore();
    uploadCertMock?.mock.restore();
    deleteImageMock?.mock.restore();
    deleteAssetMock?.mock.restore();
    delete process.env.DISABLE_RATE_LIMIT;

    for (const productId of [...createdProductIds]) {
      await ProductImage.destroy({ where: { productId } });
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

  it('supports simple product draft creation, publish validation, gallery & PDF certificate management, and category delete protection', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const suffix = crypto.randomUUID().slice(0, 8);
    const category = await createTestCategory(suffix);

    // 1. Create a simple product in draft mode without category or images
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
          price: 8500,
          salePrice: 7499,
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
    assert.equal(draftProduct.variants[0].effectivePrice, '7499.00');
    assert.equal(draftProduct.variants[0].isLowStock, true);
    assert.equal(draftProduct.variants[0].isPurchasable, true);

    // 2. Attempting to publish before category & images are added fails with 400 PUBLISH_VALIDATION_FAILED
    const prematurePublish = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    assert.equal(prematurePublish.status, 400);
    assert.equal(prematurePublish.body.error.code, 'PUBLISH_VALIDATION_FAILED');

    // 3. Assign category via PATCH, upload 2 gallery images, and attach PDF certificate
    const assignCatRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}`)
      .set('Cookie', cookie)
      .send({ categoryId: category.id });
    assert.equal(assignCatRes.status, 200);

    const imgUploadRes = await request(app)
      .post(`/api/v1/products/${draftProduct.id}/images`)
      .set('Cookie', cookie)
      .attach('images', VALID_PNG_BUFFER, { filename: 'pearl-1.png', contentType: 'image/png' })
      .attach('images', VALID_PNG_BUFFER, { filename: 'pearl-2.png', contentType: 'image/png' });
    assert.equal(imgUploadRes.status, 201);
    assert.equal(imgUploadRes.body.data.images.length, 2);
    assert.equal(imgUploadRes.body.data.images[0].isPrimary, true);

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

    // 4. Publish product -> 200 OK and sets publishedAt
    const publishRes = await request(app)
      .patch(`/api/v1/products/${draftProduct.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'active' });
    assert.equal(publishRes.status, 200);
    assert.equal(publishRes.body.data.product.status, 'active');
    assert.ok(publishRes.body.data.product.publishedAt);

    // 5. Category delete protection: cannot delete category while product is assigned (409 CATEGORY_HAS_PRODUCTS)
    const blockedCatDelete = await request(app)
      .delete(`/api/v1/categories/${category.id}`)
      .set('Cookie', cookie);
    assert.equal(blockedCatDelete.status, 409);
    assert.equal(blockedCatDelete.body.error.code, 'CATEGORY_HAS_PRODUCTS');

    // 6. Delete first (primary) image -> second image auto-promoted to primary; trying to delete last remaining image on active product fails with 400 CANNOT_REMOVE_LAST_IMAGE
    const firstImgId = imgUploadRes.body.data.images[0].id;
    const secondImgId = imgUploadRes.body.data.images[1].id;

    const delFirstImg = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}/images/${firstImgId}`)
      .set('Cookie', cookie);
    assert.equal(delFirstImg.status, 200);

    const blockLastImg = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}/images/${secondImgId}`)
      .set('Cookie', cookie);
    assert.equal(blockLastImg.status, 400);
    assert.equal(blockLastImg.body.error.code, 'CANNOT_REMOVE_LAST_IMAGE');

    // 7. Delete product -> soft-deletes product/variants and cleans up Cloudinary images & certificate
    const delProdRes = await request(app)
      .delete(`/api/v1/products/${draftProduct.id}`)
      .set('Cookie', cookie);
    assert.equal(delProdRes.status, 200);
    assert.ok(deletedAssets.includes(certUploadRes.body.data.certificate.publicId));
  });

  it('creates multi-variant product via multipart/form-data, enforces RBAC on stock & catalog updates, and filters product list', async () => {
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
          price: 18500,
          salePrice: 16999,
          stockQuantity: 1,
          lowStockThreshold: 2,
          isDefault: true,
        },
        {
          sku: `JPK-YS-${suffix.toUpperCase()}-2`,
          optionValues: { Metal: 'Gold', 'Ring Size': '16' },
          price: 42000,
          stockQuantity: 0,
          lowStockThreshold: 2,
        },
      ],
    };

    const createRes = await request(app)
      .post('/api/v1/products')
      .set('Cookie', catalogCookie)
      .field('payload', JSON.stringify(multipartPayload))
      .attach('images', VALID_PNG_BUFFER, { filename: 'ring.png', contentType: 'image/png' })
      .attach('certificate', VALID_PDF_BUFFER, {
        filename: 'igi-cert.pdf',
        contentType: 'application/pdf',
      });

    assert.equal(createRes.status, 201);
    const product = createRes.body.data.product;
    createdProductIds.add(product.id);

    assert.equal(product.productType, 'variant');
    assert.equal(product.variants.length, 2);
    assert.equal(product.variants[1].isOutOfStock, true);
    assert.equal(product.variants[1].isPurchasable, false);

    // Search by variant SKU in GET /api/v1/products
    const listRes = await request(app)
      .get(`/api/v1/products?search=JPK-YS-${suffix.toUpperCase()}-2&stockStatus=in_stock`)
      .set('Cookie', catalogCookie);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.items.length, 1);
    assert.equal(listRes.body.data.items[0].minPrice, '16999.00');
    assert.equal(listRes.body.data.items[0].maxPrice, '42000.00');
    assert.equal(listRes.body.data.items[0].totalStock, 1);

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
