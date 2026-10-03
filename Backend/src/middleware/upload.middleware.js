import multer from "multer";

const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;

const ACCEPTED_MIME_TYPES = [
  "audio/*",
  "video/webm",
  "video/mp4",
  "video/ogg",
  "application/octet-stream",
  "application/ogg",
];

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const { mimetype } = file;
    const accepted = ACCEPTED_MIME_TYPES.some((pattern) =>
      pattern.endsWith("*")
        ? mimetype.startsWith(pattern.slice(0, -1))
        : mimetype === pattern
    );

    if (!accepted) {
      const typeError = new Error("only audio files are accepted");
      typeError.code = "INVALID_FILE_TYPE";
      return cb(typeError);
    }
    cb(null, true);
  },
}).single("audio");

function uploadAudioMiddleware(req, res, next) {
  audioUpload(req, res, (err) => {
    if (!err) return next();

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `audio file must not exceed ${MAX_AUDIO_SIZE_BYTES / (1024 * 1024)}MB`,
        },
      });
    }

    if (err.code === "INVALID_FILE_TYPE") {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: err.message },
      });
    }

    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            err.field && err.field !== "audio"
              ? `unexpected field "${err.field}"; send the file as "audio"`
              : "only audio files are accepted",
        },
      });
    }

    return res.status(400).json({
      success: false,
      error: { code: "UPLOAD_ERROR", message: err.message },
    });
  });
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) return cb(null, true);
    const typeError = new Error("only image files are accepted");
    typeError.code = "INVALID_FILE_TYPE";
    return cb(typeError);
  },
});

export function uploadSingle(fieldName) {
  const handler = imageUpload.single(fieldName);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "image file must not exceed 20MB" } });
      }
      return res.status(400).json({ success: false, error: { code: "UPLOAD_ERROR", message: err.message } });
    });
  };
}

export { uploadAudioMiddleware };
export default uploadAudioMiddleware;
