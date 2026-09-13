const express = require('express');
const router = express.Router();
const conceptsController = require('../../controllers/payroll/payrollConcepts.controller');

router.get('/', conceptsController.getPayrollConcepts);
router.get('/:id', conceptsController.getPayrollConceptById);
router.post('/', conceptsController.createPayrollConcept);
router.put('/:id', conceptsController.updatePayrollConcept);
router.patch('/:id/deactivate', conceptsController.deactivatePayrollConcept);
router.patch('/:id/activate', conceptsController.activatePayrollConcept);
router.delete('/:id', conceptsController.deletePayrollConcept);

module.exports = router;
