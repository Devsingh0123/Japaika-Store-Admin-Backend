import { Op, fn, col } from 'sequelize';
import {
  sequelize,
  User,
  ProductVariant,
  Order,
  OrderItem,
  ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ALL_PAYMENT_STATUSES,
  CANCELLED_BY_ACTORS,
} from '../models/index.js';
import { parseDecimalToMinorUnits, formatMinorUnits } from './coupon.service.js';
import { normalizeSupportedCountry } from './shippingSetting.service.js';
import razorpayService from './razorpay.service.js';
import { AppError } from '../utils/http.js';

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ORDER_NUMBER_REGEX = /^JPK-\d{8}-[A-Z0-9]{6}$/i;
export const RAZORPAY_PAYMENT_ID_REGEX = /^pay_[A-Za-z0-9]+$/;
export const RAZORPAY_REFUND_ID_REGEX = /^rfnd_[A-Za-z0-9]+$/;

export const ALLOWED_FULFILLMENT_TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.PENDING_PAYMENT]: Object.freeze([]),
  [ORDER_STATUSES.CONFIRMED]: Object.freeze([ORDER_STATUSES.PROCESSING, ORDER_STATUSES.PACKED]),
  [ORDER_STATUSES.PROCESSING]: Object.freeze([ORDER_STATUSES.PACKED]),
  [ORDER_STATUSES.PACKED]: Object.freeze([ORDER_STATUSES.SHIPPED]),
  [ORDER_STATUSES.SHIPPED]: Object.freeze([ORDER_STATUSES.DELIVERED]),
  [ORDER_STATUSES.DELIVERED]: Object.freeze([]),
  [ORDER_STATUSES.CANCELLED]: Object.freeze([]),
});

export const CANCELLABLE_ADMIN_STATUSES = Object.freeze([
  ORDER_STATUSES.PENDING_PAYMENT,
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PROCESSING,
  ORDER_STATUSES.PACKED,
]);

export const TRACKING_EDITABLE_STATUSES = Object.freeze([
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PROCESSING,
  ORDER_STATUSES.PACKED,
  ORDER_STATUSES.SHIPPED,
]);

export const REFUNDABLE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUSES.CANCELLED,
  ORDER_STATUSES.SHIPPED,
  ORDER_STATUSES.DELIVERED,
]);

const ORDER_SORT_FIELDS = Object.freeze({
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  grandTotalAmount: 'grand_total_amount',
  paidAt: 'paid_at',
  shippedAt: 'shipped_at',
  status: 'status',
});

// Process-local concurrency guard preventing duplicate external Razorpay refund calls
const inFlightRefundOrderIds = new Set();

function logOrderAudit(action, admin, orderId, orderNumber, details = {}) {
  if (process.env.NODE_ENV === 'test') return;
  console.info(
    JSON.stringify({
      type: 'admin_audit',
      domain: 'orders',
      action,
      orderId,
      orderNumber,
      adminId: admin?.id ?? null,
      adminRole: admin?.role ?? null,
      ...details,
      timestamp: new Date().toISOString(),
    })
  );
}

export function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function decimalToMinorUnits(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100);
}

function escapeLikeTerm(term) {
  return String(term).replace(/[\\%_]/g, '\\$&');
}

export function resolveOrderLookup(idOrNumber) {
  const raw = typeof idOrNumber === 'string' ? idOrNumber.trim() : '';
  if (UUID_REGEX.test(raw)) {
    return { id: raw };
  }
  if (ORDER_NUMBER_REGEX.test(raw)) {
    return { orderNumber: raw.toUpperCase() };
  }
  throw new AppError(
    400,
    'VALIDATION_ERROR',
    'Invalid order identifier. Provide a valid UUID or order number (JPK-YYYYMMDD-XXXXXX).',
    [{ field: 'id', message: 'Invalid order ID or order number format.' }]
  );
}

export function validateTrackingUrl(rawUrl) {
  if (rawUrl === undefined) return undefined;
  if (rawUrl === null) return null;
  if (typeof rawUrl !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'trackingUrl must be a string or null.', [
      { field: 'trackingUrl', message: 'Invalid tracking URL type.' },
    ]);
  }

  const trimmed = rawUrl.trim();
  if (trimmed === '') return null;

  if (trimmed.length > 500) {
    throw new AppError(400, 'VALIDATION_ERROR', 'trackingUrl must not exceed 500 characters.', [
      { field: 'trackingUrl', message: 'trackingUrl exceeds maximum length of 500 characters.' },
    ]);
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'trackingUrl must be a valid http:// or https:// URL.', [
      { field: 'trackingUrl', message: 'Invalid URL format.' },
    ]);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'trackingUrl must use http:// or https:// protocol.',
      [{ field: 'trackingUrl', message: 'Unsupported URL protocol.' }]
    );
  }

  return trimmed;
}

export function getAllowedNextStatuses(order) {
  if (!order) return [];
  if (order.paymentMethod === PAYMENT_METHODS.RAZORPAY && order.paymentStatus !== PAYMENT_STATUSES.PAID) {
    return [];
  }
  return [...(ALLOWED_FULFILLMENT_TRANSITIONS[order.status] || [])];
}

