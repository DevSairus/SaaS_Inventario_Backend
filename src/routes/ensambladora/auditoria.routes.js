// backend/src/routes/ensambladora/auditoria.routes.js
const express = require('express');
const { listar } = require('../../controllers/ensambladora/auditoria.controller');

const { requireEnsMgmt } = require('./_roles');

const router = express.Router();

router.get('/', requireEnsMgmt, listar);

module.exports = router;
