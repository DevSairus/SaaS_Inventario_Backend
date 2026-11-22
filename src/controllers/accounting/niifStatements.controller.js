// backend/src/controllers/accounting/niifStatements.controller.js
//
// Estados financieros NIIF para Pymes, notas y PDF. Ver
// services/accounting/niifStatements.service.js, niifNotes.service.js y
// niifPdf.service.js.

const svc = require('../../services/accounting/niifStatements.service');
const notesSvc = require('../../services/accounting/niifNotes.service');
const xls = require('../../services/accounting/niifExcel.service');
const { generateNiifPdf } = require('../../services/accounting/niifPdf.service');
const logger = require('../../config/logger');

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

function fail(res, error, message) {
  if (!error.statusCode) logger.error(`[NIIF] ${message}:`, error);
  if (res.headersSent) return;
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : message,
    error: process.env.NODE_ENV === 'production' ? undefined : error.message,
  });
}

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

// Las notas se piden con el mismo corte del estado, para numerar las
// referencias y llevar las firmas.
const notesFor = (req, asOf) => notesSvc.buildNotes(req.tenant_id, { as_of: asOf, compare_as_of: req.query.compare_as_of, from: req.query.from });

const REPORTS = {
  'financial-position': {
    fetch: (req) => svc.financialPosition(req.tenant_id, req.query),
    excel: xls.generateFinancialPositionExcel,
    pdf: async (req, data) => ({ esf: data, notes: await notesFor(req, data.as_of), includeNotes: false }),
    title: 'ESTADO DE SITUACIÓN FINANCIERA',
    filename: (d) => `Situacion-Financiera-${d.as_of}`,
    error: 'Error al generar el estado de situación financiera',
  },
  'comprehensive-income': {
    fetch: (req) => svc.comprehensiveIncome(req.tenant_id, req.query),
    excel: xls.generateComprehensiveIncomeExcel,
    pdf: async (req, data) => ({ eri: data, notes: await notesFor(req, data.to), includeNotes: false }),
    title: 'ESTADO DEL RESULTADO INTEGRAL',
    filename: (d) => `Resultado-Integral-${d.from}_${d.to}`,
    error: 'Error al generar el estado del resultado integral',
  },
  'equity-changes': {
    fetch: (req) => svc.equityChanges(req.tenant_id, req.query),
    excel: xls.generateEquityChangesExcel,
    pdf: async (req, data) => ({ ecp: data, notes: await notesFor(req, data.to), includeNotes: false }),
    title: 'ESTADO DE CAMBIOS EN EL PATRIMONIO',
    filename: (d) => `Cambios-Patrimonio-${d.from}_${d.to}`,
    error: 'Error al generar el estado de cambios en el patrimonio',
  },
  notes: {
    fetch: (req) => notesSvc.buildNotes(req.tenant_id, req.query),
    pdf: async (req, data) => ({ notes: data }),
    title: 'NOTAS A LOS ESTADOS FINANCIEROS',
    filename: (d) => `Notas-Estados-Financieros-${d.as_of}`,
    error: 'Error al generar las notas',
  },
};

// GET /api/accounting/reports/niif/:report
exports.report = async (req, res) => {
  const def = REPORTS[req.params.report];
  if (!def) return res.status(404).json({ success: false, message: 'Informe no encontrado' });
  try {
    res.json({ success: true, data: await def.fetch(req) });
  } catch (error) {
    fail(res, error, def.error);
  }
};

// GET /api/accounting/reports/niif/:report/export?format=excel|pdf
exports.export = async (req, res) => {
  const def = REPORTS[req.params.report];
  if (!def) return res.status(404).json({ success: false, message: 'Informe no encontrado' });
  try {
    const data = await def.fetch(req);
    if (req.query.format === 'pdf') {
      const parts = await def.pdf(req, data);
      const buffer = await generateNiifPdf(null, parts, req.tenant, generatedByName(req), { title: def.title, filename: def.filename(data) });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${def.filename(data)}.pdf"`);
      return res.send(buffer);
    }
    if (!def.excel) return res.status(400).json({ success: false, message: 'Este informe solo se exporta en PDF' });
    const buffer = await def.excel(data, req.tenant, generatedByName(req));
    sendXlsx(res, buffer, `${def.filename(data)}.xlsx`);
  } catch (error) {
    fail(res, error, def.error);
  }
};

// GET /api/accounting/reports/niif-package/pdf?as_of=&from=&compare_as_of=
// Juego completo: situación financiera, resultado integral, cambios en el
// patrimonio, flujos de efectivo y notas.
exports.packagePdf = async (req, res) => {
  try {
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    const from = req.query.from || `${asOf.slice(0, 4)}-01-01`;
    const branch_id = req.query.branch_id || undefined;
    const { fetchCashFlowIndirect } = require('./cashFlowIndirect.controller');
    const [esf, eri, ecp, cashflow, notes] = await Promise.all([
      svc.financialPosition(req.tenant_id, { as_of: asOf, compare_as_of: req.query.compare_as_of, branch_id }),
      svc.comprehensiveIncome(req.tenant_id, { from, to: asOf, branch_id }),
      svc.equityChanges(req.tenant_id, { from, to: asOf, branch_id }),
      fetchCashFlowIndirect({ tenant_id: req.tenant_id, query: { from, to: asOf, branch_id } }),
      notesSvc.buildNotes(req.tenant_id, { as_of: asOf, compare_as_of: req.query.compare_as_of, from }),
    ]);
    const filename = `Estados-Financieros-${asOf}`;
    const buffer = await generateNiifPdf(null, { esf, eri, ecp, cashflow, notes }, req.tenant, generatedByName(req), { title: 'ESTADOS FINANCIEROS', filename });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}.pdf"`);
    res.send(buffer);
  } catch (error) {
    fail(res, error, 'Error al generar los estados financieros en PDF');
  }
};

// PUT /api/accounting/reports/niif-notes/:year/:key  { mode: 'append'|'replace', body }
exports.saveNoteText = async (req, res) => {
  try {
    const data = await notesSvc.saveText(req.tenant_id, req.params.year, req.params.key, req.body || {}, req.user?.id);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al guardar la nota');
  }
};

// PUT /api/accounting/reports/niif-signatures/:year
exports.saveSignatures = async (req, res) => {
  try {
    const data = await notesSvc.saveSignatures(req.tenant_id, req.params.year, req.body || {}, req.user?.id);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al guardar las firmas');
  }
};