function canOrderRefund(order) {
  if (!order) return false;
  if (order.paymentStatus === PAYMENT_STATUSES.REFUNDED || Boolean(order.razorpayRefundId)) {
    return false;
  }
  if (![PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.REFUND_PENDING].includes(order.paymentStatus)) {
    return false;
  }
  return REFUNDABLE_ORDER_STATUSES.includes(order.status);
}

export function serializeOrderItem(item) {
  return {
    id: item.id,
    productId: item.productId ?? null,
    variantId: item.variantId ?? null,
    productName: item.productName,
    productSlug: item.productSlug,
    variantTitle: item.variantTitle ?? null,
    sku: item.sku,
    optionValues: parseJsonField(item.optionValues, null),
    imageUrl: item.imageUrl ?? null,
    hsnCode: item.hsnCode ?? null,
    gstRate: formatMinorUnits(decimalToMinorUnits(item.gstRate)),
    quantity: Number(item.quantity),
    unitPrice: formatMinorUnits(decimalToMinorUnits(item.unitPrice)),
    unitSalePrice:
      item.unitSalePrice !== null && item.unitSalePrice !== undefined
        ? formatMinorUnits(decimalToMinorUnits(item.unitSalePrice))
        : null,
    unitEffectivePrice: formatMinorUnits(decimalToMinorUnits(item.unitEffectivePrice)),
    lineTotal: formatMinorUnits(decimalToMinorUnits(item.lineTotal)),
    taxAmount: formatMinorUnits(decimalToMinorUnits(item.taxAmount)),
  };
}

export function serializeCustomerSummary(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName ?? null,
    phone: user.phone ?? null,
    status: user.status,
  };
}

