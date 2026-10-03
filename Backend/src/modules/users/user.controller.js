import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import {
  listUsers,
  getUserById,
  createUser,
  updateUserById,
  deleteUserById,
} from './user.service.js';

export const getUsers = asyncHandler(async (req, res) => {
  const users = await listUsers();
  return sendSuccess(res, { users });
});

export const getUser = asyncHandler(async (req, res) => {
  const user = await getUserById(req.params.id);
  return sendSuccess(res, { user });
});

export const createUserHandler = asyncHandler(async (req, res) => {
  const user = await createUser(req.body);
  return sendCreated(res, { user });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await updateUserById(req.params.id, req.body);
  return sendSuccess(res, { user });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const result = await deleteUserById(req.params.id);
  return sendSuccess(res, result);
});
