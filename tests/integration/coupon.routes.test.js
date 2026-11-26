import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../app.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  Coupon,
  ADMIN_ROLES,
  ADMIN_STATUSES,
} from '../../models/index.js';
import { hashPassword } from '../../services/auth.service.js';

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

describe('Coupon Management API integration tests (/api/v1/coupons)', () => {
  const testAdminEmails = new Set();
  const createdCouponIds = new Set();

  async function createAndLoginAdmin(role = ADMIN_ROLES.CATALOG_MANAGER) {
    const email = `test.coupon.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminCouponPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Coupon ${role}`,
      role,
      status: ADMIN_STATUSES.ACTIVE,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessCookie = extractCookies(loginRes.headers['set-cookie']).japaika_admin_access.value;
    return `japaika_admin_access=${accessCookie}`;
  }

  afterEach(async () => {
    delete process.env.DISABLE_RATE_LIMIT;

    for (const couponId of [...createdCouponIds]) {
      await Coupon.destroy({ where: { id: couponId }, force: true });
    }
    createdCouponIds.clear();

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

  it('enforces auth, RBAC, and request validation on /api/v1/coupons', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);

    // Unauthenticated request rejected with 401
    const unauthRes = await request(app).get('/api/v1/coupons');
    assert.equal(unauthRes.status, 401);

    // Removed customer lookup path resolves to invalid coupon ID validation rather than a customer lookup endpoint
    const removedCustomerRoute = await request(app)
      .get('/api/v1/coupons/customers?search=test')
      .set('Cookie', catalogCookie);
    assert.equal(removedCustomerRoute.status, 400);

    // RBAC: moderator & operations_manager cannot mutate coupons (403 FORBIDDEN)
    const modCreateForbidden = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', modCookie)
      .send({
        code: 'MOD10',
        discountPercentage: 10,
        minCartSubtotal: { INR: 500, USD: 10 },
      });
    assert.equal(modCreateForbidden.status, 403);
    assert.equal(modCreateForbidden.body.error.code, 'FORBIDDEN');

    const opsCreateForbidden = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', opsCookie)
      .send({
        code: 'OPS10',
        discountPercentage: 10,
        minCartSubtotal: { INR: 500, USD: 10 },
      });
    assert.equal(opsCreateForbidden.status, 403);

    // Validation errors (before DB table access)
    const badIdRes = await request(app)
      .get('/api/v1/coupons/not-a-uuid')
      .set('Cookie', catalogCookie);
    assert.equal(badIdRes.status, 400);
    assert.equal(badIdRes.body.error.code, 'VALIDATION_ERROR');

    const missingUsdRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: 'MISSINGUSD',
        discountPercentage: 15,
        minCartSubtotal: { INR: 999 },
      });
    assert.equal(missingUsdRes.status, 400);
    assert.equal(missingUsdRes.body.error.code, 'VALIDATION_ERROR');

    const halfCapRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: 'HALFCAP10',
        discountPercentage: 10,
        minCartSubtotal: { INR: 999, USD: 25 },
        maxDiscount: { INR: 500 },
      });
    assert.equal(halfCapRes.status, 400);
    assert.equal(halfCapRes.body.error.code, 'VALIDATION_ERROR');
  });

  it('supports full Coupon CRUD, public & hidden visibility, uniqueness, code lock after redemption, and soft deletion', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();

    // 1. Create public coupon
    const createRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: ` festive_${suffix} `,
        description: 'Festive 15% off across IN & US',
        discountPercentage: 15,
        minCartSubtotal: { INR: 999, USD: 25 },
        maxDiscount: { INR: 500, USD: 10 },
        maxRedemptions: 50,
        visibility: 'public',
        expiresAt: '2099-12-31T23:59:59.000Z',
      });
    assert.equal(createRes.status, 201);
    const publicCoupon = createRes.body.data.coupon;
    createdCouponIds.add(publicCoupon.id);

    assert.equal(publicCoupon.code, `FESTIVE_${suffix}`);
    assert.equal(publicCoupon.discountType, 'percentage');
    assert.equal(publicCoupon.discountPercentage, '15.00');
    assert.deepEqual(publicCoupon.minCartSubtotal, { INR: '999.00', USD: '25.00' });
    assert.deepEqual(publicCoupon.maxDiscount, { INR: '500.00', USD: '10.00' });
    assert.equal(publicCoupon.visibility, 'public');
    assert.equal(publicCoupon.effectiveStatus, 'active');

    // 2. Duplicate code rejected (409 COUPON_CODE_EXISTS)
    const dupRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: `festive_${suffix}`.toLowerCase(),
        discountPercentage: 10,
        minCartSubtotal: { INR: 0, USD: 0 },
      });
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.body.error.code, 'COUPON_CODE_EXISTS');

    // 3. Create hidden coupon (no maxDiscount, unlimited redemptions, no expiry)
    const hiddenRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: `VIP_${suffix}`,
        discountPercentage: 20,
        minCartSubtotal: { INR: 2000, USD: 40 },
        maxDiscount: null,
        maxRedemptions: null,
        visibility: 'hidden',
      });
    assert.equal(hiddenRes.status, 201);
    const hiddenCoupon = hiddenRes.body.data.coupon;
    createdCouponIds.add(hiddenCoupon.id);
    assert.equal(hiddenCoupon.visibility, 'hidden');
    assert.equal(hiddenCoupon.maxDiscount, null);
    assert.equal(hiddenCoupon.maxRedemptions, null);

    // 4. Support moderator can list & filter coupons by visibility (200)
    const listHiddenRes = await request(app)
      .get(`/api/v1/coupons?search=${suffix}&visibility=hidden`)
      .set('Cookie', modCookie);
    assert.equal(listHiddenRes.status, 200);
    assert.equal(listHiddenRes.body.data.items.length, 1);
    assert.equal(listHiddenRes.body.data.items[0].id, hiddenCoupon.id);

    // 5. Status toggle & partial PATCH update (clearing maxDiscount)
    const statusRes = await request(app)
      .patch(`/api/v1/coupons/${publicCoupon.id}/status`)
      .set('Cookie', catalogCookie)
      .send({ isActive: false });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.data.coupon.effectiveStatus, 'inactive');

    const patchCapRes = await request(app)
      .patch(`/api/v1/coupons/${publicCoupon.id}`)
      .set('Cookie', catalogCookie)
      .send({ maxDiscount: null });
    assert.equal(patchCapRes.status, 200);
    assert.equal(patchCapRes.body.data.coupon.maxDiscount, null);

    // 6. When redemptionCount > 0, code modification returns 409 COUPON_CODE_LOCKED & maxRedemptions < redemptionCount returns 400
    await Coupon.update({ redemptionCount: 5 }, { where: { id: publicCoupon.id } });
    const lockedCodeRes = await request(app)
      .patch(`/api/v1/coupons/${publicCoupon.id}`)
      .set('Cookie', catalogCookie)
      .send({ code: `NEWCODE_${suffix}` });
    assert.equal(lockedCodeRes.status, 409);
    assert.equal(lockedCodeRes.body.error.code, 'COUPON_CODE_LOCKED');

    const lowLimitRes = await request(app)
      .patch(`/api/v1/coupons/${publicCoupon.id}`)
      .set('Cookie', catalogCookie)
      .send({ maxRedemptions: 3 });
    assert.equal(lowLimitRes.status, 400);
    assert.equal(lowLimitRes.body.error.code, 'VALIDATION_ERROR');

    // 7. Soft delete coupon and verify code cannot be reused
    const delRes = await request(app)
      .delete(`/api/v1/coupons/${publicCoupon.id}`)
      .set('Cookie', catalogCookie);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.data.deleted, true);

    const reuseDeletedCodeRes = await request(app)
      .post('/api/v1/coupons')
      .set('Cookie', catalogCookie)
      .send({
        code: publicCoupon.code,
        discountPercentage: 5,
        minCartSubtotal: { INR: 0, USD: 0 },
      });
    assert.equal(reuseDeletedCodeRes.status, 409);
    assert.equal(reuseDeletedCodeRes.body.error.code, 'COUPON_CODE_EXISTS');
  });
});
