const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/commissionSettlements.controller');

router.get('/technicians', ctrl.getTechnicians);
router.get('/preview', ctrl.preview);
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post('/', ctrl.create);

module.exports = router;