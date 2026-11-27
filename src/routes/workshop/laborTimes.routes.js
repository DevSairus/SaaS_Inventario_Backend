// backend/src/routes/workshop/laborTimes.routes.js
// /api/workshop/labor-times — tempario y productividad de técnicos.
const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const uploadExcel = require('../../middleware/uploadProductsExcel');
const { keepTenantContext } = require('../../middleware/keepTenantContext');
const ctrl = require('../../controllers/workshop/laborTimes.controller');

const MANAGE = ['admin', 'manager', 'super_admin'];

// Tempario: consulta abierta (taller y ventas lo usan); cambios solo gerencia.
router.get('/settings', ctrl.getSettings);
router.put('/settings', checkRole(...MANAGE), ctrl.saveSettings);
router.get('/services', ctrl.listServices);
router.put('/services/:id', checkRole(...MANAGE), ctrl.updateService);
router.get('/import/template', ctrl.template);
router.get('/export', checkRole(...MANAGE), ctrl.exportServices);
router.post('/import', checkRole(...MANAGE), keepTenantContext(uploadExcel.single('archivo')), ctrl.importServices);

// Productividad, jornadas y ausencias: gerencia.
router.get('/schedules', checkRole(...MANAGE), ctrl.listSchedules);
router.put('/schedules/:userId', checkRole(...MANAGE), ctrl.saveSchedule);
router.get('/absences', checkRole(...MANAGE), ctrl.listAbsences);
router.post('/absences', checkRole(...MANAGE), ctrl.createAbsence);
router.delete('/absences/:id', checkRole(...MANAGE), ctrl.deleteAbsence);
router.get('/productivity', checkRole(...MANAGE), ctrl.productivity);
router.get('/productivity/:userId', checkRole(...MANAGE), ctrl.productivityDetail);

module.exports = router;
