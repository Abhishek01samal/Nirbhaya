import { User } from '../users/user.model.js';
import { sanitizeUser } from '../users/user.sanitize.js';
import { signAuthToken } from '../../utils/jwt.js';
import { ApiError } from '../../utils/ApiError.js';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isDuplicateEmailError = (err) => err?.code === 11000 && Boolean(err?.keyValue?.email);

/**
 * Register: normalize email -> reject duplicates -> create (the model
 * pre-save hook hashes the password) -> issue JWT.
 */
export const registerUser = async ({ name, email, password, role }) => {
  const normalizedEmail = normalizeEmail(email);

  const existing = await User.findOne({ email: normalizedEmail }).lean();
  if (existing) {
    throw ApiError.conflict('EMAIL_EXISTS', 'An account with this email already exists');
  }

  let user;
  try {
    user = await User.create({ name, email: normalizedEmail, password, ...(role ? { role } : {}) });
  } catch (err) {
    // Unique-index race: two registrations for the same email.
    if (isDuplicateEmailError(err)) {
      throw ApiError.conflict('EMAIL_EXISTS', 'An account with this email already exists');
    }
    throw err;
  }

  return { user: sanitizeUser(user), token: signAuthToken(user) };
};

/**
 * Login: one generic error for unknown email AND wrong password, so the
 * response never reveals which one failed.
 */
export const loginUser = async ({ email, password }) => {
  const normalizedEmail = normalizeEmail(email);

  const user = await User.findOne({ email: normalizedEmail }).select('+password');
  const invalid = ApiError.unauthenticated('INVALID_CREDENTIALS', 'Invalid email or password');

  if (!user) throw invalid;

  const matches = await user.comparePassword(password);
  if (!matches) throw invalid;

  return { user: sanitizeUser(user), token: signAuthToken(user) };
};

export const getCurrentUser = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) {
    throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  }
  return sanitizeUser(user);
};
