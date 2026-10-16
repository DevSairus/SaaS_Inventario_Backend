// backend/src/routes/ensambladora/tecnicos.routes.js
const express = require('express');
const { listar, vincular, desvincular, verificar } = require('../../controllers/ensambladora/tecnicos.controller');

const { requireEnsMgmt } = require('./_roles');

const router = express.Router();

router.get('/', listar);
router.post('/', requireEnsMgmt, vincular);
router.post('/:documento/desvincular', requireEnsMgmt, desvincular);
router.get('/:documento', verificar);

module.exports = router;
