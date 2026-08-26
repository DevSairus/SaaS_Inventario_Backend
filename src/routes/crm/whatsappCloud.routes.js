const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/whatsappCloud.controller');
const { uploadWhatsAppMedia } = require('../../middleware/uploadWhatsAppMedia');

router.get('/status', ctrl.getWhatsAppStatus);
router.post('/embedded-signup/complete', ctrl.completeEmbeddedSignup);
router.post('/disconnect', ctrl.disconnect);
router.post('/demo-mode', ctrl.setDemoMode);
router.post('/demo/simulate-inbound', ctrl.simulateInbound);
router.post('/send-template', ctrl.sendTemplate);
router.post('/send-text', ctrl.sendText);

router.get('/workspace-prefs', ctrl.getWorkspacePrefs);
router.put('/workspace-prefs', ctrl.updateWorkspacePrefs);

// Inbox
router.get('/conversations', ctrl.listConversations);
router.get('/conversations/:id', ctrl.getConversation);
router.patch('/conversations/:id', ctrl.updateConversationMeta);
router.get('/conversations/:id/messages', ctrl.listMessages);
router.post('/conversations/:id/messages', ctrl.sendConversationText);
router.post(
  '/conversations/:id/media',
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
router.post('/campaigns/:id/start', ctrl.startCampaign);

module.exports = router;
