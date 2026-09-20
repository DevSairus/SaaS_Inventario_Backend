// backend/src/routes/crm/gamificationSettings.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/gamificationSettings.controller');
const { checkRole } = require('../../middleware/auth');

router.get('/', ctrl.get);
router.put('/', checkRole('admin', 'manager', 'super_admin'), ctrl.update);

module.exports = router;
