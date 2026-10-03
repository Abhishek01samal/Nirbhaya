import { z } from 'zod';
import { ESCALATION_LEVEL_TYPE, SOS_TRIGGER_TYPES } from './sos.constants.js';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export const createSOSchema = z.object({
  triggerType: z.enum([...SOS_TRIGGER_TYPES]),

  safetySessionId: z
    .string()
    .regex(OBJECT_ID, 'safetySessionId must be a valid id')
    .optional(),

  triggerData: z
    .object({
      riskLevel: z.string().trim().max(20).optional(),
      confidence: z.number().min(0).max(1).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),

  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      address: z.string().trim().max(300).optional(),
    })
    .optional(),
});

export const getSOSByIdParamsSchema = z.object({
  id: z.string().regex(OBJECT_ID, 'id must be a valid id'),
});

/**
 * Responder acknowledgement path params: the SOS id plus the responder
 * identity from the URL. The responder id is only ever compared against the
 * authenticated caller and the persisted notified list — never trusted on its
 * own, and never used to look anything up in a database.
 */
export const acknowledgeResponderParamsSchema = z.object({
  id: z.string().regex(OBJECT_ID, 'id must be a valid id'),
  responderId: z.string().trim().min(1).max(64, 'responderId is malformed'),
});

/**
 * Escalation acknowledgement: only the two prototype levels are answerable —
 * POLICE (and anything else) is rejected here with 400 VALIDATION_ERROR.
 * targetId / userId / status / timestamps are backend-derived, never accepted.
 */
export const acknowledgeEscalationSchema = z.object({
  level: z.enum([ESCALATION_LEVEL_TYPE.GUARDIAN, ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER]),
});

export const getSOSHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
