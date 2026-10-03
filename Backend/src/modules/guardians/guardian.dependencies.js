/**
 * TEMPORARY READ-ONLY ADAPTER — Person 3's `users` collection.
 *
 * Person 3 owns the User model; it does not exist yet, so this reads their
 * collection directly WITHOUT defining an alternative schema (no duplicated
 * ownership).
 *
 * Interface contract (keep stable, swap implementation later):
 *   findUserById(userId) -> { _id } | null
 */
import mongoose from 'mongoose';

export async function findUserById(userId) {
  return mongoose.connection
    .collection('users')
    .findOne({ _id: new mongoose.Types.ObjectId(String(userId)) });
}
