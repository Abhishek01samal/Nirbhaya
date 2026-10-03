/**
 * TEMPORARY READ-ONLY ADAPTERS — Person 2 / Person 3 data.
 *
 * Person 3 owns the `users` model, Person 2 owns the `safetySessions` model.
 * Those models do not exist yet, so this file reads their collections directly
 * WITHOUT defining alternative schemas (no duplicated ownership).
 *
 * Interface contract (keep stable, swap implementation later):
 *   findSafetySessionById(sessionId) -> { _id, userId } | null
 *   getUserEmergencySettings(userId) -> { sosTimeoutSeconds, ... } | null
 */
import mongoose from 'mongoose';

const { Types } = mongoose;

export async function findSafetySessionById(safetySessionId) {
  return mongoose.connection
    .collection('safetySessions')
    .findOne(
      { _id: new Types.ObjectId(safetySessionId) },
      { projection: { userId: 1 } }
    );
}

export async function getUserEmergencySettings(userId) {
  const doc = await mongoose.connection
    .collection('users')
    .findOne(
      { _id: new Types.ObjectId(String(userId)) },
      { projection: { emergencySettings: 1 } }
    );

  return doc?.emergencySettings ?? null;
}
