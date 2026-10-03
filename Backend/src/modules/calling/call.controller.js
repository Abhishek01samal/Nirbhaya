import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess, sendError } from '../../utils/response.js';
import {
  acceptCall,
  createCallToken,
  endCall,
  rejectCall,
  startEmergencyCall,
} from './call.service.js';

export const toCallResponse = (call) => ({
  id: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  userId: call.userId ? String(call.userId) : null,
  guardianUserId: call.guardianUserId ? String(call.guardianUserId) : null,
  type: call.type,
  status: call.status,
  roomName: call.roomName,
  createdAt: call.createdAt,
});

/** The `/calls/end` view of a call: outcome only, no connection details. */
export const toCallEndResponse = (call) => ({
  id: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  userId: call.userId ? String(call.userId) : null,
  guardianUserId: call.guardianUserId ? String(call.guardianUserId) : null,
  type: call.type,
  status: call.status,
  endedAt: call.endedAt,
  endReason: call.endReason ?? null,
});

export const createCallTokenController = asyncHandler(async (req, res) => {
  const { callId } = req.body;

  const connection = await createCallToken({ callId, userId: req.user.id });

  return sendSuccess(res, connection);
});

export const startCallController = asyncHandler(async (req, res) => {
  const result = await startEmergencyCall({ sosId: req.body.sosId, userId: req.user.id });

  if (!result.created) {
    return sendError(
      res,
      409,
      'CALL_ALREADY_ACTIVE',
      'An emergency call is already in progress for this SOS',
      { existing: toCallResponse(result.existing) }
    );
  }

  return sendCreated(res, { call: toCallResponse(result.call) });
});

export const acceptCallController = asyncHandler(async (req, res) => {
  // Identity and state are backend-derived: the id comes from validated params
  // and the guardian from the verified token — never from a body.
  const result = await acceptCall({ callId: req.params.id, userId: req.user.id });

  return sendSuccess(res, { message: 'Call accepted', call: toCallResponse(result.call) });
});

export const rejectCallController = asyncHandler(async (req, res) => {
  // Same contract as accept: id from validated params, guardian from the
  // verified token, outcome decided by the backend — never by a body.
  const result = await rejectCall({ callId: req.params.id, userId: req.user.id });

  // The outcome view: terminal state, reason and timestamp — no room details.
  return sendSuccess(res, { message: 'Call rejected', call: toCallEndResponse(result.call) });
});

export const endCallController = asyncHandler(async (req, res) => {
  const result = await endCall({
    callId: req.body.callId,
    userId: req.user.id,
    endReason: req.body.endReason ?? null,
  });

  // 200 for both the real transition and the idempotent replay of one.
  return sendSuccess(res, { call: toCallEndResponse(result.call) });
});
