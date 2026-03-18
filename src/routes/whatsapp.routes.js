// backend/src/routes/whatsapp.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/whatsapp.controller');
const { authMiddleware, checkRole } = require('../middleware/auth');

router.get('/status',            ctrl.getStatus);
router.post('/connect',          ctrl.connect);
router.post('/disconnect',       ctrl.disconnect);
router.get('/test-cloudinary',   authMiddleware, checkRole('admin', 'super_admin'), ctrl.testCloudinary);

module.exports = router;