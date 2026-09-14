// routes/media.routes.js
// Admin Media Upload & Management Routes backed by Cloudinary

const express = require('express');
const multer = require('multer');
const { uploadBuffer, deleteAsset, isConfigured } = require('../lib/cloudinary');

const router = express.Router();

// Configure Multer for in-memory uploads with strict validations
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const allowedExtensions = /\.(jpg|jpeg|png|webp)$/i;

  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.test(file.originalname)) {
    cb(null, true);
  } else {
    const error = new Error('Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.');
    error.code = 'INVALID_FILE_TYPE';
    cb(error, false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
    files: 1,
  },
  fileFilter,
});

// Middleware to handle multer-specific errors cleanly
const handleUploadMiddleware = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: 'FILE_TOO_LARGE',
          message: 'File size exceeds maximum limit of 5MB.',
        });
      }
      return res.status(400).json({
        error: 'UPLOAD_ERROR',
        message: err.message,
      });
    } else if (err) {
      return res.status(400).json({
        error: err.code || 'INVALID_FILE',
        message: err.message,
      });
    }
    next();
  });
};

/**
 * POST /api/admin/media/upload
 * Authenticated Admin Image Upload
 */
router.post('/upload', handleUploadMiddleware, async (req, res) => {
  try {
    if (!isConfigured) {
      return res.status(500).json({
        error: 'CONFIG_ERROR',
        message: 'Cloudinary media service is not configured on the server.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'NO_FILE',
        message: 'No image file provided in request (field name: "file").',
      });
    }

    // Sanitize destination folder
    const requestedFolder = (req.body.folder || 'products').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const allowedFolders = ['products', 'categories', 'banners', 'misc'];
    const safeSubfolder = allowedFolders.includes(requestedFolder) ? requestedFolder : 'products';
    const folder = `sunbloom-adorn/${safeSubfolder}`;

    // Upload buffer to Cloudinary via backend SDK
    const result = await uploadBuffer(req.file.buffer, { folder });

    // Return only safe metadata - NEVER secrets
    return res.status(200).json({
      success: true,
      secure_url: result.secure_url,
      public_id: result.public_id,
      asset_id: result.asset_id,
      width: result.width,
      height: result.height,
      format: result.format,
      resource_type: result.resource_type,
    });
  } catch (error) {
    console.error('[Media Upload] Cloudinary upload error:', error.message);
    return res.status(500).json({
      error: 'UPLOAD_FAILED',
      message: 'Failed to upload image to media storage.',
    });
  }
});

/**
 * DELETE /api/admin/media
 * Authenticated Admin Image Deletion
 */
router.delete('/', async (req, res) => {
  try {
    const { public_id } = req.body;
    if (!public_id || typeof public_id !== 'string') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'A valid public_id is required in the request body.',
      });
    }

    const result = await deleteAsset(public_id);
    return res.status(200).json({
      success: true,
      result: result.result,
    });
  } catch (error) {
    console.error('[Media Delete] Cloudinary delete error:', error.message);
    return res.status(400).json({
      error: 'DELETE_FAILED',
      message: error.message || 'Failed to delete asset from media storage.',
    });
  }
});

module.exports = router;
