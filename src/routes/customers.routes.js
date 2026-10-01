// backend/src/routes/customers.routes.js
const express = require('express');
const router  = express.Router();
const customersController = require('../controllers/sales/customers.controller');
const dianLookup          = require('../controllers/customers/dianLookup.controller');
const { getAvailableAdvancesForCustomer } = require('../controllers/finance/customerAdvances.controller');

// ── Consulta DIAN (GetAcquirer) con el certificado propio del tenant ────────
router.get('/dian-lookup/availability',          dianLookup.getAvailability);
router.get('/dian-lookup/:documentType/:number', dianLookup.lookup);

// ── Anticipos disponibles del cliente (selector al facturar) ────────────────
router.get('/:id/advances/available', getAvailableAdvancesForCustomer);

// ── CRUD de clientes ─────────────────────────────────────────────────────────
router.get('/',          customersController.getAll);
router.get('/search',    customersController.search);
router.get('/:id',       customersController.getById);
router.post('/',         customersController.create);
router.put('/:id',       customersController.update);
router.delete('/:id',    customersController.delete);

module.exports = router;