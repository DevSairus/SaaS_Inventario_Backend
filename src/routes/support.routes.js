// routes/support.routes.js
const express = require('express');
const router = express.Router();
const uploadSupport = require('../middleware/uploadSupport');
const faqController = require('../controllers/support/faq.controller');
const ticketsController = require('../controllers/support/tickets.controller');
const remoteSessionController = require('../controllers/support/remoteSession.controller');

// El middleware ya está aplicado en server.js (authMiddleware, tenantMiddleware)
// Todos los roles del tenant pueden acceder a soporte

// FAQ
router.get('/faq', faqController.getFaq);
router.post('/faq/:id/feedback', faqController.submitFeedback);

// Tickets — todos los roles pueden crear y ver tickets
router.post('/tickets', uploadSupport.array('attachments', 5), ticketsController.createTicket);
router.get('/tickets', ticketsController.listMyTickets);
router.get('/tickets/:id', ticketsController.getTicketDetail);
router.post('/tickets/:id/messages', uploadSupport.array('attachments', 5), ticketsController.addMessage);
router.put('/tickets/:id/rate', ticketsController.rateTicket);

// Remote support — todos los roles pueden recibir solicitudes remotas
router.get('/remote-sessions/pending', remoteSessionController.getPendingSessions);
router.put('/remote-sessions/:id/respond', remoteSessionController.respondToSession);
router.put('/remote-sessions/:id/end', remoteSessionController.endSession);

module.exports = router;
