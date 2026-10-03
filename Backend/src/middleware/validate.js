import { ApiError } from '../utils/ApiError.js';

const parse = (schema, data, location) => {
  const result = schema.safeParse(data);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: [location, ...issue.path].filter(Boolean).join('.'),
      message: issue.message,
    }));

    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }

  return result.data;
};

export const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = parse(schema, req.body ?? {}, 'body');
    return next();
  } catch (err) {
    return next(err);
  }
};

export const validateQuery = (schema) => (req, res, next) => {
  try {
    req.validatedQuery = parse(schema, req.query ?? {}, 'query');
    return next();
  } catch (err) {
    return next(err);
  }
};

export const validateParams = (schema) => (req, res, next) => {
  try {
    req.validatedParams = parse(schema, req.params ?? {}, 'params');
    return next();
  } catch (err) {
    return next(err);
  }
};
