import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../app.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  Banner,
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

describe('Banner Management API integration tests (/api/v1/banners)', () => {
  const testAdminEmails = new Set();
  const createdBannerIds = new Set();
  let uploadedPublicIds = [];
  let deletedPublicIds = [];
  let uploadCounter = 0;
  let uploadMock;
  let deleteMock;

  async function createAndLoginAdmin(role = ADMIN_ROLES.CATALOG_MANAGER) {
    const email = `test.banner.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminBannerPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Banner ${role}`,
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
        const imagePublicId = `${folder}/banner_asset_${uploadCounter}_${crypto.randomUUID().slice(0, 8)}`;
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

    for (const id of [...createdBannerIds]) {
      await Banner.destroy({ where: { id }, force: true });
    }
    createdBannerIds.clear();

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

  it('creates banners with desktop & mobile images, filters/searches list, toggles status, reorders, and soft-deletes with cleanup', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const suffix = crypto.randomUUID().slice(0, 8);

    // 1. Desktop image is required on create
    const missingImgRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', cookie)
      .field('title', `Missing Desktop ${suffix}`);
    assert.equal(missingImgRes.status, 400);
    assert.equal(missingImgRes.body.error.code, 'INVALID_IMAGE_FILE');

    // 2. Create hero banner with both desktop and mobile images
    const heroRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', cookie)
      .field('title', `Certified Gemstones Hero ${suffix}`)
      .field('subtitle', '100% Natural Vedic Gemstones')
      .field('badgeText', 'Lab Certified')
      .field('altText', 'Certified natural gemstones collection')
      .field('ctaLabel', 'Explore Gemstones')
      .field('ctaUrl', '/categories/gemstones')
      .field('placement', 'homepage_hero')
      .field('sortOrder', '2')
      .field('isActive', 'true')
      .attach('image', VALID_PNG_BUFFER, { filename: 'hero-desktop.png', contentType: 'image/png' })
      .attach('mobileImage', VALID_PNG_BUFFER, {
        filename: 'hero-mobile.png',
        contentType: 'image/png',
      });

    assert.equal(heroRes.status, 201);
    const heroBanner = heroRes.body.data.banner;
    createdBannerIds.add(heroBanner.id);

    assert.equal(heroBanner.title, `Certified Gemstones Hero ${suffix}`);
    assert.equal(heroBanner.placement, 'homepage_hero');
    assert.equal(heroBanner.isCurrentlyLive, true);
    assert.ok(heroBanner.imagePublicId.startsWith('japaika-ecom/banners/'));
    assert.ok(heroBanner.mobileImagePublicId.startsWith('japaika-ecom/banners/'));
    assert.equal(uploadedPublicIds.length, 2);

    // 3. Create future scheduled promo banner
    const promoRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', cookie)
      .field('title', `Diwali Promo ${suffix}`)
      .field('placement', 'homepage_promo')
      .field('sortOrder', '1')
      .field('startsAt', '2099-01-01T00:00:00.000Z')
      .field('endsAt', '2099-02-01T00:00:00.000Z')
      .attach('image', VALID_PNG_BUFFER, { filename: 'promo.png', contentType: 'image/png' });

    assert.equal(promoRes.status, 201);
    const promoBanner = promoRes.body.data.banner;
    createdBannerIds.add(promoBanner.id);
    assert.equal(promoBanner.isCurrentlyLive, false);

    // 4. Filter by search, placement, and scheduleStatus
    const listAllRes = await request(app)
      .get(`/api/v1/banners?search=${suffix}`)
      .set('Cookie', cookie);
    assert.equal(listAllRes.status, 200);
    assert.equal(listAllRes.body.data.items.length, 2);
    assert.equal(listAllRes.body.data.items[0].id, promoBanner.id); // sortOrder 1 < sortOrder 2

    const listScheduledRes = await request(app)
      .get(`/api/v1/banners?search=${suffix}&scheduleStatus=scheduled`)
      .set('Cookie', cookie);
    assert.equal(listScheduledRes.status, 200);
    assert.equal(listScheduledRes.body.data.items.length, 1);
    assert.equal(listScheduledRes.body.data.items[0].id, promoBanner.id);

    const listLiveHeroRes = await request(app)
      .get(`/api/v1/banners?search=${suffix}&placement=homepage_hero&scheduleStatus=live`)
      .set('Cookie', cookie);
    assert.equal(listLiveHeroRes.status, 200);
    assert.equal(listLiveHeroRes.body.data.items.length, 1);
    assert.equal(listLiveHeroRes.body.data.items[0].id, heroBanner.id);

    // 5. Get single banner by ID
    const getRes = await request(app)
      .get(`/api/v1/banners/${heroBanner.id}`)
      .set('Cookie', cookie);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.data.banner.id, heroBanner.id);

    // 6. Reorder banners transactionally (swap hero -> 0, promo -> 5)
    const reorderRes = await request(app)
      .patch('/api/v1/banners/reorder')
      .set('Cookie', cookie)
      .send({
        items: [
          { id: heroBanner.id, sortOrder: 0 },
          { id: promoBanner.id, sortOrder: 5 },
        ],
      });
    assert.equal(reorderRes.status, 200);
    assert.equal(reorderRes.body.data.items[0].id, heroBanner.id);
    assert.equal(reorderRes.body.data.items[0].sortOrder, 0);

    const listAfterReorder = await request(app)
      .get(`/api/v1/banners?search=${suffix}`)
      .set('Cookie', cookie);
    assert.equal(listAfterReorder.status, 200);
    assert.equal(listAfterReorder.body.data.items[0].id, heroBanner.id);

    // 7. Toggle active status via PATCH /:id/status
    const toggleRes = await request(app)
      .patch(`/api/v1/banners/${heroBanner.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: false });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.body.data.banner.isActive, false);
    assert.equal(toggleRes.body.data.banner.isCurrentlyLive, false);

    // 8. Soft-delete banner -> cleans up desktop and mobile Cloudinary assets, and GET /:id returns 404
    const delRes = await request(app)
      .delete(`/api/v1/banners/${heroBanner.id}`)
      .set('Cookie', cookie);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.data.deleted, true);
    assert.ok(deletedPublicIds.includes(heroBanner.imagePublicId));
    assert.ok(deletedPublicIds.includes(heroBanner.mobileImagePublicId));

    const afterDelGet = await request(app)
      .get(`/api/v1/banners/${heroBanner.id}`)
      .set('Cookie', cookie);
    assert.equal(afterDelGet.status, 404);
    assert.equal(afterDelGet.body.error.code, 'BANNER_NOT_FOUND');
  });

  it('replaces/removes Cloudinary images on update and cleans up orphaned uploads on DB write failure', async () => {
    const cookie = await createAndLoginAdmin(ADMIN_ROLES.SUPER_ADMIN);
    const suffix = crypto.randomUUID().slice(0, 8);

    const createRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', cookie)
      .field('title', `Rudraksha Promo ${suffix}`)
      .attach('image', VALID_PNG_BUFFER, { filename: 'desk-1.png', contentType: 'image/png' })
      .attach('mobileImage', VALID_PNG_BUFFER, {
        filename: 'mob-1.png',
        contentType: 'image/png',
      });

    assert.equal(createRes.status, 201);
    const banner = createRes.body.data.banner;
    createdBannerIds.add(banner.id);

    // Replace desktop image and remove mobile image via PATCH
    const patchRes = await request(app)
      .patch(`/api/v1/banners/${banner.id}`)
      .set('Cookie', cookie)
      .field('title', `Updated Rudraksha Promo ${suffix}`)
      .field('removeMobileImage', 'true')
      .attach('image', VALID_PNG_BUFFER, { filename: 'desk-2.png', contentType: 'image/png' });

    assert.equal(patchRes.status, 200);
    const updated = patchRes.body.data.banner;
    assert.notEqual(updated.imagePublicId, banner.imagePublicId);
    assert.equal(updated.mobileImageUrl, null);
    assert.equal(updated.mobileImagePublicId, null);
    assert.ok(deletedPublicIds.includes(banner.imagePublicId));
    assert.ok(deletedPublicIds.includes(banner.mobileImagePublicId));

    // Orphan cleanup when DB write fails after Cloudinary upload during createBanner
    const createStub = mock.method(Banner, 'create', async () => {
      throw new Error('Simulated MySQL failure during banner insert');
    });

    try {
      const failRes = await request(app)
        .post('/api/v1/banners')
        .set('Cookie', cookie)
        .field('title', `Orphan Test ${suffix}`)
        .attach('image', VALID_PNG_BUFFER, { filename: 'orphan-desk.png', contentType: 'image/png' })
        .attach('mobileImage', VALID_PNG_BUFFER, {
          filename: 'orphan-mob.png',
          contentType: 'image/png',
        });

      assert.equal(failRes.status, 500);
      const orphanDeskId = uploadedPublicIds[3];
      const orphanMobId = uploadedPublicIds[4];
      assert.ok(orphanDeskId);
      assert.ok(orphanMobId);
      assert.ok(deletedPublicIds.includes(orphanDeskId));
      assert.ok(deletedPublicIds.includes(orphanMobId));
    } finally {
      createStub.mock.restore();
    }
  });

  it('rejects unsafe ctaUrl, invalid schedule ranges, spoofed images, and enforces RBAC', async () => {
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const suffix = crypto.randomUUID().slice(0, 8);

    // Moderator & Operations Manager can read banners (200)
    const modReadRes = await request(app).get('/api/v1/banners').set('Cookie', modCookie);
    assert.equal(modReadRes.status, 200);

    const opsReadRes = await request(app).get('/api/v1/banners').set('Cookie', opsCookie);
    assert.equal(opsReadRes.status, 200);

    // Moderator & Operations Manager are blocked from all write actions (403 FORBIDDEN)
    const modCreateRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', modCookie)
      .send({ title: `Forbidden ${suffix}` });
    assert.equal(modCreateRes.status, 403);
    assert.equal(modCreateRes.body.error.code, 'FORBIDDEN');

    const opsReorderRes = await request(app)
      .patch('/api/v1/banners/reorder')
      .set('Cookie', opsCookie)
      .send({ items: [{ id: crypto.randomUUID(), sortOrder: 1 }] });
    assert.equal(opsReorderRes.status, 403);

    // Reject spoofed non-image buffer (400 INVALID_IMAGE_FILE)
    const spoofedRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', catalogCookie)
      .field('title', `Spoofed ${suffix}`)
      .attach('image', Buffer.from('fake-png-content-payload'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });
    assert.equal(spoofedRes.status, 400);
    assert.equal(spoofedRes.body.error.code, 'INVALID_IMAGE_FILE');

    // Reject javascript: ctaUrl (400 VALIDATION_ERROR)
    const badCtaRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', catalogCookie)
      .field('title', `Bad CTA ${suffix}`)
      .field('ctaUrl', 'javascript:alert(1)')
      .attach('image', VALID_PNG_BUFFER, { filename: 'ok.png', contentType: 'image/png' });
    assert.equal(badCtaRes.status, 400);
    assert.equal(badCtaRes.body.error.code, 'VALIDATION_ERROR');

    // Reject endsAt <= startsAt (400 VALIDATION_ERROR)
    const badScheduleRes = await request(app)
      .post('/api/v1/banners')
      .set('Cookie', catalogCookie)
      .field('title', `Bad Schedule ${suffix}`)
      .field('startsAt', '2026-12-10T00:00:00.000Z')
      .field('endsAt', '2026-12-01T00:00:00.000Z')
      .attach('image', VALID_PNG_BUFFER, { filename: 'ok.png', contentType: 'image/png' });
    assert.equal(badScheduleRes.status, 400);
    assert.equal(badScheduleRes.body.error.code, 'VALIDATION_ERROR');
  });
});
