import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

/**
 * Minimal auth payload: identity only. Never include the password hash.
 * `sub` is kept because the shared socket/middleware contract reads it;
 * `userId` is the documented alias for API consumers.
 */
export const signAuthToken = (user) => {
  const userId = String(user._id ?? user.id);

  return jwt.sign({ sub: userId, userId, role: user.role || 'USER' }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
};

export const verifyAuthToken = (token) => {
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw ApiError.unauthenticated('INVALID_TOKEN', 'Invalid or expired token');
  }

  const userId = payload.sub || payload.id || payload.userId;
  if (!userId) {
    throw ApiError.unauthenticated('INVALID_TOKEN', 'Token missing subject');
  }

  return { userId: String(userId), role: payload.role || 'USER' };
};
