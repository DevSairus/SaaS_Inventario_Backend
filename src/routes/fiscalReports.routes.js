// backend/src/routes/fiscalReports.routes.js
//
// Informes fiscales sin contabilidad (declaración de renta en casos
// especiales). No exige el módulo contable: salen de los documentos.
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const fiscalReports = require('../services/tax/fiscalReports.service');

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// ?year=2025 o ?from=YYYY-MM-DD&to=YYYY-MM-DD (por defecto el año anterior,
// que es el que se declara).
function period(req) {
  const { from, to, year } = req.query;
  if (isDate(from) && isDate(to)) return from <= to ? { from, to } : null;
  const y = /^\d{4}$/.test(String(year || '')) ? Number(year) : new Date().getFullYear() - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

const handle = (fn) => async (req, res) => {
  const p = period(req);
  if (!p) return res.status(400).json({ success: false, message: 'Rango de fechas inválido' });
  try {
    res.json({ success: true, data: await fn(req.user.tenant_id, p) });
  } catch (error) {
    require('../config/logger').error('Error en informes fiscales:', error);
    res.status(500).json({ success: false, message: 'Error generando el informe' });
  }
};

router.get('/summary',    checkRole('admin', 'accountant', 'manager'), handle(fiscalReports.summary));
router.get('/daily-book', checkRole('admin', 'accountant', 'manager'), handle(fiscalReports.dailyBook));

module.exports = router;
