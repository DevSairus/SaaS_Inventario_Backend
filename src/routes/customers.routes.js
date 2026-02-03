// backend/src/routes/customers.routes.js
const express = require('express');
const router = express.Router();
const customersController = require('../controllers/sales/customers.controller');


// CRUD de clientes
router.get('/', customersController.getAll);
router.get('/search', customersController.search);
router.get('/:id', customersController.getById);
router.post('/', customersController.create);
router.put('/:id', customersController.update);
router.delete('/:id', customersController.delete);

module.exports = router;