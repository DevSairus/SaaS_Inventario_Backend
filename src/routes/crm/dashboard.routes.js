// backend/src/routes/crm/dashboard.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/dashboard.controller');

router.get('/', ctrl.getDashboard);
router.get('/activity', ctrl.getActivityFeed);
router.get('/notifications', ctrl.getNotificationsSummary);

module.exports = router;