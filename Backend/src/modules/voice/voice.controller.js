import mongoose from "mongoose";
import { Readable } from "stream";
import { analyzeThreat, GroqError } from "../person3Services/groqThreat.service.js";
import {
  uploadVoiceRecording,
  deleteVoiceRecording,
  CloudinaryError,
} from "../person3Services/cloudinary.service.js";
import { VoiceRecording, SESSION_TYPES } from "./voiceRecording.model.js";
import { isDbConnected } from "../../config/db.js";
import { emitSafetyEvent } from "../../utils/safetyEventBus.js";

const THREAT_THRESHOLD = 40;
const MAX_TRANSCRIPTION_LENGTH = 5000;

function badRequest(res, code, message) {
  return res.status(400).json({ success: false, error: { code, message } });
}

export async function analyzeVoice(req, res) {
  const { transcription, safetySessionId, location } = req.body ?? {};

  if (transcription === undefined || transcription === null) {
    return badRequest(res, "VALIDATION_ERROR", "transcription is required");
  }
  if (typeof transcription !== "string") {
    return badRequest(res, "VALIDATION_ERROR", "transcription must be a string");
  }
  if (transcription.trim().length === 0) {
    return badRequest(res, "VALIDATION_ERROR", "transcription must not be empty");
  }
  if (transcription.length > MAX_TRANSCRIPTION_LENGTH) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      `transcription must not exceed ${MAX_TRANSCRIPTION_LENGTH} characters`
    );
  }

  try {
    const threatLevel = await analyzeThreat(transcription.trim());
    const sosTriggered = threatLevel > THREAT_THRESHOLD;

    if (sosTriggered) {
      emitSafetyEvent({
        type: "VOICE_DANGER",
        userId: req.user?.id || req.user?.userId || null,
        safetySessionId: safetySessionId || null,
        location: location || null,
        metadata: {
          threatLevel,
          transcriptionSnippet: transcription.trim().slice(0, 100),
        },
        source: "voice",
        timestamp: new Date(),
      });
    }

    return res.status(200).json({
      success: true,
      data: { threatLevel, sosTriggered },
    });
  } catch (err) {
    if (err instanceof GroqError) {
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    console.error("voice analyze error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  }
}

export async function recordVoiceRecording(req, res) {
  const { sessionId, type } = req.body ?? {};
  const audio = req.file;

  if (!audio || !audio.buffer || audio.buffer.length === 0) {
    return badRequest(res, "VALIDATION_ERROR", "audio file is required (field name: audio)");
  }
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return badRequest(res, "VALIDATION_ERROR", "sessionId is required");
  }
  if (!SESSION_TYPES.includes(type)) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      `type must be one of: ${SESSION_TYPES.join(", ")}`
    );
  }

  const cleanSessionId = sessionId.trim();

  if (!isDbConnected()) {
    return res.status(500).json({
      success: false,
      error: { code: "DATABASE_UNAVAILABLE", message: "Database is not available" },
    });
  }

  try {
    const existing = await VoiceRecording.exists({ sessionId: cleanSessionId });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: "DUPLICATE_SESSION",
          message: "A recording already exists for this sessionId",
        },
      });
    }
  } catch (err) {
    console.error("voice recording lookup error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "DATABASE_ERROR", message: "Failed to check the recording" },
    });
  }

  let uploaded;

  try {
    uploaded = await uploadVoiceRecording({
      buffer: audio.buffer,
      type,
      sessionId: cleanSessionId,
    });
  } catch (err) {
    if (err instanceof CloudinaryError) {
      return res.status(err.code === "CLOUDINARY_NOT_CONFIGURED" ? 500 : 502).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    console.error("voice recording upload error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  }

  try {
    const recording = await VoiceRecording.create({
      sessionId: cleanSessionId,
      type,
      fileName: audio.originalname,
      audioUrl: uploaded.audioUrl,
      cloudinaryPublicId: uploaded.cloudinaryPublicId,
    });

    return res.status(201).json({
      success: true,
      data: {
        sessionId: recording.sessionId,
        type: recording.type,
        fileName: recording.fileName,
        audioUrl: recording.audioUrl,
        recordingId: recording._id,
      },
    });
  } catch (err) {
    console.error("voice recording save error:", err);
    await deleteVoiceRecording(uploaded);

    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: {
          code: "DUPLICATE_SESSION",
          message: "A recording already exists for this sessionId",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: { code: "DATABASE_ERROR", message: "Failed to save the voice recording" },
    });
  }
}

function fallbackFileName(cloudinaryPublicId) {
  const parts = String(cloudinaryPublicId || "").split("/");
  return parts[parts.length - 1] || "recording";
}

function serverError(res, code, message) {
  return res.status(500).json({ success: false, error: { code, message } });
}

export async function listVoiceRecordings(req, res) {
  const { sessionId } = req.query ?? {};
  const filter = {};

  if (sessionId !== undefined) {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return badRequest(res, "VALIDATION_ERROR", "sessionId query must not be empty");
    }
    filter.sessionId = sessionId.trim();
  }

  if (!isDbConnected()) {
    return serverError(res, "DATABASE_UNAVAILABLE", "Database is not available");
  }

  try {
    const recordings = await VoiceRecording.find(filter).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: recordings.map((recording) => ({
        recordingId: recording._id,
        sessionId: recording.sessionId,
        type: recording.type,
        fileName: recording.fileName || fallbackFileName(recording.cloudinaryPublicId),
        audioUrl: recording.audioUrl,
        createdAt: recording.createdAt,
      })),
    });
  } catch (err) {
    console.error("voice recording list error:", err);
    return serverError(res, "DATABASE_ERROR", "Failed to fetch recordings");
  }
}

export async function streamVoiceRecording(req, res) {
  const { recordingId } = req.params;

  if (!mongoose.isValidObjectId(recordingId)) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Recording not found" },
    });
  }

  if (!isDbConnected()) {
    return serverError(res, "DATABASE_UNAVAILABLE", "Database is not available");
  }

  let recording;
  try {
    recording = await VoiceRecording.findById(recordingId);
  } catch (err) {
    console.error("voice recording lookup error:", err);
    return serverError(res, "DATABASE_ERROR", "Failed to fetch the recording");
  }

  if (!recording) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Recording not found" },
    });
  }

  let upstream;
  try {
    upstream = await fetch(recording.audioUrl);
  } catch (err) {
    console.error("audio fetch error:", err.message);
    return res.status(502).json({
      success: false,
      error: { code: "AUDIO_FETCH_FAILED", message: "Failed to fetch the audio file" },
    });
  }

  if (!upstream.ok || !upstream.body) {
    console.error("audio fetch failed with status:", upstream.status);
    return res.status(502).json({
      success: false,
      error: { code: "AUDIO_FETCH_FAILED", message: "Failed to fetch the audio file" },
    });
  }

  const fileName =
    recording.fileName || fallbackFileName(recording.cloudinaryPublicId);
  const safeName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");

  res.status(200);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  res.set(
    "Content-Disposition",
    `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );
  res.set("Cache-Control", "public, max-age=3600");

  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (err) => {
    console.error("audio stream error:", err.message);
    res.destroy(err);
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
