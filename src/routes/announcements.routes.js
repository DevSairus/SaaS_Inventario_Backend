// routes/announcements.routes.js
const express = require('express');
const router = express.Router();
const announcementsController = require('../controllers/announcements.controller');

// El middleware ya está aplicado en server.js (authMiddleware)
// Aquí solo necesitamos el middleware de superadmin para las rutas protegidas

// Importar el middleware de superadmin si existe
// Si no existe, lo creamos inline
const isSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'super_admin') {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Acceso denegado. Solo superadmins pueden acceder a este recurso.'
  });
};

// ==========================================
// RUTAS PARA USUARIOS (autenticados)
// ==========================================

/**
 * GET /api/announcements/pending
 * Obtener anuncios pendientes para el usuario actual
 */
router.get('/pending', announcementsController.getPendingAnnouncements);

/**
 * POST /api/announcements/:announcementId/view
 * Marcar un anuncio como visto
 */
router.post('/:announcementId/view', announcementsController.markAsViewed);

/**
 * POST /api/announcements/:announcementId/dismiss
 * Descartar un anuncio
 */
router.post('/:announcementId/dismiss', announcementsController.dismissAnnouncement);

// ==========================================
// RUTAS PARA SUPERADMIN
// ==========================================

/**
 * GET /api/announcements
 * Obtener todos los anuncios (con paginación y filtros)
 */
router.get('/', isSuperAdmin, announcementsController.getAllAnnouncements);

/**
 * POST /api/announcements
 * Crear un nuevo anuncio
 */
router.post('/', isSuperAdmin, announcementsController.createAnnouncement);

/**
 * PUT /api/announcements/:id
 * Actualizar un anuncio
 */
router.put('/:id', isSuperAdmin, announcementsController.updateAnnouncement);

/**
 * DELETE /api/announcements/:id
 * Eliminar un anuncio
 */
router.delete('/:id', isSuperAdmin, announcementsController.deleteAnnouncement);

/**
 * GET /api/announcements/:id/stats
 * Obtener estadísticas de un anuncio
 */
router.get('/:id/stats', isSuperAdmin, announcementsController.getAnnouncementStats);

module.exports = router;