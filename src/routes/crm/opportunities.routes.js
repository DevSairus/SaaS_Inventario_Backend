// backend/src/routes/crm/opportunities.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/opportunities.controller');
const { checkAccountOwnership } = require('../../middleware/checkAccountOwnership');

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post('/', checkAccountOwnership, ctrl.create);
router.patch('/:id', ctrl.update);
router.patch('/:id/stage', ctrl.changeStage);

module.exports = router;
