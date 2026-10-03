import express from "express";
import {
  analyzeVoice,
  recordVoiceRecording,
  listVoiceRecordings,
  streamVoiceRecording,
} from "./voice.controller.js";
import { translateToEnglishMiddleware } from "../../middleware/translate.middleware.js";
import { uploadAudioMiddleware } from "../../middleware/upload.middleware.js";

const router = express.Router();

router.post("/analyze", translateToEnglishMiddleware, analyzeVoice);
router.get("/recordings", listVoiceRecordings);
router.post("/recordings", uploadAudioMiddleware, recordVoiceRecording);
router.get("/recordings/:recordingId/audio", streamVoiceRecording);

export default router;
