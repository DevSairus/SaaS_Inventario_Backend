const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/commissionSettlements.controller');

router.get('/technicians', ctrl.getTechnicians);       // todos los usuarios (filtrable por ?role=)
router.get('/preview', ctrl.preview);                  // preview liquidación mano de obra
router.get('/products-report', ctrl.productCommissionReport); // informe comisión por productos
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post('/', ctrl.create);

module.exports = router;