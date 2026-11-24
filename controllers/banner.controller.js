import * as bannerService from '../services/banner.service.js';
import { sendSuccess } from '../utils/http.js';

export async function listBanners(req, res) {
  const result = await bannerService.listBanners(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Banners retrieved successfully.',
    data: result,
  });
}

export async function getBannerById(req, res) {
  const banner = await bannerService.getBannerById(req.params.id);

  return sendSuccess(res, {
    message: 'Banner retrieved successfully.',
    data: { banner },
  });
}

export async function createBanner(req, res) {
  const files = {
    image: req.files?.image?.[0] || null,
    mobileImage: req.files?.mobileImage?.[0] || null,
  };

  const banner = await bannerService.createBanner(req.body, files);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Banner created successfully.',
    data: { banner },
  });
}

export async function updateBanner(req, res) {
  const files = {
    image: req.files?.image?.[0] || null,
    mobileImage: req.files?.mobileImage?.[0] || null,
  };

  const banner = await bannerService.updateBanner(req.params.id, req.body, files);

  return sendSuccess(res, {
    message: 'Banner updated successfully.',
    data: { banner },
  });
}

export async function updateBannerStatus(req, res) {
  const banner = await bannerService.updateBannerStatus(req.params.id, req.body);

  return sendSuccess(res, {
    message: 'Banner status updated successfully.',
    data: { banner },
  });
}

export async function reorderBanners(req, res) {
  const result = await bannerService.reorderBanners(req.body.items);

  return sendSuccess(res, {
    message: 'Banners reordered successfully.',
    data: result,
  });
}

export async function deleteBanner(req, res) {
  const result = await bannerService.deleteBanner(req.params.id);

  return sendSuccess(res, {
    message: 'Banner deleted successfully.',
    data: result,
  });
}
