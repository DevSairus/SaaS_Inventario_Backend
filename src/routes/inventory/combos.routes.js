const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const ctrl = require('../../controllers/inventory/combos.controller');

// Leer: cualquier usuario del tenant (se usan desde factura/cotización/OT).
// Escribir: mismos roles que administran el catálogo.
const COMBO_WRITE_ROLES = ['admin', 'manager', 'super_admin'];

router.get('/',       ctrl.list);
router.get('/:id',    ctrl.getById);
router.post('/',      checkRole(...COMBO_WRITE_ROLES), ctrl.create);
router.put('/:id',    checkRole(...COMBO_WRITE_ROLES), ctrl.update);
router.delete('/:id', checkRole(...COMBO_WRITE_ROLES), ctrl.remove);

module.exports = router;
