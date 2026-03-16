const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/commissionSettlements.controller');

router.get('/technicians',     ctrl.getTechnicians);            // todos los usuarios
router.get('/preview',         ctrl.preview);                   // preview mano de obra
router.get('/products-report', ctrl.productCommissionReport);   // informe (sin liquidar)
router.get('/products-preview',ctrl.productPreview);            // preview productos por usuario
router.get('/products',        ctrl.listProductSettlements);    // historial liquidaciones productos
router.get('/products/:id',    ctrl.getProductSettlementById);  // detalle liquidación producto
router.post('/products',       ctrl.createProductSettlement);   // liquidar productos
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post('/', ctrl.create);

module.exports = router;