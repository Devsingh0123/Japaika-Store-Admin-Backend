import AppError from '../utils/appError.js';

function formatZodIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

export function validateBody(schema) {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Request validation failed.',
        formatZodIssues(parsed.error.issues),
      );
    }
    req.body = parsed.data;
    next();
  };
}

export default {
  validateBody,
};