export function serializeAdminOrderSummary(order, items = []) {
  const itemCount = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const createdAt = order.created_at ?? order.createdAt ?? null;
  const updatedAt = order.updated_at ?? order.updatedAt ?? null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    country: order.country,
    currency: order.currency,
    grandTotalAmount: formatMinorUnits(decimalToMinorUnits(order.grandTotalAmount)),
    itemCount,
    customer: serializeCustomerSummary(order.user),
    couponCode: order.couponCode ?? null,
    tracking: {
      courierName: order.courierName ?? null,
      awbNumber: order.awbNumber ?? null,
      trackingUrl: order.trackingUrl ?? null,
      shippedAt: order.shippedAt ? new Date(order.shippedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    },
    paidAt: order.paidAt ? new Date(order.paidAt).toISOString() : null,
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
    refundedAt: order.refundedAt ? new Date(order.refundedAt).toISOString() : null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

export function serializeAdminOrderDetail(order) {
  const items = Array.isArray(order.items) ? order.items.map(serializeOrderItem) : [];
  const createdAt = order.created_at ?? order.createdAt ?? null;
  const updatedAt = order.updated_at ?? order.updatedAt ?? null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    country: order.country,
    currency: order.currency,
    customer: serializeCustomerSummary(order.user),
    pricing: {
      subtotalAmount: formatMinorUnits(decimalToMinorUnits(order.subtotalAmount)),
      discountAmount: formatMinorUnits(decimalToMinorUnits(order.discountAmount)),
      shippingAmount: formatMinorUnits(decimalToMinorUnits(order.shippingAmount)),
      taxAmount: formatMinorUnits(decimalToMinorUnits(order.taxAmount)),
      grandTotalAmount: formatMinorUnits(decimalToMinorUnits(order.grandTotalAmount)),
    },
    couponId: order.couponId ?? null,
    couponCode: order.couponCode ?? null,
    couponSnapshot: parseJsonField(order.couponSnapshot, null),
    shippingAddress: parseJsonField(order.shippingAddress, null),
    customerNotes: order.customerNotes ?? null,
    payment: {
      method: order.paymentMethod,
      status: order.paymentStatus,
      razorpayOrderId: order.razorpayOrderId ?? null,
      razorpayPaymentId: order.razorpayPaymentId ?? null,
      paidAt: order.paidAt ? new Date(order.paidAt).toISOString() : null,
      refundAmount:
        order.refundAmount !== null && order.refundAmount !== undefined
          ? formatMinorUnits(decimalToMinorUnits(order.refundAmount))
          : null,
      razorpayRefundId: order.razorpayRefundId ?? null,
      refundedAt: order.refundedAt ? new Date(order.refundedAt).toISOString() : null,
    },
    tracking: {
      courierName: order.courierName ?? null,
      awbNumber: order.awbNumber ?? null,
      trackingUrl: order.trackingUrl ?? null,
      shippedAt: order.shippedAt ? new Date(order.shippedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
    },
    cancellation:
      order.status === ORDER_STATUSES.CANCELLED
        ? {
            cancelledAt: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
            cancelledBy: order.cancelledBy ?? null,
            reason: order.cancellationReason ?? null,
          }
        : null,
    stockRestored: Boolean(order.stockRestored),
    items,
    allowedNextStatuses: getAllowedNextStatuses(order),
    canCancel: CANCELLABLE_ADMIN_STATUSES.includes(order.status),
    canRefund: canOrderRefund(order),
    canEditTracking: TRACKING_EDITABLE_STATUSES.includes(order.status),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

function buildDateRangeFilter(dateFrom, dateTo) {
  let fromDate = null;
  let toDate = null;

  if (dateFrom) {
    fromDate = new Date(dateFrom);
    if (Number.isNaN(fromDate.getTime())) {
      throw new AppError(400, 'VALIDATION_ERROR', 'dateFrom must be a valid ISO 8601 date.', [
        { field: 'dateFrom', message: 'Invalid start date.' },
      ]);
    }
  }

  if (dateTo) {
    toDate = new Date(dateTo);
    if (Number.isNaN(toDate.getTime())) {
      throw new AppError(400, 'VALIDATION_ERROR', 'dateTo must be a valid ISO 8601 date.', [
        { field: 'dateTo', message: 'Invalid end date.' },
      ]);
    }
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new AppError(400, 'VALIDATION_ERROR', 'dateFrom cannot be later than dateTo.', [
      { field: 'dateFrom', message: 'Start date must be before or equal to end date.' },
    ]);
  }

  if (!fromDate && !toDate) return undefined;
  const range = {};
  if (fromDate) range[Op.gte] = fromDate;
  if (toDate) range[Op.lte] = toDate;
  return range;
}

async function restoreOrderInventoryAndCoupon(order, transaction) {
  if (order.stockRestored) {
    return false;
  }

  const orderItems = await OrderItem.findAll({
    where: { orderId: order.id },
    transaction,
  });

  for (const item of orderItems) {
    if (item.variantId) {
      await ProductVariant.increment('stockQuantity', {
        by: Number(item.quantity),
        where: { id: item.variantId },
        paranoid: false,
        transaction,
      });
    }
  }

  if (order.couponId) {
    await sequelize.query(
      'UPDATE coupons SET redemption_count = CASE WHEN redemption_count > 0 THEN redemption_count - 1 ELSE 0 END WHERE id = ?',
      {
        replacements: [order.couponId],
        transaction,
      }
    );
  }

  return true;
}

async function findFullOrderById(orderId, transaction) {
  return Order.findByPk(orderId, {
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'fullName', 'phone', 'status'],
        required: false,
        paranoid: false,
      },
      {
        model: OrderItem,
        as: 'items',
        required: false,
      },
    ],
    order: [[{ model: OrderItem, as: 'items' }, 'created_at', 'ASC']],
    transaction,
  });
}

async function loadLockedOrder(idOrNumber, transaction) {
  const where = resolveOrderLookup(idOrNumber);
  const order = await Order.findOne({
    where,
    lock: transaction.LOCK.UPDATE,
    transaction,
  });

  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  return order;
}

// --- Read Operations ---

export async function getOrderSummaryStats({ country, dateFrom, dateTo } = {}) {
  const where = {};

  if (country) {
    where.country = normalizeSupportedCountry(country);
  }

  const createdRange = buildDateRangeFilter(dateFrom, dateTo);
  if (createdRange) {
    where.created_at = createdRange;
  }

  const [statusRows, paymentRows, revenueRows] = await Promise.all([
    Order.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    }),
    Order.findAll({
      where,
      attributes: ['paymentStatus', [fn('COUNT', col('id')), 'count']],
      group: ['payment_status'],
      raw: true,
    }),
    Order.findAll({
      where: {
        ...where,
        paymentStatus: PAYMENT_STATUSES.PAID,
        status: { [Op.ne]: ORDER_STATUSES.CANCELLED },
      },
      attributes: ['currency', [fn('SUM', col('grand_total_amount')), 'totalRevenue']],
      group: ['currency'],
      raw: true,
    }),
  ]);

  const byStatus = {};
  for (const statusKey of ALL_ORDER_STATUSES) {
    byStatus[statusKey] = 0;
  }

  let totalOrders = 0;
  for (const row of statusRows) {
    const count = Number(row.count || 0);
    if (Object.prototype.hasOwnProperty.call(byStatus, row.status)) {
      byStatus[row.status] = count;
    }
    totalOrders += count;
  }

  const byPaymentStatus = {};
  for (const paymentKey of ALL_PAYMENT_STATUSES) {
    byPaymentStatus[paymentKey] = 0;
  }
  for (const row of paymentRows) {
    const key = row.paymentStatus ?? row.payment_status;
    const count = Number(row.count || 0);
    if (Object.prototype.hasOwnProperty.call(byPaymentStatus, key)) {
      byPaymentStatus[key] = count;
    }
  }

  const paidRevenue = {
    INR: '0.00',
    USD: '0.00',
  };
  for (const row of revenueRows) {
    const curr = String(row.currency || '').toUpperCase();
    if (curr === 'INR' || curr === 'USD') {
      paidRevenue[curr] = formatMinorUnits(decimalToMinorUnits(row.totalRevenue));
    }
  }

  return {
    totalOrders,
    byStatus,
    byPaymentStatus,
    actionRequired: {
      awaitingFulfillment:
        byStatus[ORDER_STATUSES.CONFIRMED] +
        byStatus[ORDER_STATUSES.PROCESSING] +
        byStatus[ORDER_STATUSES.PACKED],
      pendingRefunds: byPaymentStatus[PAYMENT_STATUSES.REFUND_PENDING],
      pendingPayments: byStatus[ORDER_STATUSES.PENDING_PAYMENT],
    },
    paidRevenue,
  };
}

