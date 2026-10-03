import { z } from 'zod';
import { USER_ROLES } from '../users/user.constants.js';
import { MIN_PASSWORD_LENGTH } from '../../utils/password.js';

const normalizeEmail = (schema) =>
  schema.trim().min(1, 'Email is required').toLowerCase().email('Invalid email format');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  email: normalizeEmail(z.string()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(128, 'Password is too long'),
  role: z.enum(USER_ROLES).optional(),
});

export const loginSchema = z.object({
  email: normalizeEmail(z.string()),
  password: z.string().min(1, 'Password is required').max(128, 'Password is too long'),
});
