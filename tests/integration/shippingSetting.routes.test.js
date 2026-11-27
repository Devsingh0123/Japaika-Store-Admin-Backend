import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../app.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  ShippingSetting,
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

describe('Shipping Settings API integration tests (/api/v1/shipping-settings)', () => {
  const testAdminEmails = new Set();
  const originalSettingsByCountry = new Map();

  async function createAndLoginAdmin(role = ADMIN_ROLES.OPERATIONS_MANAGER) {
    const email = `test.shipping.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminShippingPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Shipping ${role}`,
      role,
      status: ADMIN_STATUSES.ACTIVE,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessCookie = extractCookies(loginRes.headers['set-cookie']).japaika_admin_access.value;
    return `japaika_admin_access=${accessCookie}`;
  }

  beforeEach(async () => {
    const rows = await ShippingSetting.findAll();
    originalSettingsByCountry.clear();
    for (const row of rows) {
      originalSettingsByCountry.set(row.country, {
        flatCharge: row.flatCharge,
        freeShippingThreshold: row.freeShippingThreshold,
        estimatedDaysMin: row.estimatedDaysMin,
        estimatedDaysMax: row.estimatedDaysMax,
        isActive: row.isActive,
      });
    }
  });

  afterEach(async () => {
    delete process.env.DISABLE_RATE_LIMIT;

    for (const [country, snapshot] of originalSettingsByCountry.entries()) {
      await ShippingSetting.update(snapshot, { where: { country } });
    }
    originalSettingsByCountry.clear();

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

  it('enforces auth, RBAC, and reads regional IN/US shipping settings', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';

    const unauth = await request(app).get('/api/v1/shipping-settings');
    assert.equal(unauth.status, 401);

    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);

    // All active admin roles can read shipping settings
    const listRes = await request(app).get('/api/v1/shipping-settings').set('Cookie', catalogCookie);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.success, true);
    assert.ok(listRes.body.data.items.length >= 2);

    const countries = listRes.body.data.items.map((item) => item.country);
    assert.ok(countries.includes('IN'));
    assert.ok(countries.includes('US'));

    // Single country fetch is case-insensitive
    const usRes = await request(app)
      .get('/api/v1/shipping-settings/us')
      .set('Cookie', modCookie);
    assert.equal(usRes.status, 200);
    assert.equal(usRes.body.data.shippingSetting.country, 'US');
    assert.equal(usRes.body.data.shippingSetting.currency, 'USD');

    // Unsupported country returns 400
    const badCountry = await request(app)
      .get('/api/v1/shipping-settings/CA')
      .set('Cookie', opsCookie);
    assert.equal(badCountry.status, 400);
    assert.equal(badCountry.body.error.code, 'VALIDATION_ERROR');

    // catalog_manager & support_moderator cannot mutate shipping settings (403 FORBIDDEN)
    const catPatchForbidden = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', catalogCookie)
      .send({ flatCharge: 99 });
    assert.equal(catPatchForbidden.status, 403);
    assert.equal(catPatchForbidden.body.error.code, 'FORBIDDEN');

    const modToggleForbidden = await request(app)
      .patch('/api/v1/shipping-settings/US/status')
      .set('Cookie', modCookie)
      .send({ isActive: false });
    assert.equal(modToggleForbidden.status, 403);
  });

  it('updates flatCharge, freeShippingThreshold, ETA bounds, and status with validation guards', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const superCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPER_ADMIN);

    // Valid partial update by operations_manager
    const patchInRes = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', opsCookie)
      .send({
        flatCharge: 149.5,
        freeShippingThreshold: 1999,
        estimatedDaysMin: 2,
        estimatedDaysMax: 5,
      });
    assert.equal(patchInRes.status, 200);
    assert.equal(patchInRes.body.data.shippingSetting.flatCharge, '149.50');
    assert.equal(patchInRes.body.data.shippingSetting.freeShippingThreshold, '1999.00');
    assert.equal(patchInRes.body.data.shippingSetting.estimatedDaysMin, 2);
    assert.equal(patchInRes.body.data.shippingSetting.estimatedDaysMax, 5);
    assert.equal(patchInRes.body.data.shippingSetting.isAlwaysFree, false);

    // Setting freeShippingThreshold to null (no free threshold) + clearing ETA range
    const clearThresholdRes = await request(app)
      .patch('/api/v1/shipping-settings/us')
      .set('Cookie', superCookie)
      .send({
        flatCharge: 20,
        freeShippingThreshold: null,
        estimatedDaysMin: null,
        estimatedDaysMax: null,
      });
    assert.equal(clearThresholdRes.status, 200);
    assert.equal(clearThresholdRes.body.data.shippingSetting.flatCharge, '20.00');
    assert.equal(clearThresholdRes.body.data.shippingSetting.freeShippingThreshold, null);
    assert.equal(clearThresholdRes.body.data.shippingSetting.estimatedDaysMin, null);
    assert.equal(clearThresholdRes.body.data.shippingSetting.estimatedDaysMax, null);

    // Status toggle
    const statusRes = await request(app)
      .patch('/api/v1/shipping-settings/US/status')
      .set('Cookie', opsCookie)
      .send({ isActive: false });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.data.shippingSetting.isActive, false);

    // Validation failures
    const badRange = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', opsCookie)
      .send({ estimatedDaysMin: 8, estimatedDaysMax: 3 });
    assert.equal(badRange.status, 400);

    const halfEta = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', opsCookie)
      .send({ estimatedDaysMax: null });
    assert.equal(halfEta.status, 400);

    const negativeCharge = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', opsCookie)
      .send({ flatCharge: -10 });
    assert.equal(negativeCharge.status, 400);

    const emptyBody = await request(app)
      .patch('/api/v1/shipping-settings/IN')
      .set('Cookie', opsCookie)
      .send({});
    assert.equal(emptyBody.status, 400);
  });
});