export async function listOrders({
  page = 1,
  limit = 20,
  search = '',
  status,
  paymentStatus,
  paymentMethod,
  country,
  userId,
  dateFrom,
  dateTo,
  sortBy = 'createdAt',
  sortOrder = 'desc',
} = {}) {
  const where = {};

  if (status) where.status = status;
  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (paymentMethod) where.paymentMethod = paymentMethod;
  if (country) where.country = normalizeSupportedCountry(country);
  if (userId) where.userId = userId;

  const createdRange = buildDateRangeFilter(dateFrom, dateTo);
  if (createdRange) {
    where.created_at = createdRange;
  }

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    const likePattern = `%${escapeLikeTerm(trimmedSearch)}%`;
    where[Op.or] = [
      { orderNumber: { [Op.like]: likePattern } },
      { razorpayOrderId: { [Op.like]: likePattern } },
      { razorpayPaymentId: { [Op.like]: likePattern } },
      { awbNumber: { [Op.like]: likePattern } },
      { couponCode: { [Op.like]: likePattern } },
      { '$user.email$': { [Op.like]: likePattern } },
      { '$user.full_name$': { [Op.like]: likePattern } },
      { '$user.phone$': { [Op.like]: likePattern } },
    ];
  }

  const sortCol = ORDER_SORT_FIELDS[sortBy] || ORDER_SORT_FIELDS.createdAt;
  const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;

  const { count: totalItems, rows } = await Order.findAndCountAll({
    where,
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'fullName', 'phone', 'status'],
        required: false,
        paranoid: false,
      },
    ],
    subQuery: false,
    distinct: true,
    order: [
      [sortCol, sortDir],
      ['id', 'ASC'],
    ],
    limit,
    offset,
  });

  const orderIds = rows.map((row) => row.id);
  const allItems = orderIds.length
    ? await OrderItem.findAll({
        where: { orderId: { [Op.in]: orderIds } },
        order: [
          ['created_at', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    : [];

  const itemsByOrderId = new Map();
  for (const item of allItems) {
    if (!itemsByOrderId.has(item.orderId)) {
      itemsByOrderId.set(item.orderId, []);
    }
    itemsByOrderId.get(item.orderId).push(item);
  }

  return {
    items: rows.map((order) =>
      serializeAdminOrderSummary(order, itemsByOrderId.get(order.id) || [])
    ),
    pagination: {
      page,
      limit,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
    },
  };
}

export async function getOrderByIdOrNumber(idOrNumber) {
  const where = resolveOrderLookup(idOrNumber);

  const order = await Order.findOne({
    where,
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'fullName', 'phone', 'status'],
        required: false,
        paranoid: false,
      },
      {
        model: OrderItem,
        as: 'items',
        required: false,
      },
    ],
    order: [[{ model: OrderItem, as: 'items' }, 'created_at', 'ASC']],
  });

  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  return serializeAdminOrderDetail(order);
}

// --- Fulfillment & Tracking Mutations ---

export async function updateOrderStatus(
  idOrNumber,
  { status, courierName, awbNumber, trackingUrl, markCodPaid = false } = {},
  admin = null
) {
  if (status === ORDER_STATUSES.CANCELLED) {
    throw new AppError(
      400,
      'USE_CANCEL_ENDPOINT',
      'Use POST /api/v1/orders/:id/cancel to cancel an order with a reason and stock control.'
    );
  }

  const normalizedTrackingUrl = validateTrackingUrl(trackingUrl);

  return sequelize.transaction(async (transaction) => {
    const order = await loadLockedOrder(idOrNumber, transaction);
    const previousStatus = order.status;

    if (order.status === status) {
      throw new AppError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Order is already in "${status}" status.`
      );
    }

    if (
      order.paymentMethod === PAYMENT_METHODS.RAZORPAY &&
      order.paymentStatus !== PAYMENT_STATUSES.PAID
    ) {
      throw new AppError(
        409,
        'ORDER_NOT_PAID',
        'Online Razorpay orders must have paymentStatus "paid" before fulfillment updates.'
      );
    }

    const allowedNext = ALLOWED_FULFILLMENT_TRANSITIONS[order.status] || [];
    if (!allowedNext.includes(status)) {
      throw new AppError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Cannot transition order from "${order.status}" to "${status}".`
      );
    }

    const updates = { status };

    if (courierName !== undefined) updates.courierName = courierName;
    if (awbNumber !== undefined) updates.awbNumber = awbNumber;
    if (normalizedTrackingUrl !== undefined) updates.trackingUrl = normalizedTrackingUrl;

    if (status === ORDER_STATUSES.SHIPPED) {
      const effectiveCourier =
        courierName !== undefined ? courierName : order.courierName;
      const effectiveAwb = awbNumber !== undefined ? awbNumber : order.awbNumber;

      const missingDetails = [];
      if (!effectiveCourier || !String(effectiveCourier).trim()) {
        missingDetails.push({ field: 'courierName', message: 'Courier name is required to ship an order.' });
      }
      if (!effectiveAwb || !String(effectiveAwb).trim()) {
        missingDetails.push({ field: 'awbNumber', message: 'AWB tracking number is required to ship an order.' });
      }

      if (missingDetails.length > 0) {
        throw new AppError(
          400,
          'TRACKING_REQUIRED_FOR_SHIPMENT',
          'Both courierName and awbNumber are required when marking an order as shipped.',
          missingDetails
        );
      }

      updates.shippedAt = order.shippedAt || new Date();
    }

    if (status === ORDER_STATUSES.DELIVERED) {
      updates.deliveredAt = order.deliveredAt || new Date();
      if (
        markCodPaid &&
        order.paymentMethod === PAYMENT_METHODS.COD &&
        order.paymentStatus === PAYMENT_STATUSES.PENDING
      ) {
        updates.paymentStatus = PAYMENT_STATUSES.PAID;
        updates.paidAt = order.paidAt || new Date();
      }
    }

    await order.update(updates, { transaction });
    logOrderAudit('order.status_updated', admin, order.id, order.orderNumber, {
      fromStatus: previousStatus,
      toStatus: status,
    });

    const fullOrder = await findFullOrderById(order.id, transaction);
    return serializeAdminOrderDetail(fullOrder);
  });
}

