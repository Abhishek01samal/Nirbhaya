/**
 * Single sanitization point for every user payload that leaves the API.
 * `password` is never included regardless of the source document shape.
 */
export const sanitizeUser = (user) => {
  if (!user) return null;

  const raw = typeof user.toObject === 'function' ? user.toObject() : { ...user };

  return {
    id: String(raw._id ?? raw.id ?? ''),
    name: raw.name,
    email: raw.email,
    role: raw.role,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
};
