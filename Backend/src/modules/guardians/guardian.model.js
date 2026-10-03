import mongoose from 'mongoose';
import { GUARDIAN_STATUS, GUARDIAN_STATUSES } from './guardian.constants.js';

const { Schema, model, models } = mongoose;

const guardianSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    guardianUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    relationship: { type: String, required: true, trim: true, maxlength: 50 },

    priority: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'priority must be an integer',
      },
    },

    status: { type: String, enum: GUARDIAN_STATUSES, default: GUARDIAN_STATUS.PENDING },
  },
  {
    timestamps: true,
    collection: 'guardians',
  }
);

// Relationship identity: one record per (user, guardian) pair, whatever the
// status. This is the database-level backstop for the service's duplicate check.
guardianSchema.index({ userId: 1, guardianUserId: 1 }, { unique: true });

// SOS escalation loads a user's guardians ordered by priority ASC.
guardianSchema.index({ userId: 1, priority: 1 });

export const Guardian = models.Guardian || model('Guardian', guardianSchema);
