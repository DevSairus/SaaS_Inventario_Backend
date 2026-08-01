// backend/src/routes/crm/followups.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/followups.controller');

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.patch('/:id/complete', ctrl.complete);
router.patch('/:id/cancel', ctrl.cancel);

module.exports = router;
