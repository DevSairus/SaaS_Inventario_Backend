const express = require('express');
const router = express.Router();
const novedadesController = require('../../controllers/payroll/payrollNovedades.controller');

router.get('/', novedadesController.getNovedades);
router.post('/suggest', novedadesController.suggestNovedad);
router.post('/', novedadesController.createNovedad);
router.delete('/:id', novedadesController.deleteNovedad);

module.exports = router;