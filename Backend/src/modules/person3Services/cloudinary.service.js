import { cloudinary, isCloudinaryConfigured } from "../../config/cloudinary.js";

export const RECORDINGS_FOLDER = "voice-recordings";

export class CloudinaryError extends Error {
  constructor(message, code = "CLOUDINARY_UPLOAD_FAILED") {
    super(message);
    this.name = "CloudinaryError";
    this.code = code;
  }
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

function buildRecordingFolder(type, sessionId) {
  return `${RECORDINGS_FOLDER}/${sanitizeSegment(type)}/${sanitizeSegment(sessionId)}`;
}

export async function uploadVoiceRecording({ buffer, type, sessionId }) {
  if (!isCloudinaryConfigured) {
    throw new CloudinaryError(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
      "CLOUDINARY_NOT_CONFIGURED"
    );
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: buildRecordingFolder(type, sessionId),
          resource_type: "auto",
        },
        (err, uploaded) => (err ? reject(err) : resolve(uploaded))
      );
      stream.end(buffer);
    });

    return {
      audioUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      resourceType: result.resource_type,
    };
  } catch (err) {
    console.error("cloudinary upload error:", err.message);
    throw new CloudinaryError("Failed to upload the audio file to Cloudinary");
  }
}

export async function deleteVoiceRecording(uploaded) {
  try {
    await cloudinary.uploader.destroy(uploaded.cloudinaryPublicId, {
      resource_type: uploaded.resourceType || "image",
    });
  } catch (err) {
    console.error("cloudinary cleanup error:", err.message);
  }
}
