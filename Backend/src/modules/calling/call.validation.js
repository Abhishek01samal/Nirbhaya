import { z } from 'zod';
import { CALL_END_REASONS } from './call.constants.js';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Strict on purpose: roomName, participantIdentity, guardianPhone and LiveKit
 * credentials are backend-determined and must be rejected if supplied.
 */
export const createCallTokenSchema = z.strictObject({
  callId: z.string().regex(OBJECT_ID, 'callId must be a valid id'),
});

/**
 * Strict on purpose: userId, guardianUserId, roomName, participantIdentity,
 * type and status are backend-determined and must be rejected if supplied.
 */
export const startCallSchema = z.strictObject({
  sosId: z.string().regex(OBJECT_ID, 'sosId must be a valid id'),
});

/**
 * Strict on purpose: userId, guardianUserId, sosId, roomName,
 * participantIdentity, status and endedAt are backend-determined and must be
 * rejected if supplied. Only the call and a controlled end reason may come
 * from the client.
 */
export const endCallSchema = z.strictObject({
  callId: z.string().regex(OBJECT_ID, 'callId must be a valid id'),
  // Optional — and `null` is simply "no reason given".
  endReason: z.enum([...CALL_END_REASONS]).nullish(),
});

/**
 * Acceptance carries no body at all: the guardian comes from the token and the
 * state comes from the stored record. Strict on purpose — an empty schema
 * rejects `status`, `guardianUserId`, `userId`, `roomName` and every other
 * backend-determined field instead of silently ignoring it.
 */
export const acceptCallSchema = z.strictObject({});

/**
 * `POST /calls/:id/accept` and `POST /calls/:id/reject` — the id in the URL is
 * the only client-supplied value.
 */
export const getCallByIdParamsSchema = z.object({
  id: z.string().regex(OBJECT_ID, 'id must be a valid id'),
});

/**
 * Declining carries no body either — the guardian comes from the token and the
 * outcome (REJECTED + its reason) is decided by the backend. Strict on purpose,
 * so `status`, `endReason`, `guardianUserId` and friends are rejected outright
 * instead of being silently ignored.
 */
export const rejectCallSchema = z.strictObject({});
