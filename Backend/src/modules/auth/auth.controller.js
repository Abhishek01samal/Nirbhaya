import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import { registerUser, loginUser, getCurrentUser } from './auth.service.js';

export const register = asyncHandler(async (req, res) => {
  const result = await registerUser(req.body);
  return sendCreated(res, result);
});

export const login = asyncHandler(async (req, res) => {
  const result = await loginUser(req.body);
  return sendSuccess(res, result);
});

export const me = asyncHandler(async (req, res) => {
  const user = await getCurrentUser(req.user.userId);
  return sendSuccess(res, { user });
});

/**
 * Stateless JWT: logout instructs the client to discard its token. The token
 * is not cryptographically revoked server-side (no blacklist/session store).
 */
export const logout = asyncHandler(async (req, res) => {
  return sendSuccess(res, { message: 'Logged out successfully' });
});
