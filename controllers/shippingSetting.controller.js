import * as shippingSettingService from '../services/shippingSetting.service.js';
import { sendSuccess } from '../utils/http.js';

export async function listShippingSettings(_req, res) {
  const result = await shippingSettingService.listShippingSettings();

  return sendSuccess(res, {
    message: 'Shipping settings retrieved successfully.',
    data: result,
  });
}

export async function getShippingSetting(req, res) {
  const shippingSetting = await shippingSettingService.getShippingSettingByCountry(
    req.params.country
  );

  return sendSuccess(res, {
    message: 'Shipping setting retrieved successfully.',
    data: { shippingSetting },
  });
}

export async function updateShippingSetting(req, res) {
  const shippingSetting = await shippingSettingService.updateShippingSetting(
    req.params.country,
    req.body,
    req.admin
  );

  return sendSuccess(res, {
    message: 'Shipping setting updated successfully.',
    data: { shippingSetting },
  });
}

export async function updateShippingSettingStatus(req, res) {
  const shippingSetting = await shippingSettingService.updateShippingSettingStatus(
    req.params.country,
    req.body,
    req.admin
  );

  return sendSuccess(res, {
    message: 'Shipping setting status updated successfully.',
    data: { shippingSetting },
  });
}