export async function updateOrderTracking(
  idOrNumber,
  { courierName, awbNumber, trackingUrl } = {},
  admin = null
) {
  if (courierName === undefined && awbNumber === undefined && trackingUrl === undefined) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'At least one tracking field (courierName, awbNumber, trackingUrl) is required.',
      [{ field: 'body', message: 'Provide at least one tracking field.' }]
    );
  }

  const normalizedTrackingUrl = validateTrackingUrl(trackingUrl);

  return sequelize.transaction(async (transaction) => {
    const order = await loadLockedOrder(idOrNumber, transaction);

    if (!TRACKING_EDITABLE_STATUSES.includes(order.status)) {
      throw new AppError(
        409,
        'TRACKING_NOT_EDITABLE',
        `Tracking details cannot be modified while order status is "${order.status}".`
      );
    }

    const nextCourier = courierName !== undefined ? courierName : order.courierName;
    const nextAwb = awbNumber !== undefined ? awbNumber : order.awbNumber;
    const nextUrl = normalizedTrackingUrl !== undefined ? normalizedTrackingUrl : order.trackingUrl;

    if (order.status === ORDER_STATUSES.SHIPPED && (!nextCourier || !nextAwb)) {
      throw new AppError(
        400,
        'TRACKING_REQUIRED_FOR_SHIPMENT',
        'Both courierName and awbNumber must remain non-empty once an order is shipped.',
        [
          ...(!nextCourier
            ? [{ field: 'courierName', message: 'Courier name cannot be cleared on a shipped order.' }]
            : []),
          ...(!nextAwb
            ? [{ field: 'awbNumber', message: 'AWB number cannot be cleared on a shipped order.' }]
            : []),
        ]
      );
    }

    await order.update(
      {
        courierName: nextCourier,
        awbNumber: nextAwb,
        trackingUrl: nextUrl,
      },
      { transaction }
    );

    logOrderAudit('order.tracking_updated', admin, order.id, order.orderNumber, {
      courierName: nextCourier,
      awbNumber: nextAwb,
    });

    const fullOrder = await findFullOrderById(order.id, transaction);
    return serializeAdminOrderDetail(fullOrder);
  });
}

// --- Payment Management & Razorpay Reconciliation ---

