const multer = require('multer');

const storage = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error('Tipo de archivo no permitido: usa JPG, PNG o WEBP'), false);
  }
  cb(null, true);
};

const uploadBlogCover = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = uploadBlogCover;
