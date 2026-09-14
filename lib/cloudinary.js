// lib/cloudinary.js
// Backend-only Cloudinary configuration and upload utilities for Sunbloom Adorn

const cloudinary = require('cloudinary').v2;

const isConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'ml_default';

/**
 * Upload an in-memory buffer to Cloudinary using the official SDK.
 * @param {Buffer} buffer - File buffer
 * @param {Object} options - Upload options (folder, public_id, etc.)
 * @returns {Promise<Object>} Safe Cloudinary upload result
 */
const uploadBuffer = (buffer, options = {}) => {
  if (!isConfigured) {
    return Promise.reject(new Error('Cloudinary is not configured on the backend.'));
  }

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || 'sunbloom-adorn/products',
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result);
      }
    );

    stream.end(buffer);
  });
};

/**
 * Delete an asset from Cloudinary by public ID.
 * Restricts deletion strictly to assets within the sunbloom-adorn prefix.
 * @param {string} publicId
 * @returns {Promise<Object>}
 */
const deleteAsset = async (publicId) => {
  if (!isConfigured) {
    throw new Error('Cloudinary is not configured on the backend.');
  }

  if (!publicId || typeof publicId !== 'string') {
    throw new Error('Valid public_id is required for deletion.');
  }

  // Security guard: Ensure only sunbloom-adorn assets can be deleted via this app
  if (!publicId.startsWith('sunbloom-adorn/')) {
    throw new Error('Unauthorized asset deletion. Asset does not belong to Sunbloom Adorn namespace.');
  }

  return cloudinary.uploader.destroy(publicId);
};

/**
 * Ping Cloudinary API to verify connectivity and credentials.
 */
const ping = () => {
  if (!isConfigured) {
    return Promise.reject(new Error('Cloudinary is not configured.'));
  }
  return cloudinary.api.ping();
};

module.exports = {
  cloudinary,
  isConfigured,
  UPLOAD_PRESET,
  uploadBuffer,
  deleteAsset,
  ping,
};
