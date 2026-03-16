const multer = require('multer');
const path = require('path');
const fs = require('fs');

const productDir = path.join(__dirname, '../../uploads/products');
if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, productDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'product-' + unique + path.extname(file.originalname).toLowerCase());
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  allowed.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Solo se aceptan imágenes (jpg, png, webp)'), false);
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 3 * 1024 * 1024 } });