// backend/src/routes/approvals.routes.js
// Aprobaciones. Base: /api/approvals (ver controllers/approvals.controller.js)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/approvals.controller');
const { requirePermission } = require('../middleware/requirePermission');

const configure = requirePermission('approvals.configure');

router.get('/inbox', ctrl.inbox);
router.get('/count', ctrl.count);
router.get('/document/:type/:id', ctrl.forDocument);
router.post('/requests/:id/decision', ctrl.decide);

router.get('/rules', configure, ctrl.listRules);
router.post('/rules', configure, ctrl.createRule);
router.put('/rules/:id', configure, ctrl.updateRule);
router.delete('/rules/:id', configure, ctrl.deleteRule);

module.exports = router;
