const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/workshopAppointments.controller');
const { checkRole } = require('../../middleware/auth');

// Configuración de horarios/capacidad -- solo admin/manager, mismo criterio
// que las rutas de accounting (App.jsx: roles={['admin','manager']}). El
// resto de la agenda (ver/confirmar/cancelar citas) queda abierto a
// cualquier usuario con acceso al módulo Taller.
router.get('/config', checkRole('admin', 'manager'), ctrl.getConfig);
router.put('/config', checkRole('admin', 'manager'), ctrl.updateConfig);

router.get('/pending', ctrl.getPending);
router.get('/', ctrl.list);
router.post('/', ctrl.createStaffAppointment);

router.patch('/:id/confirm', ctrl.confirmAppointment);
router.patch('/:id/cancel', ctrl.cancelAppointment);
router.post('/:id/send-whatsapp', ctrl.sendAppointmentWhatsApp);
router.post('/:id/convert-to-work-order', ctrl.convertToWorkOrder);

module.exports = router;
