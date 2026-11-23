import * as productService from '../services/product.service.js';
import { sendSuccess } from '../utils/http.js';

export async function listProducts(req, res) {
  const result = await productService.listProducts(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Products retrieved successfully.',
    data: result,
  });
}

export async function getProductById(req, res) {
  const product = await productService.getProductById(req.params.id);

  return sendSuccess(res, {
    message: 'Product retrieved successfully.',
    data: { product },
  });
}

export async function createProduct(req, res) {
  const files = {
    media: req.files?.media || [],
    certificate: req.files?.certificate?.[0] || null,
  };

  const product = await productService.createProduct(req.body, files);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Product created successfully.',
    data: { product },
  });
}

export async function updateProduct(req, res) {
  const product = await productService.updateProduct(req.params.id, req.body);

  return sendSuccess(res, {
    message: 'Product updated successfully.',
    data: { product },
  });
}

export async function updateProductStatus(req, res) {
  const product = await productService.updateProductStatus(req.params.id, req.body);

  return sendSuccess(res, {
    message: 'Product status updated successfully.',
    data: { product },
  });
}

export async function updateVariantStock(req, res) {
  const variant = await productService.updateVariantStock(
    req.params.id,
    req.params.variantId,
    req.body
  );

  return sendSuccess(res, {
    message: 'Product variant stock updated successfully.',
    data: { variant },
  });
}

export async function deleteProduct(req, res) {
  const result = await productService.deleteProduct(req.params.id);

  return sendSuccess(res, {
    message: 'Product deleted successfully.',
    data: result,
  });
}

export async function addProductMedia(req, res) {
  const media = await productService.addProductMedia(
    req.params.id,
    req.files || [],
    req.body || {}
  );

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Product media uploaded successfully.',
    data: { media },
  });
}

export async function updateProductMedia(req, res) {
  const mediaItem = await productService.updateProductMedia(
    req.params.id,
    req.params.mediaId,
    req.body
  );

  return sendSuccess(res, {
    message: 'Product media updated successfully.',
    data: { mediaItem },
  });
}

export async function deleteProductMedia(req, res) {
  const result = await productService.deleteProductMedia(
    req.params.id,
    req.params.mediaId
  );

  return sendSuccess(res, {
    message: 'Product media deleted successfully.',
    data: result,
  });
}

export async function upsertProductCertificate(req, res) {
  const certificate = await productService.upsertProductCertificate(
    req.params.id,
    req.file || null,
    req.body || {}
  );

  return sendSuccess(res, {
    message: 'Product certificate updated successfully.',
    data: { certificate },
  });
}

export async function deleteProductCertificate(req, res) {
  const result = await productService.deleteProductCertificate(req.params.id);

  return sendSuccess(res, {
    message: 'Product certificate deleted successfully.',
    data: result,
  });
}
