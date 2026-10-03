export const sendSuccess = (res, data = null, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

export const sendCreated = (res, data = null) => sendSuccess(res, data, 201);

export const sendError = (res, statusCode, code, message, details) =>
  res
    .status(statusCode)
    .json({ success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } });
