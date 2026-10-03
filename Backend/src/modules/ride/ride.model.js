import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { geoPointSchema } from "../safetySession/safetySession.model.js";

const routeStepSchema = new mongoose.Schema(
  {
    instruction: { type: String, default: "" },
    distanceM: { type: Number, default: 0 },
    durationS: { type: Number, default: 0 },
    startLocation: { lat: Number, lng: Number },
  },
  { _id: false }
);

const rideFlagSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["OFF_ROUTE", "LONG_STOP", "GEOFENCE_BREACH", "ARRIVED"],
      required: true,
    },
    at: { type: Date, default: Date.now },
    location: { lat: Number, lng: Number },
    metadata: { type: Object, default: {} },
  },
  { _id: false }
);

const rideSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    safetySessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SafetySession",
      default: null,
    },
    status: {
      type: String,
      enum: ["draft", "uploaded", "confirmed", "active", "completed", "cancelled"],
      default: "draft",
      index: true,
    },

    // Driver / vehicle details (prefilled by OCR, corrected by user on confirm)
    provider: { type: String, default: "other" },
    driver: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    vehicleNumber: { type: String, default: "", index: true },
    vehicleModel: { type: String, default: "" },
    fareEstimate: { type: Number, default: null },
    tripNote: { type: String, default: "" },

    screenshot: {
      stored: { type: Boolean, default: false },
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
      originalName: { type: String, default: "" },
      sizeBytes: { type: Number, default: 0 },
      ocrText: { type: String, default: "" },
      ocrFields: { type: Object, default: {} },
      ocrError: { type: String, default: "" },
    },

    pickup: { type: geoPointSchema, default: null },
    drop: { type: geoPointSchema, default: null },

    route: {
      polyline: [{ lat: Number, lng: Number }],
      distanceM: { type: Number, default: 0 },
      durationS: { type: Number, default: 0 },
      summary: { type: String, default: "" },
      steps: [routeStepSchema],
      source: { type: String, enum: ["google", "manual", "none"], default: "none" },
      fetchedAt: { type: Date, default: null },
    },

    monitoring: {
      offRouteThresholdM: { type: Number, default: env.OFF_ROUTE_THRESHOLD_M },
      stopSeconds: { type: Number, default: env.STOP_SECONDS },
      stopRadiusM: { type: Number, default: env.STOP_RADIUS_M },
      offRouteCounter: { type: Number, default: 0 },
      lastOffRouteAt: { type: Date, default: null },
      lastRouteDistanceM: { type: Number, default: null },
      stopAnchor: { lat: Number, lng: Number },
      stopStartedAt: { type: Date, default: null },
      longStopEmittedAt: { type: Date, default: null },
      flags: { type: [rideFlagSchema], default: [] },
    },

    startedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

rideSchema.index({ userId: 1, status: 1, createdAt: -1 });

rideSchema.virtual("durationSeconds").get(function () {
  if (!this.startedAt) return null;
  const end = this.stoppedAt ?? new Date();
  return Math.max(0, (end - this.startedAt) / 1000);
});

/** Reset all per-trip monitoring counters when a ride (re)starts. */
rideSchema.methods.resetMonitoring = function () {
  this.monitoring.offRouteCounter = 0;
  this.monitoring.lastOffRouteAt = null;
  this.monitoring.lastRouteDistanceM = null;
  this.monitoring.stopAnchor = undefined;
  this.monitoring.stopStartedAt = null;
  this.monitoring.longStopEmittedAt = null;
  this.monitoring.flags = [];
};

export const Ride = mongoose.model("Ride", rideSchema);
export default Ride;
