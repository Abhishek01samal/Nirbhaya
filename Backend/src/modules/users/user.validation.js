import { z } from 'zod';
import { USER_ROLES } from './user.constants.js';
import { MIN_PASSWORD_LENGTH } from '../../utils/password.js';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const emailField = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .toLowerCase()
  .email('Invalid email format');

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  email: emailField,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(128, 'Password is too long'),
  role: z.enum(USER_ROLES).optional(),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long').optional(),
    email: emailField.optional(),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      .max(128, 'Password is too long')
      .optional(),
    role: z.enum(USER_ROLES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field to update is required',
  });

export const userIdParamsSchema = z.object({
  id: z.string().regex(OBJECT_ID, 'id must be a valid id'),
});
