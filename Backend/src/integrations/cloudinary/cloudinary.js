import { cloudinary, isCloudinaryConfigured } from "../../config/cloudinary.js";

export class CloudinaryIntegrationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function uploadImage(buffer, { originalName = "image" } = {}) {
  if (!isCloudinaryConfigured) {
    throw new CloudinaryIntegrationError("CLOUDINARY_NOT_CONFIGURED", "Cloudinary is not configured");
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "ride-screenshots", resource_type: "image", public_id: undefined },
      (err, result) => {
        if (err) return reject(new CloudinaryIntegrationError("CLOUDINARY_UPLOAD_FAILED", err.message));
        resolve({ url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height });
      }
    );
    stream.end(buffer);
  });
}
