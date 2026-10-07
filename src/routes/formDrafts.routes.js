const express = require('express');
const ctrl = require('../controllers/formDrafts.controller');

const router = express.Router();

// Borradores de formularios del propio usuario -- ver formDrafts.controller.js.
router.get('/', ctrl.getDraft);
router.put('/', ctrl.saveDraft);
router.delete('/', ctrl.deleteDraft);

module.exports = router;
