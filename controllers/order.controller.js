import * as orderService from '../services/order.service.js';
import { sendSuccess } from '../utils/http.js';

export async function getOrderSummary(req, res) {
  const summary = await orderService.getOrderSummaryStats(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Order summary retrieved successfully.',
    data: { summary },
  });
}

export async function listOrders(req, res) {
  const result = await orderService.listOrders(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Orders retrieved successfully.',
    data: result,
  });
}

export async function getOrderById(req, res) {
  const order = await orderService.getOrderByIdOrNumber(req.params.id);

  return sendSuccess(res, {
    message: 'Order retrieved successfully.',
    data: { order },
  });
}

export async function updateOrderStatus(req, res) {
  const order = await orderService.updateOrderStatus(req.params.id, req.body, req.admin);

  return sendSuccess(res, {
    message: 'Order status updated successfully.',
    data: { order },
  });
}

export async function updateOrderTracking(req, res) {
  const order = await orderService.updateOrderTracking(req.params.id, req.body, req.admin);

  return sendSuccess(res, {
    message: 'Order tracking details updated successfully.',
    data: { order },
  });
}

export async function updateOrderPaymentStatus(req, res) {
  const order = await orderService.updateOrderPaymentStatus(req.params.id, req.body, req.admin);

  return sendSuccess(res, {
    message: 'Order payment status updated successfully.',
    data: { order },
  });
}

export async function syncOrderPayment(req, res) {
  const result = await orderService.syncOrderPaymentWithRazorpay(req.params.id, req.admin);

  return sendSuccess(res, {
    message: result.synced
      ? 'Order payment reconciled with Razorpay successfully.'
      : 'Order payment checked against Razorpay with no changes required.',
    data: result,
  });
}

export async function cancelOrder(req, res) {
  const order = await orderService.cancelOrder(req.params.id, req.body, req.admin);

  return sendSuccess(res, {
    message: 'Order cancelled successfully.',
    data: { order },
  });
}

export async function refundOrder(req, res) {
  const result = await orderService.refundOrder(req.params.id, req.body, req.admin);

  return sendSuccess(res, {
    message: 'Order refund processed successfully.',
    data: result,
  });
}
