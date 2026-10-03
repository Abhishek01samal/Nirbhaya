/**
 * TEMPORARY AUTH INTERFACE — OWNED BY PERSON 3.
 *
 * Person 3 owns /auth, the User model and the final authentication middleware.
 * This file only provides the minimal shared contract Person 1 depends on:
 *
 *   req.user = { id: string, role: "USER" | "ADMIN" }
 *
 * When Person 3 ships the real middleware, replace the body of `requireAuth`
 * (or re-export theirs) — every Person 1 endpoint keeps using `requireAuth`.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const id = payload.sub || payload.id;

    if (!id) {
      return next(new ApiError(401, 'INVALID_TOKEN', 'Token missing subject'));
    }

    req.user = { id: String(id), userId: String(id), role: payload.role || 'USER' };
    return next();
  } catch (err) {
    return next(new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }
};

export const requireOwner = (req, ownerId) => {
  const authedId = req.user?.userId ?? req.user?.id;
  if (!authedId) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  if (String(ownerId) !== String(authedId)) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only access your own resources');
  }
};
