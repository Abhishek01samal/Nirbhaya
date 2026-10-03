export class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(code = 'BAD_REQUEST', message = 'Bad request', details) {
    return new ApiError(400, code, message, details);
  }

  static unauthenticated(code = 'UNAUTHENTICATED', message = 'Authentication required') {
    return new ApiError(401, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = 'You are not allowed to perform this action') {
    return new ApiError(403, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found') {
    return new ApiError(404, code, message);
  }

  static conflict(code = 'CONFLICT', message = 'Conflicting state', details) {
    return new ApiError(409, code, message, details);
  }

  static internal(code = 'INTERNAL_ERROR', message = 'Unexpected server error') {
    return new ApiError(500, code, message);
  }
}
