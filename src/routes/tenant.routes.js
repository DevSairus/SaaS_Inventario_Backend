// backend/src/routes/tenant.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  getTenantConfig,
  updateTenantConfig,
  uploadLogo,
  deleteLogo
} = require('../controllers/tenant.controller');

// Configurar multer para subida de imágenes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo se permiten imágenes JPG, PNG o WEBP'));
    }
  }
});

// Rutas (autenticación y tenant aplicados en server.js)

// Obtener configuración del tenant
router.get('/config', getTenantConfig);

// Actualizar configuración del tenant
router.put('/config', updateTenantConfig);

// Subir logo
router.post('/logo', upload.single('logo'), uploadLogo);

// Eliminar logo
router.delete('/logo', deleteLogo);

module.exports = router;