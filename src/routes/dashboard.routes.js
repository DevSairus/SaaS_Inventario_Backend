// backend/src/routes/dashboard.routes.js
const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');

router.use(authMiddleware);
router.use(tenantMiddleware);

// GET /api/dashboard/kpis - KPIs principales
router.get('/kpis', dashboardController.getKPIs);

// GET /api/dashboard/alerts - Alertas del sistema
router.get('/alerts', dashboardController.getAlerts);

// GET /api/dashboard/workshop - KPIs del taller
router.get('/workshop', dashboardController.getWorkshopKPIs);

module.exports = router;