// backend/src/routes/whatsapp.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/whatsapp.controller');
const { authMiddleware } = require('../middleware/auth');

router.get('/status',            ctrl.getStatus);
router.post('/connect',          ctrl.connect);
router.post('/disconnect',       ctrl.disconnect);
router.get('/test-cloudinary',   authMiddleware, ctrl.testCloudinary);

module.exports = router;