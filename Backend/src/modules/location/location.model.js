import mongoose from "mongoose";
import { env } from "../../config/env.js";

const locationPointSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    safetySessionId: { type: mongoose.Schema.Types.ObjectId, ref: "SafetySession", default: null },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", default: null },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    accuracy: { type: Number, default: null },
    altitude: { type: Number, default: null },
    speed: { type: Number, default: null }, // m/s
    heading: { type: Number, default: null }, // degrees
    recordedAt: { type: Date, default: Date.now },
    source: { type: String, enum: ["socket", "http", "import"], default: "http" },
  },
  { timestamps: true }
);

locationPointSchema.index({ userId: 1, recordedAt: -1 });
locationPointSchema.index({ rideId: 1, recordedAt: -1 });
locationPointSchema.index({ safetySessionId: 1, recordedAt: -1 });

// Auto-delete raw points after LOCATION_TTL_DAYS.
locationPointSchema.index({ recordedAt: 1 }, { expireAfterSeconds: env.LOCATION_TTL_DAYS * 86400 });

locationPointSchema.index({ lat: 1, lng: 1 }); // 2d-compatible range queries

export const LocationPoint = mongoose.model("LocationPoint", locationPointSchema);
export default LocationPoint;
