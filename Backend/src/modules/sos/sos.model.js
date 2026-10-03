import mongoose from 'mongoose';
import { SOS_STATUS, SOS_TRIGGER_TYPES } from './sos.constants.js';

const { Schema, model, models } = mongoose;

const triggerDataSchema = new Schema(
  {
    riskLevel: { type: String, trim: true, maxlength: 20 },
    confidence: { type: Number, min: 0, max: 1 },
    reason: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const locationSchema = new Schema(
  {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    address: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const verificationSchema = new Schema(
  {
    expiresAt: { type: Date, default: null },
    userResponse: { type: String, default: null },
    respondedAt: { type: Date, default: null },
  },
  { _id: false }
);

const escalationSchema = new Schema(
  {
    currentLevel: { type: Number, default: 0, min: 0 },
    levels: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

const sosEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    safetySessionId: { type: Schema.Types.ObjectId, ref: 'SafetySession', default: null },

    triggerType: { type: String, enum: SOS_TRIGGER_TYPES, required: true },

    status: { type: String, enum: Object.values(SOS_STATUS), default: SOS_STATUS.VERIFYING },

    triggerData: { type: triggerDataSchema, default: undefined },

    location: { type: locationSchema, default: null },

    verification: { type: verificationSchema, default: () => ({}) },

    escalation: { type: escalationSchema, default: () => ({}) },

    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'sosEvents',
  }
);

sosEventSchema.index({ userId: 1, status: 1 });
sosEventSchema.index({ safetySessionId: 1 });
sosEventSchema.index({ status: 1, 'verification.expiresAt': 1 });
sosEventSchema.index({ createdAt: -1 });

export const SosEvent = models.SosEvent || model('SosEvent', sosEventSchema);
