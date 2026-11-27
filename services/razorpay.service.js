import Razorpay from 'razorpay';
import { AppError } from '../utils/http.js';

let cachedClient = null;
let cachedKeyId = '';
let cachedKeySecret = '';

export function getRazorpayConfig(raw = process.env) {
  const keyId = (raw.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (raw.RAZORPAY_KEY_SECRET || '').trim();

  if (!keyId || !keySecret) {
    throw new AppError(
      503,
      'PAYMENT_GATEWAY_UNCONFIGURED',
      'Razorpay payment credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured.'
    );
  }

  return { keyId, keySecret };
}

export function getRazorpayClient() {
  const { keyId, keySecret } = getRazorpayConfig();

  if (!cachedClient || cachedKeyId !== keyId || cachedKeySecret !== keySecret) {
    cachedClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
    cachedKeyId = keyId;
    cachedKeySecret = keySecret;
  }

  return { client: cachedClient, keyId };
}

function mapRazorpayError(err, fallbackMessage) {
  if (err instanceof AppError) {
    return err;
  }

  if (err?.statusCode || err?.error?.description || err?.error?.reason) {
    return new AppError(
      502,
      'PAYMENT_GATEWAY_ERROR',
      err?.error?.description || err?.error?.reason || fallbackMessage
    );
  }

  return new AppError(
    502,
    'PAYMENT_GATEWAY_UNAVAILABLE',
    'Unable to connect to Razorpay right now. Please try again.'
  );
}

export async function createRefund({
  razorpayPaymentId,
  amountMinor,
  speed = 'normal',
  receipt = null,
  notes = {},
}) {
  const paymentId = typeof razorpayPaymentId === 'string' ? razorpayPaymentId.trim() : '';
  if (!paymentId) {
    throw new AppError(
      400,
      'MISSING_RAZORPAY_PAYMENT_ID',
      'Order does not have a valid Razorpay payment ID for gateway refund.'
    );
  }

  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Refund amount must be at least 0.01 in the order currency.'
    );
  }

  const { client } = razorpayService.getRazorpayClient();

  const payload = {
    amount: amountMinor,
    speed,
    ...(receipt ? { receipt: String(receipt).slice(0, 40) } : {}),
    ...(notes && Object.keys(notes).length > 0 ? { notes } : {}),
  };

  let data;
  try {
    data = await client.payments.refund(paymentId, payload);
  } catch (err) {
    throw mapRazorpayError(err, 'Failed to create refund with Razorpay.');
  }

  if (!data?.id) {
    throw new AppError(
      502,
      'PAYMENT_GATEWAY_ERROR',
      'Razorpay refund response did not include a refund ID.'
    );
  }

  return {
    razorpayRefundId: data.id,
    amountMinor: Number(data.amount ?? amountMinor),
    currency: data.currency ? String(data.currency).toUpperCase() : null,
    status: data.status || 'processed',
    speedRequested: data.speed_requested ?? speed,
    speedProcessed: data.speed_processed ?? null,
  };
}

export async function fetchOrderPayments(razorpayOrderId) {
  const orderId = typeof razorpayOrderId === 'string' ? razorpayOrderId.trim() : '';
  if (!orderId) {
    throw new AppError(
      400,
      'MISSING_RAZORPAY_ORDER_ID',
      'Order does not have a Razorpay order ID.'
    );
  }

  const { client } = razorpayService.getRazorpayClient();

  let data;
  try {
    data = await client.orders.fetchPayments(orderId);
  } catch (err) {
    throw mapRazorpayError(err, 'Failed to fetch order payments from Razorpay.');
  }

  return Array.isArray(data?.items) ? data.items : [];
}

const razorpayService = {
  getRazorpayConfig,
  getRazorpayClient,
  createRefund,
  fetchOrderPayments,
};

export default razorpayService;
