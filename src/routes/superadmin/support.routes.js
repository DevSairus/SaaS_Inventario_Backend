/* eslint-disable indent */
// routes/superadmin/support.routes.js
//
// Este archivo llegó a tener una copia casi completa de routes/superadmin.routes.js
// (gestión de tenants, planes, dashboard, permisos) pegada por error, montada
// además bajo /api/superadmin/support -- duplicando rutas que ya existían en
// /api/superadmin y dejando sin enrutar los controllers que sí fueron escritos
// para vivir acá (controllers/superadmin/supportTickets.controller.js,
// supportStats.controller.js, supportFaq.controller.js -- sus propios
// comentarios ya documentaban las rutas exactas: GET /api/superadmin/support/tickets,
// etc). Este archivo vuelve a su propósito original: la bandeja de soporte que
// usa el superadmin para atender los tickets creados por los tenants
// (routes/support.routes.js del lado del tenant).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/checkPermission');
const { denyImpersonation } = require('../../middleware/denyImpersonation');
const uploadSupport = require('../../middleware/uploadSupport');

const ticketsController = require('../../controllers/superadmin/supportTickets.controller');
const statsController = require('../../controllers/superadmin/supportStats.controller');
const faqController = require('../../controllers/superadmin/supportFaq.controller');

// Mismo patrón que routes/superadmin.routes.js: nada de este router es
// alcanzable desde una sesión impersonada.
router.use(authMiddleware, denyImpersonation);

// ============================================
// TICKETS -- bandeja del superadmin (todos los tenants)
// ============================================

router.get('/tickets', authMiddleware, checkPermission('superadmin.view_all'), ticketsController.listTickets);
router.get('/tickets/:id', authMiddleware, checkPermission('superadmin.view_all'), ticketsController.getTicketDetail);
router.put('/tickets/:id', authMiddleware, checkPermission('superadmin.manage_all'), ticketsController.updateTicket);
router.post(
  '/tickets/:id/messages',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  uploadSupport.array('attachments', 5),
  ticketsController.addMessage
);

// ============================================
// ESTADÍSTICAS DE SOPORTE
// ============================================

router.get('/stats', authMiddleware, checkPermission('superadmin.view_all'), statsController.getStats);

// ============================================
// FAQ -- administración del contenido que ven los tenants
// ============================================

router.get('/faq/categories', authMiddleware, checkPermission('superadmin.view_all'), faqController.listCategories);
router.post('/faq/categories', authMiddleware, checkPermission('superadmin.manage_all'), faqController.createCategory);
router.put('/faq/categories/:id', authMiddleware, checkPermission('superadmin.manage_all'), faqController.updateCategory);
router.delete('/faq/categories/:id', authMiddleware, checkPermission('superadmin.manage_all'), faqController.deleteCategory);

router.post('/faq/articles', authMiddleware, checkPermission('superadmin.manage_all'), faqController.createArticle);
router.put('/faq/articles/:id', authMiddleware, checkPermission('superadmin.manage_all'), faqController.updateArticle);
router.delete('/faq/articles/:id', authMiddleware, checkPermission('superadmin.manage_all'), faqController.deleteArticle);

module.exports = router;
