import { Router } from 'express';
import { z } from 'zod';
import {
  ADMIN_ROLES,
  ALL_ORDER_STATUSES,
  ALL_PAYMENT_METHODS,
  ALL_PAYMENT_STATUSES,
} from '../models/index.js';
import requireAdminAuth, { requireRoles } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { UUID_REGEX, resolveOrderLookup } from '../services/order.service.js';
import { AppError } from '../utils/http.js';
import * as orderController from '../controllers/order.controller.js';

const nullableTextField = (maxLen, label) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      const trimmed = val.trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine((val) => val === undefined || val === null || val.length <= maxLen, {
      message: `${label} must not exceed ${maxLen} characters.`,
    });

const booleanField = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  });

const orderSummaryQuerySchema = z.object({
  country: z.string().trim().max(10).optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
});

const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional().default(''),
  status: z.enum(ALL_ORDER_STATUSES).optional(),
  paymentStatus: z.enum(ALL_PAYMENT_STATUSES).optional(),
  paymentMethod: z.enum(ALL_PAYMENT_METHODS).optional(),
  country: z.string().trim().max(10).optional(),
  userId: z.string().trim().regex(UUID_REGEX, 'userId must be a valid UUID.').optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'grandTotalAmount', 'paidAt', 'shippedAt', 'status'])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ALL_ORDER_STATUSES),
  courierName: nullableTextField(100, 'courierName'),
  awbNumber: nullableTextField(100, 'awbNumber'),
  trackingUrl: z.union([z.string(), z.null()]).optional(),
  markCodPaid: booleanField,
});

export const updateOrderTrackingSchema = z.object({
  courierName: nullableTextField(100, 'courierName'),
  awbNumber: nullableTextField(100, 'awbNumber'),
  trackingUrl: z.union([z.string(), z.null()]).optional(),
});

export const updateOrderPaymentStatusSchema = z.object({
  paymentStatus: z.enum(ALL_PAYMENT_STATUSES),
  razorpayPaymentId: nullableTextField(64, 'razorpayPaymentId'),
  refundAmount: z.union([z.number(), z.string(), z.null()]).optional(),
});

export const cancelOrderSchema = z.object({
  reason: z
    .string({ error: 'Cancellation reason is required.' })
    .trim()
    .min(3, 'Cancellation reason must be at least 3 characters.')
    .max(255, 'Cancellation reason must not exceed 255 characters.'),
  restoreStock: booleanField.transform((val) => (val === undefined ? true : val)),
});

export const refundOrderSchema = z.object({
  mode: z.enum(['razorpay', 'manual']).optional(),
  amount: z.union([z.number(), z.string(), z.null()]).optional(),
  speed: z.enum(['normal', 'optimum']).default('normal'),
  razorpayRefundId: nullableTextField(64, 'razorpayRefundId'),
  notes: nullableTextField(255, 'notes'),
  restoreStock: booleanField.transform((val) => (val === undefined ? false : val)),
});

function validateQueryWith(schema) {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'query',
        message: issue.message,
      }));
      return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters.', details));
    }
    req.validatedQuery = parsed.data;
    return next();
  };
}

function validateOrderIdParam(req, _res, next) {
  try {
    resolveOrderLookup(req.params.id);
    return next();
  } catch (err) {
    return next(err);
  }
}

const requireOrderReadRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.OPERATIONS_MANAGER,
  ADMIN_ROLES.SUPPORT_MODERATOR
);

const requireOrderWriteRole = requireRoles(
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.OPERATIONS_MANAGER
);

const router = Router();

router.get(
  '/summary',
  requireAdminAuth,
  requireOrderReadRole,
  validateQueryWith(orderSummaryQuerySchema),
  orderController.getOrderSummary
);

router.get(
  '/',
  requireAdminAuth,
  requireOrderReadRole,
  validateQueryWith(listOrdersQuerySchema),
  orderController.listOrders
);

router.get(
  '/:id',
  requireAdminAuth,
  requireOrderReadRole,
  validateOrderIdParam,
  orderController.getOrderById
);

router.patch(
  '/:id/status',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  validateBody(updateOrderStatusSchema),
  orderController.updateOrderStatus
);

router.patch(
  '/:id/tracking',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  validateBody(updateOrderTrackingSchema),
  orderController.updateOrderTracking
);

router.patch(
  '/:id/payment-status',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  validateBody(updateOrderPaymentStatusSchema),
  orderController.updateOrderPaymentStatus
);

router.post(
  '/:id/sync-payment',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  orderController.syncOrderPayment
);

router.post(
  '/:id/cancel',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  validateBody(cancelOrderSchema),
  orderController.cancelOrder
);

router.post(
  '/:id/refund',
  requireAdminAuth,
  requireOrderWriteRole,
  validateOrderIdParam,
  validateBody(refundOrderSchema),
  orderController.refundOrder
);

export default router;
