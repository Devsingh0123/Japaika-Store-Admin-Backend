import multer from 'multer';
import { AppError } from '../utils/http.js';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_VIDEO_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PRODUCT_MEDIA = 10;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

export const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
]);

export const ALLOWED_PRODUCT_MEDIA_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
]);

export const ALLOWED_CERTIFICATE_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_MIME_TYPES,
  'application/pdf',
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

export function hasValidVideoSignature(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  // WebM / Matroska EBML header: 1A 45 DF A3
  const isEbml =
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3;

  if (mimetype === 'video/webm') {
    return isEbml;
  }

  // MP4 ISO Base Media File Format: bytes 4..8 === "ftyp" (excluding AVIF image brands)
  const isFtyp = buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  const brand = buffer.subarray(8, 12).toString('ascii');
  const isMp4 = isFtyp && brand !== 'avif' && brand !== 'avis';

  if (mimetype === 'video/mp4') {
    return isMp4;
  }

  return isEbml || isMp4;
}

export function hasValidProductMediaSignature(buffer, mimetype) {
  if (ALLOWED_IMAGE_MIME_TYPES.has(mimetype)) {
    return hasValidImageSignature(buffer);
  }
  if (ALLOWED_VIDEO_MIME_TYPES.has(mimetype)) {
    return hasValidVideoSignature(buffer, mimetype);
  }
  return false;
}

export function hasValidPdfSignature(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  );
}

export function hasValidCertificateSignature(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    return hasValidPdfSignature(buffer);
  }
  return ALLOWED_IMAGE_MIME_TYPES.has(mimetype) && hasValidImageSignature(buffer);
}

const imageOnlyUpload = multer({
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

const productMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_SIZE_BYTES,
    files: MAX_PRODUCT_MEDIA,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_PRODUCT_MEDIA_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          'INVALID_MEDIA_FILE',
          'Only JPEG, PNG, WebP, AVIF images and MP4, WebM short videos are allowed.'
        )
      );
    }
    return cb(null, true);
  },
});

const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: 1,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_CERTIFICATE_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          'INVALID_CERTIFICATE_FILE',
          'Only JPEG, PNG, WebP, AVIF, or PDF certificate files are allowed.'
        )
      );
    }
    return cb(null, true);
  },
});

const bannerImagesUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: 2,
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

const productCreateUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_SIZE_BYTES,
    files: MAX_PRODUCT_MEDIA + 1,
  },
  fileFilter(_req, file, cb) {
    if (file.fieldname === 'certificate') {
      if (!ALLOWED_CERTIFICATE_MIME_TYPES.has(file.mimetype)) {
        return cb(
          new AppError(
            400,
            'INVALID_CERTIFICATE_FILE',
            'Only JPEG, PNG, WebP, AVIF, or PDF certificate files are allowed.'
          )
        );
      }
      return cb(null, true);
    }

    if (!ALLOWED_PRODUCT_MEDIA_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new AppError(
          400,
          'INVALID_MEDIA_FILE',
          'Only JPEG, PNG, WebP, AVIF images and MP4, WebM short videos are allowed.'
        )
      );
    }
    return cb(null, true);
  },
});

function formatMulterError(err, defaultCode = 'INVALID_IMAGE_FILE') {
  if (err instanceof AppError) return err;
  if (err instanceof multer.MulterError) {
    const code = err.field === 'certificate' ? 'INVALID_CERTIFICATE_FILE' : defaultCode;
    if (err.code === 'LIMIT_FILE_SIZE') {
      const limitLabel = code === 'INVALID_MEDIA_FILE' ? '20MB (5MB for images)' : '5MB';
      return new AppError(400, code, `Uploaded file size must not exceed ${limitLabel}.`);
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return new AppError(
        400,
        code,
        `Too many files or unexpected upload field (${err.field || 'file'}).`
      );
    }
    return new AppError(400, code, `Invalid file upload: ${err.message}`);
  }
  return new AppError(400, defaultCode, 'Failed to process file upload.');
}

