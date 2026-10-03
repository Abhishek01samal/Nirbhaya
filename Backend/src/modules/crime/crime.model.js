import mongoose from "mongoose";

export const CRIME_CATEGORIES = [
  "harassment",
  "theft",
  "robbery",
  "assault",
  "snatching",
  "accident",
  "unsafe-lighting",
  "unsafe-isolated",
  "other",
];

const crimeIncidentSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CRIME_CATEGORIES, required: true, index: true },
    severity: { type: Number, min: 1, max: 5, required: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, default: "" },
    area: { type: String, default: "" },
    occurredAt: { type: Date, default: Date.now, index: true },
    count: { type: Number, default: 1, min: 1 },
    source: { type: String, enum: ["seed", "report", "import"], default: "seed" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

crimeIncidentSchema.index({ lat: 1, lng: 1 });
crimeIncidentSchema.index({ category: 1, occurredAt: -1 });

export const CrimeIncident = mongoose.model("CrimeIncident", crimeIncidentSchema);
export default CrimeIncident;
