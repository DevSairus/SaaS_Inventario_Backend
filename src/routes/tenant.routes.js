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
const { getLabelPrinting, updateLabelPrinting } = require('../controllers/labelPrinting.controller');
const { checkRole } = require('../middleware/auth');

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
// Editar la configuración de la empresa (datos, logo, impuestos, IVA,
// porcentajes de negocio): solo Administrador y Gerente. Antes cualquier
// usuario autenticado podía guardar; los demás roles la ven en solo lectura.
const CONFIG_WRITE_ROLES = ['admin', 'manager', 'super_admin'];

router.put('/config', checkRole(...CONFIG_WRITE_ROLES), updateTenantConfig);

// Perfiles de impresión de etiquetas: leerlos cualquiera (para imprimir),
// editarlos solo gestión (labelPrinting.controller.js).
router.get('/label-printing', getLabelPrinting);
router.put('/label-printing', checkRole('admin', 'manager'), updateLabelPrinting);

// Subir logo
router.post('/logo', checkRole(...CONFIG_WRITE_ROLES), upload.single('logo'), uploadLogo);

// Eliminar logo
router.delete('/logo', checkRole(...CONFIG_WRITE_ROLES), deleteLogo);

module.exports = router;