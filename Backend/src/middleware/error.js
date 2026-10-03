import { ZodError } from "zod";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { isProduction } from "../config/env.js";

export class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

export const badRequest = (message, details) =>
  new AppError(message, 400, "BAD_REQUEST", details);
export const unauthorized = (message = "Authentication required") =>
  new AppError(message, 401, "UNAUTHORIZED");
export const forbidden = (message = "Not allowed") => new AppError(message, 403, "FORBIDDEN");
export const notFound = (message = "Resource not found") => new AppError(message, 404, "NOT_FOUND");
export const conflict = (message, details) => new AppError(message, 409, "CONFLICT", details);
export const serviceUnavailable = (message, details) =>
  new AppError(message, 503, "SERVICE_UNAVAILABLE", details);

/** Wrap async route handlers so rejections reach the error middleware (Express 4 & 5). */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.originalUrl} not found` },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let code = err.code || "INTERNAL_ERROR";
  let message = err.message || "Something went wrong";
  let details = err.details;

  if (err instanceof ZodError) {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = "Request validation failed";
    details = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = "Document validation failed";
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    code = "BAD_REQUEST";
    message = `Invalid value for "${err.path}"`;
  } else if (err.name === "MulterError") {
    statusCode = 400;
    code = "UPLOAD_ERROR";
    message = err.message;
  } else if (err.type === "entity.too.large") {
    statusCode = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request body too large";
  }

  const logMeta = {
    method: req.method,
    url: req.originalUrl,
    status: statusCode,
    code,
  };

  if (statusCode >= 500) {
    logger.error("http", message, { ...logMeta, stack: isProduction ? undefined : err.stack });
  } else {
    logger.debug("http", message, logMeta);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(!isProduction && statusCode >= 500 && err.stack
        ? { stack: err.stack.split("\n").slice(0, 5) }
        : {}),
    },
  });
}

export default errorMiddleware;
