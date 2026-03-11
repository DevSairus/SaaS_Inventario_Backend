// backend/src/routes/whatsapp.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/whatsapp.controller');

router.get('/status',     ctrl.getStatus);
router.post('/connect',   ctrl.connect);
router.post('/disconnect', ctrl.disconnect);

module.exports = router;