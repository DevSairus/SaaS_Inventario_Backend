/* eslint-disable indent */
// routes/superadmin/support.routes.js
//
// Este archivo llegó a tener una copia casi completa de routes/superadmin.routes.js
// (gestión de tenants, planes, dashboard, permisos) pegada por error, montada
// además bajo /api/superadmin/support -- duplicando rutas que ya existían en
// /api/superadmin y dejando sin enrutar los controllers que sí fueron escritos
// para vivir acá (controllers/superadmin/supportTickets.controller.js,
// supportStats.controller.js -- sus propios
// comentarios ya documentaban las rutas exactas: GET /api/superadmin/support/tickets,
// etc). Este archivo vuelve a su propósito original: la bandeja de soporte que
// usa el superadmin para atender los tickets creados por los tenants
// (routes/support.routes.js del lado del tenant).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const { denyImpersonation } = require('../../middleware/denyImpersonation');
const { UUID, loadPlatformScope, restrictedTenantGuard } = require('../../middleware/platformScope');
const uploadSupport = require('../../middleware/uploadSupport');

const ticketsController = require('../../controllers/superadmin/supportTickets.controller');
const statsController = require('../../controllers/superadmin/supportStats.controller');
const remoteSessionController = require('../../controllers/support/remoteSession.controller');

// Mismo patrón que routes/superadmin.routes.js: nada de este router es
// alcanzable desde una sesión impersonada.
router.use(authMiddleware, denyImpersonation, loadPlatformScope);

// Bandeja de soporte: super_admin y support. Antes era checkPermission(
// 'superadmin.view_all' / 'manage_all'), que solo dejaba pasar a super_admin:
// esos permisos nunca se sembraron y RolePermission.role (ENUM) ni siquiera
// admite 'support', así que el rol support no podía usar su propio panel.
const requireSupportAccess = (req, res, next) => {
  if (!['super_admin', 'support'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'No tienes permisos para esta acción' });
  }
  next();
};

// Acceso restringido (middleware/platformScope.js): tickets, estadísticas y
// sesiones remotas se filtran por empresa en los controllers; acá se valida
// la empresa de la URL.
router.use(restrictedTenantGuard([
  { re: new RegExp(`^/tenants/(${UUID})/users$`), by: 'id' },
]));

// ============================================
// TICKETS -- bandeja del superadmin (todos los tenants)
// ============================================

router.get('/tickets', authMiddleware, requireSupportAccess, ticketsController.listTickets);
router.get('/tickets/:id', authMiddleware, requireSupportAccess, ticketsController.getTicketDetail);
router.put('/tickets/:id', authMiddleware, requireSupportAccess, ticketsController.updateTicket);
router.post(
  '/tickets/:id/messages',
  authMiddleware,
  requireSupportAccess,
  uploadSupport.array('attachments', 5),
  ticketsController.addMessage
);

// ============================================
// ACCESO REMOTO -- el agente pide la sesión desde el ticket; el cliente la
// acepta desde /api/support/remote-sessions (routes/support.routes.js).
// ============================================

router.post('/tickets/:id/remote-session', authMiddleware, requireSupportAccess, remoteSessionController.createSession);
router.get('/remote-sessions', authMiddleware, requireSupportAccess, remoteSessionController.listSessions);
router.delete('/remote-sessions/:id', authMiddleware, requireSupportAccess, remoteSessionController.cancelSession);
router.put('/remote-sessions/:id/end', authMiddleware, requireSupportAccess, remoteSessionController.endSession);
router.get('/tenants/:tenant_id/users', authMiddleware, requireSupportAccess, remoteSessionController.getTenantUsers);

// ============================================
// ESTADÍSTICAS DE SOPORTE
// ============================================

router.get('/stats', authMiddleware, requireSupportAccess, statsController.getStats);

module.exports = router;
