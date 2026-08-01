// backend/src/routes/crm/tags.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/tags.controller');

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.post('/assign', ctrl.assignToCustomer);
router.delete('/:customer_id/:customer_tag_id', ctrl.removeFromCustomer);

module.exports = router;
