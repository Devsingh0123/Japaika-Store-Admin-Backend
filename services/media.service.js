import { v2 as cloudinary } from 'cloudinary';
import { AppError } from '../utils/http.js';

export const ALLOWED_CLOUDINARY_PREFIX = 'japaika-ecom/';

export const CLOUDINARY_FOLDERS = Object.freeze({
  CATEGORIES: 'japaika-ecom/categories',
});

function hasCloudinaryCredentials() {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

  if (!cloudName || !apiKey || !apiSecret) {
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return true;
}

export function isSafeJapaikaEcomPublicId(publicId) {
  return typeof publicId === 'string' && publicId.trim().startsWith(ALLOWED_CLOUDINARY_PREFIX);
}

export async function uploadImageBuffer(
  buffer,
  { folder = CLOUDINARY_FOLDERS.CATEGORIES } = {}
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(400, 'INVALID_IMAGE_FILE', 'Image file buffer is empty or invalid.');
  }

  if (typeof folder !== 'string' || !folder.startsWith(ALLOWED_CLOUDINARY_PREFIX)) {
    throw new AppError(
      500,
      'INVALID_UPLOAD_FOLDER',
      `Cloudinary folder must start with "${ALLOWED_CLOUDINARY_PREFIX}".`
    );
  }

  if (!hasCloudinaryCredentials()) {
    throw new AppError(
      503,
      'MEDIA_STORAGE_NOT_CONFIGURED',
      'Cloudinary media storage credentials are not configured.'
    );
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
      },
      (err, result) => {
        if (err || !result?.secure_url || !result?.public_id) {
          return reject(
            new AppError(
              502,
              'IMAGE_UPLOAD_FAILED',
              'Failed to upload image to media storage. Please try again.'
            )
          );
        }

        return resolve({
          imageUrl: result.secure_url,
          imagePublicId: result.public_id,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

export async function deleteImageByPublicId(publicId) {
  if (!publicId || typeof publicId !== 'string' || !publicId.trim()) {
    return { deleted: false, reason: 'EMPTY_PUBLIC_ID' };
  }

  const normalizedId = publicId.trim();

  // Safety guard: strictly refuse to modify or delete any Cloudinary asset outside japaika-ecom/
  if (!isSafeJapaikaEcomPublicId(normalizedId)) {
    return { deleted: false, reason: 'PROTECTED_EXTERNAL_ASSET' };
  }

  if (!hasCloudinaryCredentials()) {
    return { deleted: false, reason: 'MEDIA_STORAGE_NOT_CONFIGURED' };
  }

  try {
    const result = await cloudinary.uploader.destroy(normalizedId, {
      resource_type: 'image',
      invalidate: true,
    });
    return { deleted: result?.result === 'ok', reason: result?.result || 'UNKNOWN' };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[MediaService] Failed to delete Cloudinary asset (${normalizedId}):`, err.message);
    }
    return { deleted: false, reason: 'CLEANUP_ERROR' };
  }
}

const mediaService = {
  ALLOWED_CLOUDINARY_PREFIX,
  CLOUDINARY_FOLDERS,
  isSafeJapaikaEcomPublicId,
  uploadImageBuffer,
  deleteImageByPublicId,
};

export default mediaService;
