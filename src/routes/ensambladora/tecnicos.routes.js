// backend/src/routes/ensambladora/tecnicos.routes.js
const express = require('express');
const { listar, vincular, desvincular, verificar } = require('../../controllers/ensambladora/tecnicos.controller');

const router = express.Router();

router.get('/', listar);
router.post('/', vincular);
router.post('/:documento/desvincular', desvincular);
router.get('/:documento', verificar);

module.exports = router;
