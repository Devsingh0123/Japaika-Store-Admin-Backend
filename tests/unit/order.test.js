import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  User,
  Order,
  OrderItem,
  ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  PAYMENT_METHODS,
  ALL_PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ALL_PAYMENT_STATUSES,
  CANCELLED_BY_ACTORS,
  ALL_CANCELLED_BY_ACTORS,
} from '../../models/index.js';
import {
  resolveOrderLookup,
  validateTrackingUrl,
  getAllowedNextStatuses,
  serializeAdminOrderDetail,
} from '../../services/order.service.js';
import razorpayService, {
  getRazorpayConfig,
  getRazorpayClient,
  createRefund,
  fetchOrderPayments,
} from '../../services/razorpay.service.js';

describe('Order models, transitions, serializers & Razorpay client unit tests', () => {
  const originalGetRazorpayClient = razorpayService.getRazorpayClient;
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;

  afterEach(() => {
    razorpayService.getRazorpayClient = originalGetRazorpayClient;
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;

    if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  });

  it('defines Order, OrderItem, and User schemas & enums matching docs/DATABASE_SCHEMA.md §12', () => {
    assert.equal(User.getTableName(), 'users');
    assert.equal(Order.getTableName(), 'orders');
    assert.equal(OrderItem.getTableName(), 'order_items');

    assert.deepEqual(ALL_ORDER_STATUSES, [
      'pending_payment',
      'confirmed',
      'processing',
      'packed',
      'shipped',
      'delivered',
      'cancelled',
    ]);
    assert.deepEqual(ALL_PAYMENT_METHODS, ['razorpay', 'cod']);
    assert.deepEqual(ALL_PAYMENT_STATUSES, [
      'pending',
      'paid',
      'failed',
      'refund_pending',
      'refunded',
    ]);
    assert.deepEqual(ALL_CANCELLED_BY_ACTORS, ['customer', 'admin']);

    assert.ok(Order.rawAttributes.razorpaySignature);
    assert.equal(Order.rawAttributes.razorpaySignature.field, 'razorpay_signature');
    assert.equal(Order.rawAttributes.stockRestored.field, 'stock_restored');
    assert.equal(OrderItem.rawAttributes.unitEffectivePrice.field, 'unit_effective_price');
  });

  it('resolves UUID or orderNumber lookup and rejects malformed identifiers', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    assert.deepEqual(resolveOrderLookup(uuid), { id: uuid });
    assert.deepEqual(resolveOrderLookup('jpk-20261127-ab12cd'), {
      orderNumber: 'JPK-20261127-AB12CD',
    });

    assert.throws(
      () => resolveOrderLookup('bad-order-id'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  it('sanitizes trackingUrl and rejects unsafe protocols', () => {
    assert.equal(validateTrackingUrl(undefined), undefined);
    assert.equal(validateTrackingUrl(null), null);
    assert.equal(validateTrackingUrl('   '), null);
    assert.equal(
      validateTrackingUrl(' https://track.example.com/awb/12345 '),
      'https://track.example.com/awb/12345'
    );

    assert.throws(
      () => validateTrackingUrl('javascript:alert(1)'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateTrackingUrl('data:text/html,<script>'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateTrackingUrl('not-a-valid-url'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  it('computes allowedNextStatuses respecting Razorpay payment gate and terminal states', () => {
    assert.deepEqual(
      getAllowedNextStatuses({
        status: ORDER_STATUSES.CONFIRMED,
        paymentMethod: PAYMENT_METHODS.RAZORPAY,
        paymentStatus: PAYMENT_STATUSES.PENDING,
      }),
      []
    );

    assert.deepEqual(
      getAllowedNextStatuses({
        status: ORDER_STATUSES.CONFIRMED,
        paymentMethod: PAYMENT_METHODS.RAZORPAY,
        paymentStatus: PAYMENT_STATUSES.PAID,
      }),
      [ORDER_STATUSES.PROCESSING, ORDER_STATUSES.PACKED]
    );

    assert.deepEqual(
      getAllowedNextStatuses({
        status: ORDER_STATUSES.PACKED,
        paymentMethod: PAYMENT_METHODS.COD,
        paymentStatus: PAYMENT_STATUSES.PENDING,
      }),
      [ORDER_STATUSES.SHIPPED]
    );

    assert.deepEqual(
      getAllowedNextStatuses({
        status: ORDER_STATUSES.CANCELLED,
        paymentMethod: PAYMENT_METHODS.RAZORPAY,
        paymentStatus: PAYMENT_STATUSES.REFUNDED,
      }),
      []
    );
  });

  it('omits razorpaySignature in serialized order detail', () => {
    const serialized = serializeAdminOrderDetail({
      id: 'ord-1',
      orderNumber: 'JPK-20261127-AAAAAA',
      status: ORDER_STATUSES.CONFIRMED,
      paymentMethod: PAYMENT_METHODS.RAZORPAY,
      paymentStatus: PAYMENT_STATUSES.PAID,
      country: 'IN',
      currency: 'INR',
      subtotalAmount: '1000.00',
      discountAmount: '100.00',
      shippingAmount: '0.00',
      taxAmount: '26.21',
      grandTotalAmount: '900.00',
      shippingAddress: { fullName: 'A', phone: '1', addressLine1: 'Line', city: 'C', state: 'S', postalCode: '560001', country: 'IN' },
      razorpayOrderId: 'order_123',
      razorpayPaymentId: 'pay_123',
      razorpaySignature: 'secret_hmac_signature_should_never_leak',
      stockRestored: false,
      items: [],
    });

    assert.equal('razorpaySignature' in serialized, false);
    assert.equal('razorpaySignature' in serialized.payment, false);
    assert.equal(serialized.payment.razorpayOrderId, 'order_123');
    assert.equal(serialized.payment.razorpayPaymentId, 'pay_123');
    assert.equal(CANCELLED_BY_ACTORS.ADMIN, 'admin');
  });

  it('validates Razorpay credentials and executes refund & payment-fetch SDK calls cleanly', async () => {
    assert.throws(
      () => getRazorpayConfig({}),
      (err) => err.statusCode === 503 && err.code === 'PAYMENT_GATEWAY_UNCONFIGURED'
    );

    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_xyz';

    const { client: sdkClient, keyId } = getRazorpayClient();
    assert.equal(keyId, 'rzp_test_abc');
    assert.equal(typeof sdkClient.payments?.refund, 'function');
    assert.equal(typeof sdkClient.orders?.fetchPayments, 'function');

    let capturedRefundCall = null;
    razorpayService.getRazorpayClient = () => ({
      keyId: 'rzp_test_abc',
      client: {
        payments: {
          refund: async (paymentId, payload) => {
            capturedRefundCall = { paymentId, payload };
            return {
              id: 'rfnd_Test123',
              amount: 1620000,
              currency: 'INR',
              status: 'processed',
              speed_requested: 'normal',
              speed_processed: 'normal',
            };
          },
        },
        orders: {
          fetchPayments: async (orderId) => {
            assert.equal(orderId, 'order_Test123');
            return { items: [{ id: 'pay_1', status: 'captured', amount: 50000 }] };
          },
        },
      },
    });

    const refund = await createRefund({
      razorpayPaymentId: 'pay_Test999',
      amountMinor: 1620000,
      speed: 'normal',
      receipt: 'JPK-20261127-AAAAAA',
      notes: { reason: 'Admin test' },
    });

    assert.equal(capturedRefundCall.paymentId, 'pay_Test999');
    assert.equal(capturedRefundCall.payload.amount, 1620000);
    assert.equal(capturedRefundCall.payload.speed, 'normal');
    assert.equal(capturedRefundCall.payload.receipt, 'JPK-20261127-AAAAAA');
    assert.deepEqual(capturedRefundCall.payload.notes, { reason: 'Admin test' });
    assert.equal(refund.razorpayRefundId, 'rfnd_Test123');
    assert.equal(refund.amountMinor, 1620000);
    assert.equal(refund.status, 'processed');

    const items = await fetchOrderPayments('order_Test123');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'pay_1');

    // Gateway API error mapping (SDK error -> 502 PAYMENT_GATEWAY_ERROR)
    razorpayService.getRazorpayClient = () => ({
      keyId: 'rzp_test_abc',
      client: {
        payments: {
          refund: async () => {
            throw { statusCode: 400, error: { description: 'Payment already fully refunded.' } };
          },
        },
        orders: {
          fetchPayments: async () => {
            throw new Error('network down');
          },
        },
      },
    });

    await assert.rejects(
      () => createRefund({ razorpayPaymentId: 'pay_Test999', amountMinor: 100 }),
      (err) =>
        err.statusCode === 502 &&
        err.code === 'PAYMENT_GATEWAY_ERROR' &&
        err.message.includes('already fully refunded')
    );

    // Network error mapping (502 PAYMENT_GATEWAY_UNAVAILABLE)
    await assert.rejects(
      () => fetchOrderPayments('order_Test123'),
      (err) => err.statusCode === 502 && err.code === 'PAYMENT_GATEWAY_UNAVAILABLE'
    );
  });
});
