import * as categoryService from '../services/category.service.js';
import { sendSuccess } from '../utils/http.js';

export async function listCategories(req, res) {
  const result = await categoryService.listCategories(req.validatedQuery || req.query);

  return sendSuccess(res, {
    message: 'Categories retrieved successfully.',
    data: result,
  });
}

export async function getCategoryById(req, res) {
  const category = await categoryService.getCategoryById(req.params.id);

  return sendSuccess(res, {
    message: 'Category retrieved successfully.',
    data: { category },
  });
}

export async function createCategory(req, res) {
  const category = await categoryService.createCategory(req.body, req.file || null);

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Category created successfully.',
    data: { category },
  });
}

export async function updateCategory(req, res) {
  const category = await categoryService.updateCategory(
    req.params.id,
    req.body,
    req.file || null
  );

  return sendSuccess(res, {
    message: 'Category updated successfully.',
    data: { category },
  });
}

export async function deleteCategory(req, res) {
  const result = await categoryService.deleteCategory(req.params.id);

  return sendSuccess(res, {
    message: 'Category deleted successfully.',
    data: result,
  });
}
