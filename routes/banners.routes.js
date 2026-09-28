// routes/banners.routes.js
// Hero Banner Slider — Public read + Admin CRUD backed by Cloudinary + Prisma
// Mounted at:
//   /api/banners      → public read (GET /api/banners)
//   /api/admin/banners → admin CRUD (GET, POST, PATCH /:id, DELETE /:id) with authenticateAdmin

const express = require('express');
const multer = require('multer');
const { uploadBuffer, deleteAsset, isConfigured } = require('../lib/cloudinary');

const router = express.Router();

// ── Multer in-memory for banner image upload ──────────────────────────────────
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
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter,
});
const handleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'File size exceeds 8MB.' });
      }
      return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.code || 'INVALID_FILE', message: err.message });
    }
    next();
  });
};

// ── PUBLIC GET /api/banners ────────────────────────────────────────────────────
// Customer-facing: active banners sorted by sortOrder then createdAt
router.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const banners = await prisma.heroBanner.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, imageUrl: true, altText: true, linkUrl: true, sortOrder: true, createdAt: true },
    });
    res.set('Cache-Control', 'no-store, max-age=0');
    return res.json({ banners });
  } catch (err) {
    console.error('[Banners GET Public] Error:', err.message);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to load banners.' });
  }
});

// ── ADMIN GET /api/admin/banners ──────────────────────────────────────────────
// Admin list (includes inactive banners)
router.get('/admin-list', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const banners = await prisma.heroBanner.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ banners });
  } catch (err) {
    console.error('[Banners GET Admin] Error:', err.message);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to load banners.' });
  }
});

// ── ADMIN POST /api/admin/banners/upload ──────────────────────────────────────
// Upload banner image to Cloudinary and persist record
router.post('/upload', handleUpload, async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No image file provided (field name: "file").' });
    }
    if (!isConfigured) {
      return res.status(500).json({ error: 'CONFIG_ERROR', message: 'Cloudinary is not configured on the server.' });
    }

    // Upload to sunbloom-adorn/banners folder in Cloudinary
    const uploadResult = await uploadBuffer(req.file.buffer, { folder: 'sunbloom-adorn/banners' });

    const { altText = '', linkUrl = '', sortOrder } = req.body || {};
    const parsedSort = parseInt(sortOrder, 10);
    const count = await prisma.heroBanner.count();
    const effectiveSortOrder = !isNaN(parsedSort) ? parsedSort : count;

    const banner = await prisma.heroBanner.create({
      data: {
        imageUrl: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        altText: altText ? String(altText).trim() : null,
        linkUrl: linkUrl ? String(linkUrl).trim() : null,
        sortOrder: effectiveSortOrder,
        isActive: true,
      },
    });
    return res.status(201).json({ success: true, banner });
  } catch (err) {
    console.error('[Banners POST Upload] Error:', err.message);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create banner.' });
  }
});

// ── ADMIN PATCH /api/admin/banners/:id ───────────────────────────────────────
// Update banner metadata fields
router.patch('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { altText, linkUrl, sortOrder, isActive } = req.body || {};
    const data = {};
    if (altText !== undefined) data.altText = altText ? String(altText).trim() : null;
    if (linkUrl !== undefined) data.linkUrl = linkUrl ? String(linkUrl).trim() : null;
    if (sortOrder !== undefined) data.sortOrder = parseInt(sortOrder, 10) || 0;
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const banner = await prisma.heroBanner.update({ where: { id: req.params.id }, data });
    return res.json({ success: true, banner });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'NOT_FOUND', message: 'Banner not found.' });
    console.error('[Banners PATCH] Error:', err.message);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update banner.' });
  }
});

// ── ADMIN DELETE /api/admin/banners/:id ──────────────────────────────────────
// Delete DB record and clean up Cloudinary asset
router.delete('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const banner = await prisma.heroBanner.findUnique({ where: { id: req.params.id } });
    if (!banner) return res.status(404).json({ error: 'NOT_FOUND', message: 'Banner not found.' });

    // Delete from DB first — non-reversible, so do it before Cloudinary
    await prisma.heroBanner.delete({ where: { id: req.params.id } });

    // Non-blocking Cloudinary cleanup, guarded to sunbloom-adorn/ namespace
    if (banner.publicId && banner.publicId.startsWith('sunbloom-adorn/') && isConfigured) {
      deleteAsset(banner.publicId).catch((delErr) => {
        console.warn('[Banners DELETE] Cloudinary cleanup note:', delErr.message);
      });
    }

    return res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('[Banners DELETE] Error:', err.message);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete banner.' });
  }
});

module.exports = router;
