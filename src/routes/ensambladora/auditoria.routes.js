// backend/src/routes/ensambladora/auditoria.routes.js
const express = require('express');
const { listar } = require('../../controllers/ensambladora/auditoria.controller');

const router = express.Router();

router.get('/', listar);

module.exports = router;
