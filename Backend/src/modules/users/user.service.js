import { User } from './user.model.js';
import { sanitizeUser } from './user.sanitize.js';
import { ApiError } from '../../utils/ApiError.js';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isDuplicateEmailError = (err) => err?.code === 11000 && Boolean(err?.keyValue?.email);

const assertEmailAvailable = async (email, excludeUserId = null) => {
  const query = { email };
  if (excludeUserId) query._id = { $ne: excludeUserId };

  const existing = await User.findOne(query).lean();
  if (existing) {
    throw ApiError.conflict('EMAIL_EXISTS', 'An account with this email already exists');
  }
};

export const listUsers = async () => {
  const users = await User.find().sort({ createdAt: -1 }).lean();
  return users.map(sanitizeUser);
};

export const getUserById = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  return sanitizeUser(user);
};

export const createUser = async ({ name, email, password, role }) => {
  const normalizedEmail = normalizeEmail(email);
  await assertEmailAvailable(normalizedEmail);

  let user;
  try {
    user = await User.create({ name, email: normalizedEmail, password, ...(role ? { role } : {}) });
  } catch (err) {
    if (isDuplicateEmailError(err)) {
      throw ApiError.conflict('EMAIL_EXISTS', 'An account with this email already exists');
    }
    throw err;
  }

  return sanitizeUser(user);
};

export const updateUserById = async (userId, { name, email, password, role }) => {
  const user = await User.findById(userId).select('+password');
  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');

  if (email !== undefined) {
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail !== user.email) {
      await assertEmailAvailable(normalizedEmail, user._id);
    }
    user.email = normalizedEmail;
  }

  if (name !== undefined) user.name = name;
  if (role !== undefined) user.role = role;

  // Assigning a new password is hashed by the model's pre-save hook.
  if (password !== undefined) user.password = password;

  try {
    await user.save();
  } catch (err) {
    if (isDuplicateEmailError(err)) {
      throw ApiError.conflict('EMAIL_EXISTS', 'An account with this email already exists');
    }
    throw err;
  }

  return sanitizeUser(user);
};

export const deleteUserById = async (userId) => {
  const user = await User.findByIdAndDelete(userId);
  if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User not found');
  return { id: String(user._id), deleted: true };
};
