import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import {
  createGuardian as createGuardianService,
  getGuardians as getGuardiansService,
  updateGuardian as updateGuardianService,
  removeGuardian as removeGuardianService,
  acceptGuardian as acceptGuardianService,
  rejectGuardian as rejectGuardianService,
} from './guardian.service.js';

export const toGuardianResponse = (guardian) => ({
  id: String(guardian._id),
  userId: String(guardian.userId),
  guardianUserId: String(guardian.guardianUserId),
  relationship: guardian.relationship,
  priority: guardian.priority,
  status: guardian.status,
  createdAt: guardian.createdAt,
  updatedAt: guardian.updatedAt,
});

// List view: the caller already owns these rows, so userId is redundant.
const toGuardianListItem = (guardian) => {
  const { userId: _userId, ...item } = toGuardianResponse(guardian);
  return item;
};

export const createGuardian = asyncHandler(async (req, res) => {
  const { guardianUserId, relationship, priority } = req.body;

  const guardian = await createGuardianService({
    userId: req.user.id,
    guardianUserId,
    relationship,
    priority,
  });

  return sendCreated(res, { guardian: toGuardianResponse(guardian) });
});

export const getGuardians = asyncHandler(async (req, res) => {
  const guardians = await getGuardiansService({ userId: req.user.id });

  return sendSuccess(res, { guardians: guardians.map(toGuardianListItem) });
});

export const updateGuardian = asyncHandler(async (req, res) => {
  const guardian = await updateGuardianService({
    guardianId: req.params.id,
    userId: req.user.id,
    data: req.body,
  });

  return sendSuccess(res, { guardian: toGuardianResponse(guardian) });
});

export const removeGuardian = asyncHandler(async (req, res) => {
  const { guardian } = await removeGuardianService({
    guardianId: req.params.id,
    userId: req.user.id,
  });

  return sendSuccess(res, { guardian: toGuardianResponse(guardian) });
});

export const acceptGuardian = asyncHandler(async (req, res) => {
  const { guardian } = await acceptGuardianService({
    guardianId: req.params.id,
    guardianUserId: req.user.id,
  });

  return sendSuccess(res, { guardian: toGuardianResponse(guardian) });
});

export const rejectGuardian = asyncHandler(async (req, res) => {
  const { guardian } = await rejectGuardianService({
    guardianId: req.params.id,
    guardianUserId: req.user.id,
  });

  return sendSuccess(res, { guardian: toGuardianResponse(guardian) });
});