function validateProductMediaFileBuffer(file) {
  if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype) && file.buffer.length > MAX_IMAGE_SIZE_BYTES) {
    return new AppError(
      400,
      'INVALID_MEDIA_FILE',
      'Uploaded image file size must not exceed 5MB.'
    );
  }

  if (!hasValidProductMediaSignature(file.buffer, file.mimetype)) {
    return new AppError(
      400,
      'INVALID_MEDIA_FILE',
      'Uploaded file content does not match a valid image (JPEG, PNG, WebP, AVIF) or short video (MP4, WebM).'
    );
  }

  return null;
}

export function uploadSingleImage(fieldName = 'image') {
  const singleMiddleware = imageOnlyUpload.single(fieldName);

  return (req, res, next) => {
    singleMiddleware(req, res, (err) => {
      if (err) {
        return next(formatMulterError(err, 'INVALID_IMAGE_FILE'));
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

export function uploadProductMedia(fieldName = 'media', maxCount = MAX_PRODUCT_MEDIA) {
  const arrayMiddleware = productMediaUpload.array(fieldName, maxCount);

  return (req, res, next) => {
    arrayMiddleware(req, res, (err) => {
      if (err) {
        return next(formatMulterError(err, 'INVALID_MEDIA_FILE'));
      }

      const files = req.files || [];
      for (const file of files) {
        const validationError = validateProductMediaFileBuffer(file);
        if (validationError) {
          return next(validationError);
        }
      }

      return next();
    });
  };
}

export function uploadProductCertificate(fieldName = 'certificate') {
  const singleCertMiddleware = certificateUpload.single(fieldName);

  return (req, res, next) => {
    singleCertMiddleware(req, res, (err) => {
      if (err) {
        return next(formatMulterError(err, 'INVALID_CERTIFICATE_FILE'));
      }

      if (req.file && !hasValidCertificateSignature(req.file.buffer, req.file.mimetype)) {
        return next(
          new AppError(
            400,
            'INVALID_CERTIFICATE_FILE',
            'Uploaded certificate content does not match a valid JPEG, PNG, WebP, AVIF, or PDF file.'
          )
        );
      }

      return next();
    });
  };
}

export function uploadProductCreateFiles() {
  const fieldsMiddleware = productCreateUpload.fields([
    { name: 'media', maxCount: MAX_PRODUCT_MEDIA },
    { name: 'certificate', maxCount: 1 },
  ]);

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      return next();
    }

    fieldsMiddleware(req, res, (err) => {
      if (err) {
        return next(formatMulterError(err, 'INVALID_MEDIA_FILE'));
      }

      const mediaFiles = req.files?.media || [];
      for (const file of mediaFiles) {
        const validationError = validateProductMediaFileBuffer(file);
        if (validationError) {
          return next(validationError);
        }
      }

      const certFile = req.files?.certificate?.[0];
      if (certFile) {
        if (certFile.buffer.length > MAX_IMAGE_SIZE_BYTES) {
          return next(
            new AppError(
              400,
              'INVALID_CERTIFICATE_FILE',
              'Uploaded certificate file size must not exceed 5MB.'
            )
          );
        }
        if (!hasValidCertificateSignature(certFile.buffer, certFile.mimetype)) {
          return next(
            new AppError(
              400,
              'INVALID_CERTIFICATE_FILE',
              'Uploaded certificate content does not match a valid JPEG, PNG, WebP, AVIF, or PDF file.'
            )
          );
        }
      }

      if (typeof req.body?.payload === 'string') {
        try {
          req.body = JSON.parse(req.body.payload);
        } catch {
          return next(new AppError(400, 'INVALID_JSON', 'Malformed JSON in multipart payload field.'));
        }
      }

      return next();
    });
  };
}

export function uploadBannerImages() {
  const fieldsMiddleware = bannerImagesUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'mobileImage', maxCount: 1 },
  ]);

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      return next();
    }

    fieldsMiddleware(req, res, (err) => {
      if (err) {
        return next(formatMulterError(err, 'INVALID_IMAGE_FILE'));
      }

      const uploadedFiles = [
        ...(req.files?.image || []),
        ...(req.files?.mobileImage || []),
      ];

      for (const file of uploadedFiles) {
        if (!hasValidImageSignature(file.buffer)) {
          return next(
            new AppError(
              400,
              'INVALID_IMAGE_FILE',
              'Uploaded file content does not match a valid JPEG, PNG, WebP, or AVIF image.'
            )
          );
        }
      }

      return next();
    });
  };
}

export default uploadSingleImage;
