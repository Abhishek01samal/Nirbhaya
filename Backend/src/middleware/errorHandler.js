import { ApiError } from '../utils/ApiError.js';
import { sendError } from '../utils/response.js';

export const notFoundHandler = (req, res, next) => {
  next(new ApiError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
};

const normalizeMongooseError = (err) => {
  if (err.name === 'CastError') {
    return new ApiError(400, 'INVALID_ID', `Invalid value for "${err.path}"`);
  }

  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors || {}).map((e) => ({
      path: e.path,
      message: e.message,
    }));
    return new ApiError(400, 'VALIDATION_ERROR', 'Document validation failed', details);
  }

  if (err.code === 11000) {
    const fields = Object.keys(err.keyValue || {});
    return new ApiError(409, 'DUPLICATE_KEY', `Duplicate value for: ${fields.join(', ') || 'field'}`);
  }

  return null;
};

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const normalized = normalizeMongooseError(err) || err;
  const statusCode = normalized.statusCode || 500;
  const code = normalized.code || 'INTERNAL_ERROR';
  const message = normalized.message || 'Unexpected server error';

  if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  }

  return sendError(res, statusCode, code, message, normalized.details);
};
