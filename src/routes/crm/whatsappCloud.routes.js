const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/whatsappCloud.controller');
const { uploadWhatsAppMedia } = require('../../middleware/uploadWhatsAppMedia');
// Los envíos salientes se limitan POR TENANT (40/min): Meta mide la calidad
// del número y el tier de 24h a nivel de phone_number_id, así que un bucle de
// reintentos o una automatización mal configurada puede degradar -- o hacer
// que Meta restrinja -- el número real del negocio. generalLimiter (por IP,
// compartido con toda la API) no cubre ese riesgo.
const { waSendLimiter } = require('../../middleware/rateLimiter');

router.get('/status', ctrl.getWhatsAppStatus);
router.post('/embedded-signup/complete', ctrl.completeEmbeddedSignup);
router.post('/connect-token', ctrl.connectWithToken);
router.put('/webhook-verify-token', ctrl.setWebhookVerifyToken);
router.post('/disconnect', ctrl.disconnect);
router.post('/demo-mode', ctrl.setDemoMode);
router.post('/demo/simulate-inbound', ctrl.simulateInbound);
router.post('/send-template', waSendLimiter, ctrl.sendTemplate);
router.post('/send-text', waSendLimiter, ctrl.sendText);

router.get('/workspace-prefs', ctrl.getWorkspacePrefs);
router.put('/workspace-prefs', ctrl.updateWorkspacePrefs);

// Inbox
router.get('/conversations', ctrl.listConversations);
router.get('/conversations/:id', ctrl.getConversation);
router.patch('/conversations/:id', ctrl.updateConversationMeta);
router.get('/conversations/:id/messages', ctrl.listMessages);
router.post('/conversations/:id/messages', waSendLimiter, ctrl.sendConversationText);
router.post(
  '/conversations/:id/media',
  waSendLimiter,
  (req, res, next) => {
    uploadWhatsAppMedia.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Archivo inválido' });
      }
      return next();
    });
  },
  ctrl.sendConversationMedia
);
router.post('/conversations/:id/read', ctrl.markRead);
router.post('/conversations/:id/assign', ctrl.assignConversation);
router.post('/conversations/:id/ai/suggest', ctrl.suggestReply);
router.post('/conversations/:id/ai/summarize', ctrl.summarizeConversation);

router.post('/templates/sync', ctrl.syncTemplates);
router.get('/templates', ctrl.listTemplates);
router.get('/reminders', ctrl.listReminders);
router.post('/reminders', ctrl.createReminder);
router.get('/campaigns', ctrl.listCampaigns);
router.post('/campaigns', ctrl.createCampaign);
router.post('/campaigns/:id/start', waSendLimiter, ctrl.startCampaign);

module.exports = router;
