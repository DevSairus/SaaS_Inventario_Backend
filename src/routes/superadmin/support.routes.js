// routes/superadmin/support.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const uploadSupport = require('../../middleware/uploadSupport');
const faqController = require('../../controllers/superadmin/supportFaq.controller');
const ticketsController = require('../../controllers/superadmin/supportTickets.controller');
const statsController = require('../../controllers/superadmin/supportStats.controller');
const remoteSessionController = require('../../controllers/support/remoteSession.controller');

// El middleware ya está aplicado en server.js (authMiddleware).
// El rol `support` solo tiene acceso a este módulo dentro de SuperAdmin;
// `super_admin` conserva acceso total, incluido soporte.
router.use(checkRole('super_admin', 'support'));

// FAQ
router.get('/faq/categories', faqController.listCategories);
router.post('/faq/categories', faqController.createCategory);
router.put('/faq/categories/:id', faqController.updateCategory);
router.delete('/faq/categories/:id', faqController.deleteCategory);

router.post('/faq/articles', faqController.createArticle);
router.put('/faq/articles/:id', faqController.updateArticle);
router.delete('/faq/articles/:id', faqController.deleteArticle);

// Tickets
router.get('/tickets', ticketsController.listTickets);
router.get('/tickets/:id', ticketsController.getTicketDetail);
router.put('/tickets/:id', ticketsController.updateTicket);
router.post('/tickets/:id/messages', uploadSupport.array('attachments', 5), ticketsController.addMessage);

// Estadísticas
router.get('/stats', statsController.getStats);

// Remote support — agente solicita y gestiona sesiones
router.post('/tickets/:id/remote-session', remoteSessionController.createSession);
router.get('/remote-sessions', remoteSessionController.listSessions);
router.delete('/remote-sessions/:id', remoteSessionController.cancelSession);
router.put('/remote-sessions/:id/end', remoteSessionController.endSession);
router.get('/tenants/:tenant_id/users', remoteSessionController.getTenantUsers);

module.exports = router;
