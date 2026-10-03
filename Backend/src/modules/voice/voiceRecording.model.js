import mongoose from "mongoose";

const { Schema } = mongoose;

export const SESSION_TYPES = ["ride", "other"];

const VoiceRecordingSchema = new Schema(
  {
    sessionId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: SESSION_TYPES,
      required: true,
    },
    fileName: {
      type: String,
    },
    audioUrl: {
      type: String,
      required: true,
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

VoiceRecordingSchema.index({ sessionId: 1 }, { unique: true });

export const VoiceRecording =
  mongoose.models.VoiceRecording ||
  mongoose.model("VoiceRecording", VoiceRecordingSchema);
