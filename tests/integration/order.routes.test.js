import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../app.js';
import {
  sequelize,
  Admin,
  AdminRefreshToken,
  User,
  Category,
  Product,
  ProductVariant,
  Coupon,
  Order,
  OrderItem,
  ADMIN_ROLES,
  ADMIN_STATUSES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from '../../models/index.js';
import { hashPassword } from '../../services/auth.service.js';
import razorpayService from '../../services/razorpay.service.js';

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

describe('Admin Order Management API integration tests (/api/v1/orders)', () => {
  const testAdminEmails = new Set();
  const createdUserIds = new Set();
  const createdCategoryIds = new Set();
  const createdProductIds = new Set();
  const createdVariantIds = new Set();
  const createdCouponIds = new Set();
  const createdOrderIds = new Set();

  const originalCreateRefund = razorpayService.createRefund;
  const originalFetchOrderPayments = razorpayService.fetchOrderPayments;

  async function createAndLoginAdmin(role = ADMIN_ROLES.OPERATIONS_MANAGER) {
    const email = `test.order.${role}.${crypto.randomUUID()}@japaika-admin-test.local`;
    const password = 'AdminOrderPass123!';
    testAdminEmails.add(email);

    await Admin.create({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password, 10),
      fullName: `Order ${role}`,
      role,
      status: ADMIN_STATUSES.ACTIVE,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    const accessCookie = extractCookies(loginRes.headers['set-cookie']).japaika_admin_access.value;
    return `japaika_admin_access=${accessCookie}`;
  }

  async function createTestUser(overrides = {}) {
    const id = crypto.randomUUID();
    createdUserIds.add(id);
    return User.create({
      id,
      email: `test.customer.${id}@japaika-order-test.local`,
      fullName: 'Test Customer',
      phone: '+919876543210',
      isEmailVerified: true,
      status: 'active',
      ...overrides,
    });
  }

  async function createTestCatalogItem({ stockQuantity = 10 } = {}) {
    const catId = crypto.randomUUID();
    createdCategoryIds.add(catId);
    await Category.create({
      id: catId,
      name: `Order Cat ${catId.slice(0, 6)}`,
      slug: `order-cat-${catId.slice(0, 8)}`,
      isActive: true,
    });

    const productId = crypto.randomUUID();
    createdProductIds.add(productId);
    const product = await Product.create({
      id: productId,
      categoryId: catId,
      name: 'Natural Pukhraj Stone',
      slug: `pukhraj-${productId.slice(0, 8)}`,
      productType: 'simple',
      status: 'active',
      gstRate: '3.00',
      hsnCode: '7103',
    });

    const variantId = crypto.randomUUID();
    createdVariantIds.add(variantId);
    const variant = await ProductVariant.create({
      id: variantId,
      productId,
      sku: `JPK-${variantId.slice(0, 8).toUpperCase()}`,
      title: '5 Ratti',
      optionSignature: 'default',
      prices: {
        IN: { currency: 'INR', price: 2000, salePrice: 1800 },
        US: { currency: 'USD', price: 30, salePrice: null },
      },
      stockQuantity,
      isActive: true,
      isDefault: true,
    });

    return { product, variant };
  }

  async function createTestCoupon({ redemptionCount = 1 } = {}) {
    const couponId = crypto.randomUUID();
    createdCouponIds.add(couponId);
    return Coupon.create({
      id: couponId,
      code: `ORD${couponId.slice(0, 8).toUpperCase()}`,
      description: 'Test order coupon',
      discountPercentage: '10.00',
      minCartSubtotalInr: '500.00',
      minCartSubtotalUsd: '10.00',
      redemptionCount,
      visibility: 'public',
      isActive: true,
    });
  }

  async function createTestOrder({
    userId,
    variant = null,
    product = null,
    coupon = null,
    country = 'IN',
    currency = 'INR',
    status = ORDER_STATUSES.CONFIRMED,
    paymentMethod = PAYMENT_METHODS.RAZORPAY,
    paymentStatus = PAYMENT_STATUSES.PAID,
    subtotalAmount = '1800.00',
    discountAmount = '0.00',
    shippingAmount = '0.00',
    taxAmount = '52.43',
    grandTotalAmount = '1800.00',
    razorpayOrderId = `order_${crypto.randomBytes(6).toString('hex')}`,
    razorpayPaymentId =
      paymentStatus === PAYMENT_STATUSES.PAID ||
      paymentStatus === PAYMENT_STATUSES.REFUND_PENDING
        ? `pay_${crypto.randomBytes(6).toString('hex')}`
        : null,
    razorpaySignature = 'secret_signature_must_not_expose',
    paidAt =
      paymentStatus === PAYMENT_STATUSES.PAID ||
      paymentStatus === PAYMENT_STATUSES.REFUND_PENDING
        ? new Date()
        : null,
    quantity = 2,
    stockRestored = false,
  }) {
    const orderId = crypto.randomUUID();
    createdOrderIds.add(orderId);
    const orderNumber = `JPK-20261127-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const order = await Order.create({
      id: orderId,
      orderNumber,
      userId,
      country,
      currency,
      status,
      paymentMethod,
      paymentStatus,
      subtotalAmount,
      discountAmount,
      shippingAmount,
      taxAmount,
      grandTotalAmount,
      couponId: coupon ? coupon.id : null,
      couponCode: coupon ? coupon.code : null,
      couponSnapshot: coupon
        ? { code: coupon.code, discountPercentage: '10.00', discountAmount }
        : null,
      shippingAddress: {
        fullName: 'Ananya Sharma',
        phone: '+919876543210',
        addressLine1: 'Flat 402, Lotus Residency',
        addressLine2: null,
        landmark: null,
        city: 'Bengaluru',
        district: 'Bengaluru Urban',
        state: 'Karnataka',
        postalCode: '560038',
        country,
      },
      customerNotes: 'Handle carefully',
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      paidAt,
      stockRestored,
    });

    await OrderItem.create({
      id: crypto.randomUUID(),
      orderId: order.id,
      productId: product ? product.id : null,
      variantId: variant ? variant.id : null,
      productName: product ? product.name : 'Test Spiritual Stone',
      productSlug: product ? product.slug : 'test-spiritual-stone',
      variantTitle: variant ? variant.title : 'Default',
      sku: variant ? variant.sku : `SKU-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      optionValues: null,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/stone.webp',
      hsnCode: '7103',
      gstRate: '3.00',
      quantity,
      unitPrice: '2000.00',
      unitSalePrice: '1800.00',
      unitEffectivePrice: '1800.00',
      lineTotal: subtotalAmount,
      taxAmount,
    });

    return order;
  }

  afterEach(async () => {
    delete process.env.DISABLE_RATE_LIMIT;
    razorpayService.createRefund = originalCreateRefund;
    razorpayService.fetchOrderPayments = originalFetchOrderPayments;

    if (createdOrderIds.size > 0) {
      const orderIds = [...createdOrderIds];
      await OrderItem.destroy({ where: { orderId: orderIds } });
      await Order.destroy({ where: { id: orderIds } });
      createdOrderIds.clear();
    }

    if (createdCouponIds.size > 0) {
      await Coupon.destroy({ where: { id: [...createdCouponIds] }, force: true });
      createdCouponIds.clear();
    }

    if (createdVariantIds.size > 0) {
      await ProductVariant.destroy({ where: { id: [...createdVariantIds] }, force: true });
      createdVariantIds.clear();
    }

    if (createdProductIds.size > 0) {
      await Product.destroy({ where: { id: [...createdProductIds] }, force: true });
      createdProductIds.clear();
    }

    if (createdCategoryIds.size > 0) {
      await Category.destroy({ where: { id: [...createdCategoryIds] }, force: true });
      createdCategoryIds.clear();
    }

    if (createdUserIds.size > 0) {
      await User.destroy({ where: { id: [...createdUserIds] }, force: true });
      createdUserIds.clear();
    }

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

  it('enforces auth and strict RBAC (denying catalog_manager PII access and moderator mutations)', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';

    const unauth = await request(app).get('/api/v1/orders');
    assert.equal(unauth.status, 401);

    const catalogCookie = await createAndLoginAdmin(ADMIN_ROLES.CATALOG_MANAGER);
    const modCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPPORT_MODERATOR);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);

    const user = await createTestUser();
    const order = await createTestOrder({ userId: user.id });

    // catalog_manager is completely blocked from customer order PII
    for (const endpoint of ['/api/v1/orders', '/api/v1/orders/summary', `/api/v1/orders/${order.id}`]) {
      const res = await request(app).get(endpoint).set('Cookie', catalogCookie);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    }

    // support_moderator can read list, summary, and detail, but cannot mutate
    const modList = await request(app).get('/api/v1/orders').set('Cookie', modCookie);
    assert.equal(modList.status, 200);

    const modSummary = await request(app).get('/api/v1/orders/summary').set('Cookie', modCookie);
    assert.equal(modSummary.status, 200);

    const modDetail = await request(app)
      .get(`/api/v1/orders/${order.orderNumber.toLowerCase()}`)
      .set('Cookie', modCookie);
    assert.equal(modDetail.status, 200);
    assert.equal('razorpaySignature' in modDetail.body.data.order, false);
    assert.equal('razorpaySignature' in modDetail.body.data.order.payment, false);

    const modMutateForbidden = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', modCookie)
      .send({ status: 'processing' });
    assert.equal(modMutateForbidden.status, 403);

    // operations_manager can mutate
    const opsMutate = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'processing' });
    assert.equal(opsMutate.status, 200);
    assert.equal(opsMutate.body.data.order.status, 'processing');
  });

  it('lists, searches, filters orders and computes currency-separated /summary KPIs', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);

    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    const user = await createTestUser({
      email: `ananya.${uniqueSuffix}@japaika-order-test.local`,
      fullName: `Ananya Search ${uniqueSuffix}`,
    });

    const beforeSummaryRes = await request(app)
      .get('/api/v1/orders/summary')
      .set('Cookie', opsCookie);
    assert.equal(beforeSummaryRes.status, 200);
    const beforeInr = Number(beforeSummaryRes.body.data.summary.paidRevenue.INR);
    const beforeUsd = Number(beforeSummaryRes.body.data.summary.paidRevenue.USD);

    const inOrder = await createTestOrder({
      userId: user.id,
      country: 'IN',
      currency: 'INR',
      status: ORDER_STATUSES.CONFIRMED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      grandTotalAmount: '2500.50',
    });

    const usOrder = await createTestOrder({
      userId: user.id,
      country: 'US',
      currency: 'USD',
      status: ORDER_STATUSES.SHIPPED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      grandTotalAmount: '120.00',
    });

    await createTestOrder({
      userId: user.id,
      country: 'IN',
      currency: 'INR',
      status: ORDER_STATUSES.PENDING_PAYMENT,
      paymentStatus: PAYMENT_STATUSES.PENDING,
      grandTotalAmount: '999.00',
    });

    // Search by customer email + US filter
    const searchRes = await request(app)
      .get(`/api/v1/orders?search=ananya.${uniqueSuffix}&country=US`)
      .set('Cookie', opsCookie);
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.data.items.length, 1);
    assert.equal(searchRes.body.data.items[0].id, usOrder.id);

    // Search by orderNumber
    const numSearchRes = await request(app)
      .get(`/api/v1/orders?search=${inOrder.orderNumber}`)
      .set('Cookie', opsCookie);
    assert.equal(numSearchRes.status, 200);
    assert.equal(numSearchRes.body.data.items.length, 1);
    assert.equal(numSearchRes.body.data.items[0].id, inOrder.id);

    // Verify /summary keeps INR and USD paidRevenue separate
    const afterSummaryRes = await request(app)
      .get('/api/v1/orders/summary')
      .set('Cookie', opsCookie);
    assert.equal(afterSummaryRes.status, 200);
    const summary = afterSummaryRes.body.data.summary;
    assert.equal(Number(summary.paidRevenue.INR).toFixed(2), (beforeInr + 2500.5).toFixed(2));
    assert.equal(Number(summary.paidRevenue.USD).toFixed(2), (beforeUsd + 120).toFixed(2));
    assert.ok(summary.actionRequired.awaitingFulfillment >= 1);
    assert.ok(summary.actionRequired.pendingPayments >= 1);
  });

  it('enforces fulfillment state machine, payment gate, tracking validation, and XSS URL rejection', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const user = await createTestUser();

    // Unpaid Razorpay order cannot advance fulfillment
    const unpaidOrder = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.CONFIRMED,
      paymentMethod: PAYMENT_METHODS.RAZORPAY,
      paymentStatus: PAYMENT_STATUSES.PENDING,
    });
    const unpaidBlockRes = await request(app)
      .patch(`/api/v1/orders/${unpaidOrder.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'processing' });
    assert.equal(unpaidBlockRes.status, 409);
    assert.equal(unpaidBlockRes.body.error.code, 'ORDER_NOT_PAID');

    // Paid order full lifecycle: confirmed -> processing -> packed -> shipped -> delivered
    const order = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.CONFIRMED,
      paymentMethod: PAYMENT_METHODS.RAZORPAY,
      paymentStatus: PAYMENT_STATUSES.PAID,
    });

    // Reject cancelled status via /status
    const useCancelRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'cancelled' });
    assert.equal(useCancelRes.status, 400);
    assert.equal(useCancelRes.body.error.code, 'USE_CANCEL_ENDPOINT');

    // Reject invalid jump confirmed -> shipped
    const invalidJump = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'shipped', courierName: 'BlueDart', awbNumber: 'BD123' });
    assert.equal(invalidJump.status, 409);
    assert.equal(invalidJump.body.error.code, 'INVALID_STATUS_TRANSITION');

    // confirmed -> processing -> packed
    const procRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'processing' });
    assert.equal(procRes.status, 200);

    const packedRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'packed' });
    assert.equal(packedRes.status, 200);

    // Reject packed -> shipped without tracking info
    const noTrackShip = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'shipped' });
    assert.equal(noTrackShip.status, 400);
    assert.equal(noTrackShip.body.error.code, 'TRACKING_REQUIRED_FOR_SHIPMENT');

    // Reject unsafe trackingUrl
    const badUrlRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/tracking`)
      .set('Cookie', opsCookie)
      .send({ trackingUrl: 'javascript:alert(1)' });
    assert.equal(badUrlRes.status, 400);

    // packed -> shipped with courierName + awbNumber + safe trackingUrl
    const shippedRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({
        status: 'shipped',
        courierName: 'BlueDart',
        awbNumber: 'BD99887766',
        trackingUrl: 'https://www.bluedart.com/track/BD99887766',
      });
    assert.equal(shippedRes.status, 200);
    assert.equal(shippedRes.body.data.order.status, 'shipped');
    assert.ok(shippedRes.body.data.order.tracking.shippedAt);
    assert.equal(shippedRes.body.data.order.canCancel, false);

    // Cannot clear awbNumber once shipped
    const clearAwbRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/tracking`)
      .set('Cookie', opsCookie)
      .send({ awbNumber: null });
    assert.equal(clearAwbRes.status, 400);

    // shipped -> delivered
    const deliveredRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/status`)
      .set('Cookie', opsCookie)
      .send({ status: 'delivered' });
    assert.equal(deliveredRes.status, 200);
    assert.equal(deliveredRes.body.data.order.status, 'delivered');
    assert.ok(deliveredRes.body.data.order.tracking.deliveredAt);
    assert.deepEqual(deliveredRes.body.data.order.allowedNextStatuses, []);
    assert.equal(deliveredRes.body.data.order.canRefund, true);
  });

  it('manages payment statuses and reconciles stuck payments via Razorpay sync-payment', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const user = await createTestUser();

    const order = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.PENDING_PAYMENT,
      paymentMethod: PAYMENT_METHODS.RAZORPAY,
      paymentStatus: PAYMENT_STATUSES.PENDING,
      grandTotalAmount: '1800.00',
    });

    // pending -> failed -> pending -> paid
    const failRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/payment-status`)
      .set('Cookie', opsCookie)
      .send({ paymentStatus: 'failed' });
    assert.equal(failRes.status, 200);
    assert.equal(failRes.body.data.order.paymentStatus, 'failed');

    const resetRes = await request(app)
      .patch(`/api/v1/orders/${order.id}/payment-status`)
      .set('Cookie', opsCookie)
      .send({ paymentStatus: 'pending' });
    assert.equal(resetRes.status, 200);

    // Reject direct refunded via payment-status endpoint
    const directRefundRejected = await request(app)
      .patch(`/api/v1/orders/${order.id}/payment-status`)
      .set('Cookie', opsCookie)
      .send({ paymentStatus: 'refunded' });
    assert.equal(directRefundRejected.status, 400);
    assert.equal(directRefundRejected.body.error.code, 'USE_REFUND_ENDPOINT');

    // Sync payment against stubbed Razorpay order payments API
    razorpayService.fetchOrderPayments = async () => [
      { id: 'pay_Synced999', status: 'captured', amount: 180000, currency: 'INR' },
    ];

    const syncRes = await request(app)
      .post(`/api/v1/orders/${order.orderNumber}/sync-payment`)
      .set('Cookie', opsCookie);
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.data.synced, true);
    assert.equal(syncRes.body.data.order.status, 'confirmed');
    assert.equal(syncRes.body.data.order.paymentStatus, 'paid');
    assert.equal(syncRes.body.data.order.payment.razorpayPaymentId, 'pay_Synced999');
  });

  it('cancels pre-shipment orders with atomic stock/coupon restoration and skips when restoreStock=false', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const user = await createTestUser();

    const { product, variant } = await createTestCatalogItem({ stockQuantity: 4 });
    const coupon = await createTestCoupon({ redemptionCount: 2 });

    // Order 1: paid + packed, cancel with restoreStock=true
    const order1 = await createTestOrder({
      userId: user.id,
      product,
      variant,
      coupon,
      quantity: 3,
      status: ORDER_STATUSES.PACKED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      grandTotalAmount: '1620.00',
      discountAmount: '180.00',
    });

    const cancel1 = await request(app)
      .post(`/api/v1/orders/${order1.id}/cancel`)
      .set('Cookie', opsCookie)
      .send({ reason: 'Customer requested cancellation before dispatch', restoreStock: true });
    assert.equal(cancel1.status, 200);
    assert.equal(cancel1.body.data.order.status, 'cancelled');
    assert.equal(cancel1.body.data.order.paymentStatus, 'refund_pending');
    assert.equal(cancel1.body.data.order.stockRestored, true);
    assert.equal(cancel1.body.data.order.cancellation.cancelledBy, 'admin');
    assert.equal(cancel1.body.data.order.payment.refundAmount, '1620.00');

    const refreshedVariant = await ProductVariant.findByPk(variant.id);
    const refreshedCoupon = await Coupon.findByPk(coupon.id);
    assert.equal(Number(refreshedVariant.stockQuantity), 7);
    assert.equal(Number(refreshedCoupon.redemptionCount), 1);

    // Order 2: cancel with restoreStock=false leaves stock untouched
    const order2 = await createTestOrder({
      userId: user.id,
      product,
      variant,
      quantity: 2,
      status: ORDER_STATUSES.PENDING_PAYMENT,
      paymentStatus: PAYMENT_STATUSES.PENDING,
    });

    const cancel2 = await request(app)
      .post(`/api/v1/orders/${order2.id}/cancel`)
      .set('Cookie', opsCookie)
      .send({ reason: 'Damaged unit discovered in QC', restoreStock: false });
    assert.equal(cancel2.status, 200);
    assert.equal(cancel2.body.data.order.stockRestored, false);

    const variantAfterNoRestore = await ProductVariant.findByPk(variant.id);
    assert.equal(Number(variantAfterNoRestore.stockQuantity), 7);

    // Shipped order cannot be cancelled via /cancel
    const shippedOrder = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.SHIPPED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    });
    const cancelShipped = await request(app)
      .post(`/api/v1/orders/${shippedOrder.id}/cancel`)
      .set('Cookie', opsCookie)
      .send({ reason: 'Late cancellation attempt' });
    assert.equal(cancelShipped.status, 409);
    assert.equal(cancelShipped.body.error.code, 'ORDER_CANNOT_BE_CANCELLED');
  });

  it('processes full and partial Razorpay & manual refunds with double-refund & state guards', async () => {
    process.env.DISABLE_RATE_LIMIT = 'true';
    const superCookie = await createAndLoginAdmin(ADMIN_ROLES.SUPER_ADMIN);
    const opsCookie = await createAndLoginAdmin(ADMIN_ROLES.OPERATIONS_MANAGER);
    const user = await createTestUser();

    // Active uncancelled confirmed order cannot be refunded directly
    const activeConfirmed = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.CONFIRMED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      grandTotalAmount: '1500.00',
    });
    const uncancelledRefund = await request(app)
      .post(`/api/v1/orders/${activeConfirmed.id}/refund`)
      .set('Cookie', opsCookie)
      .send({ mode: 'razorpay' });
    assert.equal(uncancelledRefund.status, 409);
    assert.equal(uncancelledRefund.body.error.code, 'ORDER_MUST_BE_CANCELLED_FIRST');

    // Cancelled refund_pending Razorpay order -> partial Razorpay refund
    const cancelledOrder = await createTestOrder({
      userId: user.id,
      status: ORDER_STATUSES.CANCELLED,
      paymentStatus: PAYMENT_STATUSES.REFUND_PENDING,
      grandTotalAmount: '1800.00',
      stockRestored: true,
    });

    // Reject over-refund above grandTotalAmount
    const overRefund = await request(app)
      .post(`/api/v1/orders/${cancelledOrder.id}/refund`)
      .set('Cookie', opsCookie)
      .send({ mode: 'razorpay', amount: '2000.00' });
    assert.equal(overRefund.status, 400);

    let gatewayArgs = null;
    razorpayService.createRefund = async (args) => {
      gatewayArgs = args;
      return {
        razorpayRefundId: 'rfnd_LiveStub001',
        amountMinor: args.amountMinor,
        currency: 'INR',
        status: 'processed',
        speedRequested: args.speed,
        speedProcessed: 'normal',
      };
    };

    const refundRes = await request(app)
      .post(`/api/v1/orders/${cancelledOrder.id}/refund`)
      .set('Cookie', superCookie)
      .send({ mode: 'razorpay', amount: 1500, notes: 'Partial restocking deduction' });
    assert.equal(refundRes.status, 200);
    assert.equal(gatewayArgs.amountMinor, 150000);
    assert.equal(refundRes.body.data.refund.razorpayRefundId, 'rfnd_LiveStub001');
    assert.equal(refundRes.body.data.order.paymentStatus, 'refunded');
    assert.equal(refundRes.body.data.order.payment.refundAmount, '1500.00');
    assert.ok(refundRes.body.data.order.payment.refundedAt);
    assert.equal(refundRes.body.data.order.canRefund, false);

    // Duplicate refund attempt rejected with 409
    const doubleRefund = await request(app)
      .post(`/api/v1/orders/${cancelledOrder.id}/refund`)
      .set('Cookie', superCookie)
      .send({ mode: 'manual' });
    assert.equal(doubleRefund.status, 409);
    assert.equal(doubleRefund.body.error.code, 'ORDER_ALREADY_REFUNDED');

    // Post-delivery manual refund with restoreStock=true
    const { product, variant } = await createTestCatalogItem({ stockQuantity: 2 });
    const deliveredOrder = await createTestOrder({
      userId: user.id,
      product,
      variant,
      quantity: 1,
      status: ORDER_STATUSES.DELIVERED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      grandTotalAmount: '1800.00',
    });

    const manualRefundRes = await request(app)
      .post(`/api/v1/orders/${deliveredOrder.id}/refund`)
      .set('Cookie', opsCookie)
      .send({
        mode: 'manual',
        razorpayRefundId: 'rfnd_ManualDash02',
        restoreStock: true,
      });
    assert.equal(manualRefundRes.status, 200);
    assert.equal(manualRefundRes.body.data.order.paymentStatus, 'refunded');
    assert.equal(manualRefundRes.body.data.order.payment.refundAmount, '1800.00');
    assert.equal(manualRefundRes.body.data.order.payment.razorpayRefundId, 'rfnd_ManualDash02');
    assert.equal(manualRefundRes.body.data.order.stockRestored, true);

    const restockedVariant = await ProductVariant.findByPk(variant.id);
    assert.equal(Number(restockedVariant.stockQuantity), 3);
  });
});