export async function updateOrderPaymentStatus(
  idOrNumber,
  { paymentStatus, razorpayPaymentId, refundAmount } = {},
  admin = null
) {
  if (paymentStatus === PAYMENT_STATUSES.REFUNDED) {
    throw new AppError(
      400,
      'USE_REFUND_ENDPOINT',
      'Use POST /api/v1/orders/:id/refund to execute or record a refund.'
    );
  }

  return sequelize.transaction(async (transaction) => {
    const order = await loadLockedOrder(idOrNumber, transaction);
    const previousPaymentStatus = order.paymentStatus;

    if (previousPaymentStatus === paymentStatus) {
      throw new AppError(
        409,
        'INVALID_PAYMENT_TRANSITION',
        `Order paymentStatus is already "${paymentStatus}".`
      );
    }

    if (previousPaymentStatus === PAYMENT_STATUSES.REFUNDED) {
      throw new AppError(
        409,
        'INVALID_PAYMENT_TRANSITION',
        'Refunded payments are final and cannot be changed.'
      );
    }

    const updates = { paymentStatus };

    if (paymentStatus === PAYMENT_STATUSES.PAID) {
      if (
        previousPaymentStatus !== PAYMENT_STATUSES.PENDING &&
        previousPaymentStatus !== PAYMENT_STATUSES.FAILED
      ) {
        throw new AppError(
          409,
          'INVALID_PAYMENT_TRANSITION',
          `Cannot transition paymentStatus from "${previousPaymentStatus}" to "paid".`
        );
      }

      if (order.status === ORDER_STATUSES.CANCELLED) {
        throw new AppError(
          409,
          'INVALID_PAYMENT_TRANSITION',
          'Cancelled orders cannot be marked "paid". Use "refund_pending" if payment was captured before cancellation refund.'
        );
      }

      const effectivePaymentId =
        razorpayPaymentId !== undefined ? razorpayPaymentId : order.razorpayPaymentId;

      if (
        order.paymentMethod === PAYMENT_METHODS.RAZORPAY &&
        (!effectivePaymentId || !RAZORPAY_PAYMENT_ID_REGEX.test(effectivePaymentId))
      ) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'A valid razorpayPaymentId (pay_...) is required when marking a Razorpay order as paid.',
          [{ field: 'razorpayPaymentId', message: 'Valid Razorpay payment ID (pay_...) is required.' }]
        );
      }

      if (effectivePaymentId) {
        updates.razorpayPaymentId = effectivePaymentId;
      }
      updates.paidAt = order.paidAt || new Date();
      if (order.status === ORDER_STATUSES.PENDING_PAYMENT) {
        updates.status = ORDER_STATUSES.CONFIRMED;
      }
    } else if (paymentStatus === PAYMENT_STATUSES.FAILED) {
      if (
        previousPaymentStatus !== PAYMENT_STATUSES.PENDING ||
        ![ORDER_STATUSES.PENDING_PAYMENT, ORDER_STATUSES.CANCELLED].includes(order.status)
      ) {
        throw new AppError(
          409,
          'INVALID_PAYMENT_TRANSITION',
          `Cannot mark payment as "failed" from "${previousPaymentStatus}" while order is "${order.status}".`
        );
      }
    } else if (paymentStatus === PAYMENT_STATUSES.PENDING) {
      if (
        previousPaymentStatus !== PAYMENT_STATUSES.FAILED ||
        order.status !== ORDER_STATUSES.PENDING_PAYMENT
      ) {
        throw new AppError(
          409,
          'INVALID_PAYMENT_TRANSITION',
          `Cannot reset paymentStatus to "pending" from "${previousPaymentStatus}" while order is "${order.status}".`
        );
      }
    } else if (paymentStatus === PAYMENT_STATUSES.REFUND_PENDING) {
      const grandTotalMinor = decimalToMinorUnits(order.grandTotalAmount);
      let nextRefundMinor = grandTotalMinor;

      if (refundAmount !== undefined && refundAmount !== null) {
        nextRefundMinor = parseDecimalToMinorUnits(refundAmount, 'refundAmount', {
          minMinor: 1,
          maxMinor: grandTotalMinor,
        });
      } else if (order.refundAmount !== null && order.refundAmount !== undefined) {
        nextRefundMinor = decimalToMinorUnits(order.refundAmount);
      }

      if (previousPaymentStatus === PAYMENT_STATUSES.PAID) {
        updates.refundAmount = formatMinorUnits(nextRefundMinor);
      } else if (
        (previousPaymentStatus === PAYMENT_STATUSES.PENDING ||
          previousPaymentStatus === PAYMENT_STATUSES.FAILED) &&
        order.status === ORDER_STATUSES.CANCELLED
      ) {
        const effectivePaymentId =
          razorpayPaymentId !== undefined ? razorpayPaymentId : order.razorpayPaymentId;
        if (
          order.paymentMethod === PAYMENT_METHODS.RAZORPAY &&
          (!effectivePaymentId || !RAZORPAY_PAYMENT_ID_REGEX.test(effectivePaymentId))
        ) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'A valid razorpayPaymentId (pay_...) is required to flag a cancelled Razorpay order as refund_pending.',
            [{ field: 'razorpayPaymentId', message: 'Valid Razorpay payment ID (pay_...) is required.' }]
          );
        }
        if (effectivePaymentId) {
          updates.razorpayPaymentId = effectivePaymentId;
        }
        updates.paidAt = order.paidAt || new Date();
        updates.refundAmount = formatMinorUnits(nextRefundMinor);
      } else {
        throw new AppError(
          409,
          'INVALID_PAYMENT_TRANSITION',
          `Cannot mark payment as "refund_pending" from "${previousPaymentStatus}" while order is "${order.status}".`
        );
      }
    } else {
      throw new AppError(
        409,
        'INVALID_PAYMENT_TRANSITION',
        `Unsupported paymentStatus transition to "${paymentStatus}".`
      );
    }

    await order.update(updates, { transaction });
    logOrderAudit('order.payment_status_updated', admin, order.id, order.orderNumber, {
      fromPaymentStatus: previousPaymentStatus,
      toPaymentStatus: paymentStatus,
    });

    const fullOrder = await findFullOrderById(order.id, transaction);
    return serializeAdminOrderDetail(fullOrder);
  });
}

