import * as couponService from '../services/coupon.service.js';
import { sendSuccess } from '../utils/http.js';

export async function listCoupons(req, res) {
  const result = await couponService.listCoupons(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Coupons retrieved successfully.',
    data: result,
  });
}

export async function getCouponById(req, res) {
  const coupon = await couponService.getCouponById(req.params.id);

  return sendSuccess(res, {
    message: 'Coupon retrieved successfully.',
    data: { coupon },
  });
}

export async function createCoupon(req, res) {
  const coupon = await couponService.createCoupon(req.body);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Coupon created successfully.',
    data: { coupon },
  });
}

export async function updateCoupon(req, res) {
  const coupon = await couponService.updateCoupon(req.params.id, req.body);

  return sendSuccess(res, {
    message: 'Coupon updated successfully.',
    data: { coupon },
  });
}

export async function updateCouponStatus(req, res) {
  const coupon = await couponService.updateCouponStatus(req.params.id, req.body);

  return sendSuccess(res, {
    message: 'Coupon status updated successfully.',
    data: { coupon },
  });
}

export async function deleteCoupon(req, res) {
  const result = await couponService.deleteCoupon(req.params.id);

  return sendSuccess(res, {
    message: 'Coupon deleted successfully.',
    data: result,
  });
}
