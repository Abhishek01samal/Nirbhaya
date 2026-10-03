import mongoose from "mongoose";

const geoPointSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: "" },
  },
  { _id: false }
);

const safetySessionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    status: {
      type: String,
      enum: ["active", "ended", "cancelled"],
      default: "active",
      index: true,
    },
    mode: {
      type: String,
      enum: ["walk", "ride", "static", "travel"],
      default: "static",
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    origin: { type: geoPointSchema, default: null },
    destination: { type: geoPointSchema, default: null },
    rideRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Ride" }],
    lastLocation: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      speed: Number,
      recordedAt: Date,
    },
    eventCount: { type: Number, default: 0 },
    metadata: { type: Object, default: {} },
    note: { type: String, default: "" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// At most one active session per user.
safetySessionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
safetySessionSchema.index({ userId: 1, status: 1, startedAt: -1 });

safetySessionSchema.virtual("durationSeconds").get(function () {
  const end = this.endedAt ?? new Date();
  return Math.max(0, (end - this.startedAt) / 1000);
});

export const SafetySession = mongoose.model("SafetySession", safetySessionSchema);
export { geoPointSchema };
export default SafetySession;
