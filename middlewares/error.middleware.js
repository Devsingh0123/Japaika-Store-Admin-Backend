import env from '../config/env.js';
import AppError from '../utils/appError.js';
import { sendError } from '../utils/response.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found.`));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return sendError(res, {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, {
      statusCode: 400,
      code: 'INVALID_JSON',
      message: 'Malformed JSON request body.',
      details: [],
    });
  }

  if (!env.isTest) {
    console.error('[AdminBackend Error]', err);
  }

  return sendError(res, {
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal server error occurred.',
    details: [],
  });
}
