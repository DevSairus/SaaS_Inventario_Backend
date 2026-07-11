// backend/src/routes/ai/aiAssistant.routes.js
const express = require('express');
const router = express.Router();
const aiAssistantCtrl = require('../../controllers/ai/aiAssistant.controller');
const aiProposalsCtrl = require('../../controllers/ai/aiProposals.controller');
const { aiChatLimiter } = require('../../middleware/rateLimiter');

router.post('/chat', aiChatLimiter, aiAssistantCtrl.chat);
router.get('/conversations', aiAssistantCtrl.listConversations);
router.get('/conversations/:id', aiAssistantCtrl.getConversation);

// Fase 2 — propuestas de acción (requieren aprobación humana explícita,
// nunca se aprueban desde el chat).
router.get('/proposals', aiProposalsCtrl.listProposals);
router.get('/proposals/:id', aiProposalsCtrl.getProposal);
router.post('/proposals/:id/approve', aiProposalsCtrl.approveProposal);
router.post('/proposals/:id/reject', aiProposalsCtrl.rejectProposal);

module.exports = router;
