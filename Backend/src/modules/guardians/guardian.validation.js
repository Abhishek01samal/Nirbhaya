import { z } from 'zod';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export const createGuardianSchema = z.object({
  guardianUserId: z
    .string()
    .regex(OBJECT_ID, 'guardianUserId must be a valid id'),

  relationship: z.string().trim().min(1).max(50),

  priority: z.number().int().min(1),
});

export const getGuardianByIdParamsSchema = z.object({
  id: z.string().regex(OBJECT_ID, 'id must be a valid id'),
});

/**
 * PATCH: strict on purpose — protected fields (userId, guardianUserId, status,
 * createdAt, ...) are rejected rather than silently ignored, and at least one
 * editable field must be supplied.
 */
export const updateGuardianSchema = z
  .strictObject({
    relationship: z.string().trim().min(1).max(50).optional(),
    priority: z.number().int().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one of: relationship, priority',
  });