export async function syncOrderPaymentWithRazorpay(idOrNumber, admin = null) {
  const where = resolveOrderLookup(idOrNumber);
  const existing = await Order.findOne({ where });

  if (!existing) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (existing.paymentMethod !== PAYMENT_METHODS.RAZORPAY) {
    throw new AppError(
      400,
      'PAYMENT_METHOD_NOT_GATEWAY',
      'Payment gateway sync is only supported for Razorpay orders.'
    );
  }

  if (!existing.razorpayOrderId) {
    throw new AppError(
      400,
      'MISSING_RAZORPAY_ORDER_ID',
      'This order does not have a Razorpay order ID to reconcile.'
    );
  }

  if (
    existing.paymentStatus === PAYMENT_STATUSES.PAID ||
    existing.paymentStatus === PAYMENT_STATUSES.REFUNDED
  ) {
    const fullOrder = await findFullOrderById(existing.id);
    return {
      order: serializeAdminOrderDetail(fullOrder),
      synced: false,
      gatewayPaymentsCount: 0,
    };
  }

  const payments = await razorpayService.fetchOrderPayments(existing.razorpayOrderId);
  const expectedMinor = decimalToMinorUnits(existing.grandTotalAmount);

  const capturedPayment = payments.find(
    (p) =>
      p &&
      p.status === 'captured' &&
      Number(p.amount) === expectedMinor &&
      String(p.currency || '').toUpperCase() === existing.currency
  );

  const hasFailedAttempt =
    !capturedPayment &&
    !payments.some((p) => p && (p.status === 'authorized' || p.status === 'created')) &&
    payments.some((p) => p && p.status === 'failed');

  return sequelize.transaction(async (transaction) => {
    const locked = await Order.findByPk(existing.id, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    let synced = false;

    if (
      locked.paymentStatus !== PAYMENT_STATUSES.PAID &&
      locked.paymentStatus !== PAYMENT_STATUSES.REFUNDED
    ) {
      if (capturedPayment) {
        const now = new Date();
        if (locked.status === ORDER_STATUSES.CANCELLED) {
          await locked.update(
            {
              paymentStatus: PAYMENT_STATUSES.REFUND_PENDING,
              razorpayPaymentId: capturedPayment.id,
              paidAt: locked.paidAt || now,
              refundAmount: locked.refundAmount || locked.grandTotalAmount,
            },
            { transaction }
          );
        } else {
          await locked.update(
            {
              status:
                locked.status === ORDER_STATUSES.PENDING_PAYMENT
                  ? ORDER_STATUSES.CONFIRMED
                  : locked.status,
              paymentStatus: PAYMENT_STATUSES.PAID,
              razorpayPaymentId: capturedPayment.id,
              paidAt: locked.paidAt || now,
            },
            { transaction }
          );
        }
        synced = true;
      } else if (hasFailedAttempt && locked.paymentStatus === PAYMENT_STATUSES.PENDING) {
        await locked.update({ paymentStatus: PAYMENT_STATUSES.FAILED }, { transaction });
        synced = true;
      }
    }

    if (synced) {
      logOrderAudit('order.payment_synced', admin, locked.id, locked.orderNumber, {
        razorpayPaymentId: locked.razorpayPaymentId,
        paymentStatus: locked.paymentStatus,
      });
    }

    const fullOrder = await findFullOrderById(locked.id, transaction);
    return {
      order: serializeAdminOrderDetail(fullOrder),
      synced,
      gatewayPaymentsCount: payments.length,
    };
  });
}

// --- Admin Cancellation & Refund Processing ---

export async function cancelOrder(
  idOrNumber,
  { reason, restoreStock = true } = {},
  admin = null
) {
  return sequelize.transaction(async (transaction) => {
    const order = await loadLockedOrder(idOrNumber, transaction);

    if (order.status === ORDER_STATUSES.CANCELLED) {
      throw new AppError(409, 'ORDER_ALREADY_CANCELLED', 'This order has already been cancelled.');
    }

    if (!CANCELLABLE_ADMIN_STATUSES.includes(order.status)) {
      throw new AppError(
        409,
        'ORDER_CANNOT_BE_CANCELLED',
        `Order cannot be cancelled once it is "${order.status}". Use post-delivery refund instead if applicable.`
      );
    }

    let didRestore = false;
    if (restoreStock && !order.stockRestored) {
      didRestore = await restoreOrderInventoryAndCoupon(order, transaction);
    }

    const wasPaid = order.paymentStatus === PAYMENT_STATUSES.PAID;
    const nextPaymentStatus = wasPaid
      ? PAYMENT_STATUSES.REFUND_PENDING
      : order.paymentStatus;
    const nextRefundAmount = wasPaid
      ? order.refundAmount || order.grandTotalAmount
      : order.refundAmount;

    await order.update(
      {
        status: ORDER_STATUSES.CANCELLED,
        paymentStatus: nextPaymentStatus,
        cancelledAt: new Date(),
        cancelledBy: CANCELLED_BY_ACTORS.ADMIN,
        cancellationReason: String(reason).trim(),
        stockRestored: Boolean(order.stockRestored || didRestore),
        refundAmount: nextRefundAmount,
      },
      { transaction }
    );

    logOrderAudit('order.cancelled', admin, order.id, order.orderNumber, {
      restoreStock: Boolean(restoreStock),
      didRestore,
      paymentStatus: nextPaymentStatus,
    });

    const fullOrder = await findFullOrderById(order.id, transaction);
    return serializeAdminOrderDetail(fullOrder);
  });
}

export async function refundOrder(
  idOrNumber,
  { mode, amount, speed = 'normal', razorpayRefundId, notes, restoreStock = false } = {},
  admin = null
) {
  const where = resolveOrderLookup(idOrNumber);
  const existing = await Order.findOne({ where });

  if (!existing) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  if (inFlightRefundOrderIds.has(existing.id)) {
    throw new AppError(
      409,
      'REFUND_IN_PROGRESS',
      'A refund is already in progress for this order.'
    );
  }

  inFlightRefundOrderIds.add(existing.id);

  try {
    if (existing.paymentStatus === PAYMENT_STATUSES.REFUNDED || Boolean(existing.razorpayRefundId)) {
      throw new AppError(
        409,
        'ORDER_ALREADY_REFUNDED',
        'A refund has already been recorded for this order.'
      );
    }

    if (
      ![PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.REFUND_PENDING].includes(existing.paymentStatus)
    ) {
      throw new AppError(
        409,
        'ORDER_NOT_REFUNDABLE',
        `Order paymentStatus "${existing.paymentStatus}" is not eligible for refund.`
      );
    }

    if (!REFUNDABLE_ORDER_STATUSES.includes(existing.status)) {
      throw new AppError(
        409,
        'ORDER_MUST_BE_CANCELLED_FIRST',
        `Pre-shipment order in "${existing.status}" status must be cancelled before issuing a refund.`
      );
    }

    const effectiveMode =
      mode || (existing.paymentMethod === PAYMENT_METHODS.RAZORPAY ? 'razorpay' : 'manual');

    if (effectiveMode === 'razorpay' && razorpayRefundId !== undefined && razorpayRefundId !== null) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'razorpayRefundId can only be supplied manually when mode is "manual".',
        [{ field: 'razorpayRefundId', message: 'Omit razorpayRefundId for live Razorpay refunds.' }]
      );
    }

    if (
      effectiveMode === 'manual' &&
      razorpayRefundId !== undefined &&
      razorpayRefundId !== null &&
      !RAZORPAY_REFUND_ID_REGEX.test(String(razorpayRefundId).trim())
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'razorpayRefundId must match Razorpay refund ID format (rfnd_...).',
        [{ field: 'razorpayRefundId', message: 'Invalid Razorpay refund ID format.' }]
      );
    }

    const grandTotalMinor = decimalToMinorUnits(existing.grandTotalAmount);
    let refundMinor;
    if (amount !== undefined && amount !== null && amount !== '') {
      refundMinor = parseDecimalToMinorUnits(amount, 'amount', {
        minMinor: 1,
        maxMinor: grandTotalMinor,
      });
    } else if (existing.refundAmount !== null && existing.refundAmount !== undefined) {
      refundMinor = parseDecimalToMinorUnits(String(existing.refundAmount), 'refundAmount', {
        minMinor: 1,
        maxMinor: grandTotalMinor,
      });
    } else {
      refundMinor = grandTotalMinor;
    }

    let finalRefundId =
      razorpayRefundId !== undefined && razorpayRefundId !== null
        ? String(razorpayRefundId).trim()
        : null;
    let gatewayStatus = effectiveMode === 'manual' ? 'manual_recorded' : null;

    if (effectiveMode === 'razorpay') {
      if (existing.paymentMethod !== PAYMENT_METHODS.RAZORPAY) {
        throw new AppError(
          400,
          'PAYMENT_METHOD_NOT_GATEWAY',
          'Razorpay refunds are only supported for Razorpay orders; use mode "manual" instead.'
        );
      }

      if (!existing.razorpayPaymentId || !RAZORPAY_PAYMENT_ID_REGEX.test(existing.razorpayPaymentId)) {
        throw new AppError(
          400,
          'MISSING_RAZORPAY_PAYMENT_ID',
          'Order does not have a valid Razorpay payment ID (pay_...) required to process an automated refund.'
        );
      }

      const gatewayRefund = await razorpayService.createRefund({
        razorpayPaymentId: existing.razorpayPaymentId,
        amountMinor: refundMinor,
        speed,
        receipt: existing.orderNumber,
        notes: {
          orderId: existing.id,
          orderNumber: existing.orderNumber,
          adminId: admin?.id || '',
          ...(notes ? { note: String(notes).trim() } : {}),
        },
      });

      finalRefundId = gatewayRefund.razorpayRefundId;
      gatewayStatus = gatewayRefund.status;
    }

    const formattedRefundAmount = formatMinorUnits(refundMinor);

    return await sequelize.transaction(async (transaction) => {
      const lockedOrder = await Order.findByPk(existing.id, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (
        lockedOrder.paymentStatus === PAYMENT_STATUSES.REFUNDED ||
        Boolean(lockedOrder.razorpayRefundId)
      ) {
        throw new AppError(
          409,
          'ORDER_ALREADY_REFUNDED',
          'A refund has already been recorded for this order.'
        );
      }

      let didRestore = false;
      if (restoreStock === true && !lockedOrder.stockRestored) {
        didRestore = await restoreOrderInventoryAndCoupon(lockedOrder, transaction);
      }

      await lockedOrder.update(
        {
          paymentStatus: PAYMENT_STATUSES.REFUNDED,
          refundAmount: formattedRefundAmount,
          razorpayRefundId: finalRefundId,
          refundedAt: new Date(),
          stockRestored: Boolean(lockedOrder.stockRestored || didRestore),
        },
        { transaction }
      );

      logOrderAudit('order.refunded', admin, lockedOrder.id, lockedOrder.orderNumber, {
        mode: effectiveMode,
        amount: formattedRefundAmount,
        currency: lockedOrder.currency,
        razorpayRefundId: finalRefundId,
        restoreStock: Boolean(restoreStock),
        didRestore,
      });

      const fullOrder = await findFullOrderById(lockedOrder.id, transaction);
      return {
        order: serializeAdminOrderDetail(fullOrder),
        refund: {
          mode: effectiveMode,
          amount: formattedRefundAmount,
          currency: lockedOrder.currency,
          razorpayRefundId: finalRefundId,
          gatewayStatus,
        },
      };
    });
  } finally {
    inFlightRefundOrderIds.delete(existing.id);
  }
}
