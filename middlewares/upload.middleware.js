import multer from 'multer';
import { AppError } from '../utils/http.js';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

export function hasValidImageSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true;
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }

  // AVIF / HEIF ISO Base Media File Format: .... "ftyp" ("avif" | "avis" | "mif1")
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
      return true;
    }
  }

  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: 1,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          'INVALID_IMAGE_FILE',
          'Only JPEG, PNG, WebP, and AVIF image files are allowed.'
        )
      );
    }
    return cb(null, true);
  },
});

export function uploadSingleImage(fieldName = 'image') {
  const singleMiddleware = upload.single(fieldName);

  return (req, res, next) => {
    singleMiddleware(req, res, (err) => {
      if (err) {
        if (err instanceof AppError) {
          return next(err);
        }
        if (err instanceof multer.MulterError) {
          const message =
            err.code === 'LIMIT_FILE_SIZE'
              ? 'Image file size must not exceed 5MB.'
              : `Invalid image upload: ${err.message}`;
          return next(new AppError(400, 'INVALID_IMAGE_FILE', message));
        }
        return next(new AppError(400, 'INVALID_IMAGE_FILE', 'Failed to process image upload.'));
      }

      if (req.file && !hasValidImageSignature(req.file.buffer)) {
        return next(
          new AppError(
            400,
            'INVALID_IMAGE_FILE',
            'Uploaded file content does not match a valid JPEG, PNG, WebP, or AVIF image.'
          )
        );
      }

      return next();
    });
  };
}

export default uploadSingleImage;
