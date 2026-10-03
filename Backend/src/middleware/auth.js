/**
 * SHARED AUTH CONTRACT — OWNED BY PERSON 3.
 *
 * Every route consumes the same middleware:
 *
 *   req.user = { id: string, userId: string, role: "USER" | "GUARDIAN" | "ADMIN" }
 *
 * Tokens are `Authorization: Bearer <JWT>` with a minimal payload
 * (`sub`/`userId` + `role`) signed with JWT_SECRET.
 *
 * This is AUTHENTICATION only — no role/authorization checks live here yet.
 */
import { verifyAuthToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
  }

  try {
    const { userId, role } = verifyAuthToken(token);
    req.user = { id: userId, userId, role };
    return next();
  } catch (err) {
    return next(err.statusCode ? err : new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
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
