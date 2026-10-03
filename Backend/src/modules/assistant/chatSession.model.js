import mongoose from "mongoose";

const { Schema } = mongoose;

const ChatSessionSchema = new Schema(
  {
    sessionId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    summary: {
      type: String,
      default: "",
    },
    summaryCoveredCount: {
      type: Number,
      default: 0,
    },
    language: {
      type: String,
      default: "",
    },
    script: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

export const ChatSession =
  mongoose.models.ChatSession || mongoose.model("ChatSession", ChatSessionSchema);
