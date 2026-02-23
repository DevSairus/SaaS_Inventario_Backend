const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/vehicles.controller');

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.get('/:id/history', ctrl.getHistory);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);

module.exports = router;