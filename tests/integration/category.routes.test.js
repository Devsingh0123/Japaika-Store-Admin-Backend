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
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../../models/index.js';
import { hashPassword } from '../../services/auth.service.js';
import mediaService from '../../services/media.service.js';

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

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

describe('Category & Subcategory Management API integration tests (/api/v1/categories)', () => {
  const testAdminEmails = new Set();
  const createdCategoryIds = new Set();
  let uploadedPublicIds = [];
  let deletedPublicIds = [];
  let uploadCounter = 0;
  let uploadMock;
  let deleteMock;

  async function createAndLoginAdmin(role = ADMIN_ROLES.CATALOG_MANAGER) {
    const email = `test.cat.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminCategoryPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Category ${role}`,
      role,
      status: ADMIN_STATUSES.ACTIVE,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessCookie = extractCookies(loginRes.headers['set-cookie']).japaika_admin_access.value;
    return `japaika_admin_access=${accessCookie}`;
  }

  beforeEach(() => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    uploadedPublicIds = [];
    deletedPublicIds = [];
    uploadCounter = 0;

    uploadMock = mock.method(
      mediaService,
      'uploadImageBuffer',
      async (_buffer, { folder } = {}) => {
        uploadCounter += 1;
        const imagePublicId = `${folder}/cat_asset_${uploadCounter}_${crypto.randomUUID().slice(0, 8)}`;
        uploadedPublicIds.push(imagePublicId);
        return {
          imageUrl: `https://res.cloudinary.com/demo/image/upload/${imagePublicId}.png`,
          imagePublicId,
        };
      }
    );

    deleteMock = mock.method(mediaService, 'deleteImageByPublicId', async (publicId) => {
      if (!publicId || !String(publicId).startsWith('japaika-ecom/')) {
        return { deleted: false, reason: 'PROTECTED_EXTERNAL_ASSET' };
      }
      deletedPublicIds.push(publicId);
      return { deleted: true, reason: 'ok' };
    });
  });

  afterEach(async () => {
    uploadMock?.mock.restore();
    deleteMock?.mock.restore();
    delete process.env.DISABLE_RATE_LIMIT;

    for (const id of [...createdCategoryIds].reverse()) {
      await Category.destroy({ where: { id }, force: true });
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

  it('creates top-level categories and subcategories, supports search/pagination/tree, and enforces hierarchy & deletion rules', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);

    // 1. Create top-level category with multipart image upload
    const createParentRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .field('name', `Natural Gemstones ${uniqueSuffix}`)
      .field('description', 'Certified astrological gemstones')
      .field('isActive', 'true')
      .field('sortOrder', '1')
      .field('seoTitle', 'Buy Certified Natural Gemstones')
      .field('seoDescription', 'Lab-certified Pukhraj, Neelam, and Emerald stones')
      .attach('image', VALID_PNG_BUFFER, { filename: 'gemstones.png', contentType: 'image/png' });

    assert.equal(createParentRes.status, 201);
    const parentCat = createParentRes.body.data.category;
    createdCategoryIds.add(parentCat.id);

    assert.equal(parentCat.name, `Natural Gemstones ${uniqueSuffix}`);
    assert.equal(parentCat.slug, `natural-gemstones-${uniqueSuffix}`);
    assert.equal(parentCat.parentId, null);
    assert.equal(parentCat.isActive, true);
    assert.equal(parentCat.sortOrder, 1);
    assert.equal(parentCat.seoTitle, 'Buy Certified Natural Gemstones');
    assert.ok(parentCat.imagePublicId.startsWith('japaika-ecom/categories/'));
    assert.equal(uploadedPublicIds.length, 1);

    // 2. Duplicate slug rejected with 409
    const dupSlugRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .send({ name: `Natural Gemstones ${uniqueSuffix}` });
    assert.equal(dupSlugRes.status, 409);
    assert.equal(dupSlugRes.body.error.code, 'CATEGORY_SLUG_EXISTS');

    // 3. Create subcategory under parent category
    const createSubRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .send({
        name: `Yellow Sapphire ${uniqueSuffix}`,
        parentId: parentCat.id,
        sortOrder: 2,
      });
    assert.equal(createSubRes.status, 201);
    const subCat = createSubRes.body.data.category;
    createdCategoryIds.add(subCat.id);
    assert.equal(subCat.parentId, parentCat.id);

    // 4. Reject 3rd-level nesting (subcategory under subcategory)
    const thirdLevelRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .send({
        name: `Ceylon Pukhraj ${uniqueSuffix}`,
        parentId: subCat.id,
      });
    assert.equal(thirdLevelRes.status, 400);
    assert.equal(thirdLevelRes.body.error.code, 'INVALID_CATEGORY_HIERARCHY');

    // 5. Search & Pagination & Tree View
    const listRes = await request(app)
      .get(`/api/v1/categories?search=${uniqueSuffix}&page=1&limit=10`)
      .set('Cookie', cookie);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.items.length, 2);
    assert.equal(listRes.body.data.pagination.totalItems, 2);

    const treeRes = await request(app)
      .get(`/api/v1/categories?tree=true&search=${uniqueSuffix}`)
      .set('Cookie', cookie);
    assert.equal(treeRes.status, 200);
    assert.equal(treeRes.body.data.items.length, 1);
    assert.equal(treeRes.body.data.items[0].id, parentCat.id);
    assert.equal(treeRes.body.data.items[0].subcategories.length, 1);
    assert.equal(treeRes.body.data.items[0].subcategories[0].id, subCat.id);

    // 6. Get single category by ID returns parent & subcategories
    const getParentRes = await request(app)
      .get(`/api/v1/categories/${parentCat.id}`)
      .set('Cookie', cookie);
    assert.equal(getParentRes.status, 200);
    assert.equal(getParentRes.body.data.category.subcategories.length, 1);

    // 7. Block deleting parent category while it still has subcategories (409)
    const blockedDeleteRes = await request(app)
      .delete(`/api/v1/categories/${parentCat.id}`)
      .set('Cookie', cookie);
    assert.equal(blockedDeleteRes.status, 409);
    assert.equal(blockedDeleteRes.body.error.code, 'CATEGORY_HAS_SUBCATEGORIES');

    // 8. Delete subcategory first, then delete parent category (verifying Cloudinary cleanup)
    const delSubRes = await request(app)
      .delete(`/api/v1/categories/${subCat.id}`)
      .set('Cookie', cookie);
    assert.equal(delSubRes.status, 200);

    const delParentRes = await request(app)
      .delete(`/api/v1/categories/${parentCat.id}`)
      .set('Cookie', cookie);
    assert.equal(delParentRes.status, 200);
    assert.ok(deletedPublicIds.includes(parentCat.imagePublicId));

    // Soft-deleted category is no longer returned by GET /:id
    const afterDelRes = await request(app)
      .get(`/api/v1/categories/${parentCat.id}`)
      .set('Cookie', cookie);
    assert.equal(afterDelRes.status, 404);
  });

  it('replaces old Cloudinary image on update and cleans up newly uploaded image if DB write fails', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.SUPER_ADMIN);
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);

    // Create category with initial image
    const createRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .field('name', `Rudraksha ${uniqueSuffix}`)
      .attach('image', VALID_PNG_BUFFER, { filename: 'first.png', contentType: 'image/png' });

    assert.equal(createRes.status, 201);
    const cat = createRes.body.data.category;
    createdCategoryIds.add(cat.id);
    const firstPublicId = cat.imagePublicId;

    // 1. Replace image via PATCH -> old image deleted from Cloudinary
    const updateRes = await request(app)
      .patch(`/api/v1/categories/${cat.id}`)
      .set('Cookie', cookie)
      .field('name', `Nepali Rudraksha ${uniqueSuffix}`)
      .attach('image', VALID_PNG_BUFFER, { filename: 'second.png', contentType: 'image/png' });

    assert.equal(updateRes.status, 200);
    const secondPublicId = updateRes.body.data.category.imagePublicId;
    assert.notEqual(secondPublicId, firstPublicId);
    assert.ok(deletedPublicIds.includes(firstPublicId));

    // 2. Simulate a DB failure after image upload during createCategory -> newly uploaded image is cleaned up
    const createFailStub = mock.method(Category, 'create', async () => {
      throw new Error('Simulated MySQL write failure');
    });

    try {
      const failRes = await request(app)
        .post('/api/v1/categories')
        .set('Cookie', cookie)
        .field('name', `Failed Category ${uniqueSuffix}`)
        .attach('image', VALID_PNG_BUFFER, { filename: 'orphan.png', contentType: 'image/png' });

      assert.equal(failRes.status, 500);
      const thirdUploadedId = uploadedPublicIds[2];
      assert.ok(thirdUploadedId);
      assert.ok(
        deletedPublicIds.includes(thirdUploadedId),
        'Orphaned Cloudinary upload must be deleted when DB write fails'
      );
    } finally {
      createFailStub.mock.restore();
    }
  });

  it('enforces RBAC (blocks support_moderator from creating/editing/deleting categories) and rejects invalid image uploads', async () => {
    const moderatorCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);

    // Moderator can read categories (200)
    const readRes = await request(app).get('/api/v1/categories').set('Cookie', moderatorCookie);
    assert.equal(readRes.status, 200);

    // Moderator cannot create category (403 FORBIDDEN)
    const forbiddenCreate = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', moderatorCookie)
      .send({ name: `Forbidden ${uniqueSuffix}` });
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'FORBIDDEN');

    // Catalog manager uploading spoofed non-image buffer with image/png contentType -> 400 INVALID_IMAGE_FILE
    const badImageRes = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', catalogCookie)
      .field('name', `Spoofed Image ${uniqueSuffix}`)
      .attach('image', Buffer.from('not-a-valid-png-binary-payload'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });
    assert.equal(badImageRes.status, 400);
    assert.equal(badImageRes.body.error.code, 'INVALID_IMAGE_FILE');
  });
});
