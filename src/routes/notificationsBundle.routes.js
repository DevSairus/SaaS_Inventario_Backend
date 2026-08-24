const express = require('express');
const router = express.Router();
const { getNotificationsBundle } = require('../controllers/notificationsBundle.controller');

// GET /api/notifications/summary — reemplaza los 6 pollers independientes
// que corrían en Layout.jsx (StockAlerts, PayableAlerts, AdvanceAlerts,
// CrmNotifications, QuoteNotificationsBell, AppointmentNotificationsBell).
router.get('/summary', getNotificationsBundle);

module.exports = router;
