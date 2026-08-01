// backend/src/routes/crm/metaIntegration.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/metaIntegration.controller');

router.get('/status', ctrl.getStatus);
router.post('/connect/own', ctrl.startOwnConnection);
router.post('/connect/pitbox', ctrl.connectPitboxMode);
router.delete('/disconnect', ctrl.disconnect);

module.exports = router;
