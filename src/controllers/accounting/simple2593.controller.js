// backend/src/controllers/accounting/simple2593.controller.js
// Formulario 2593 — Recibo electrónico del SIMPLE. Ver services/tax/simple2593.service.js.
const { SimpleReceipt } = require('../../models');
const { compute2593, GROUP_KEYS } = require('../../services/tax/simple2593.service');
const audit = require('../../utils/audit');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}: ${error.message}`);
  return res.status(500).json({ success: false, message });
};

const money = (v) => {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Solo los valores que el formulario deja digitar (el resto se calcula). */
function cleanInputs(body = {}) {
  const out = {};
  if (GROUP_KEYS.includes(String(body.default_group))) out.default_group = String(body.default_group);
  for (const key of ['c38', 'c40', 'c45', 'c50', 'c52', 'c68', 'prev_c48', 'prev_c57', 'prev_c65', 'prev_c75']) {
    const v = money(body[key]);
    if (v !== undefined) out[key] = v;
  }
  out.exterior = {};
  for (const g of GROUP_KEYS) {
    const v = money(body.exterior?.[g]);
    if (v !== undefined) out.exterior[g] = v;
  }
  out.municipalities = {};
  for (const [munId, m] of Object.entries(body.municipalities || {})) {
    const row = {};
    for (const key of ['c86', 'c89', 'c96', 'c98', 'c100', 'c106']) {
      const v = money(m?.[key]);
      if (v !== undefined) row[key] = v;
    }
    if (m?.rate_informed_by_taxpayer) row.rate_informed_by_taxpayer = true;
    out.municipalities[munId] = row;
  }
  return out;
}

const params = (src) => ({ year: Number(src.year), period: Number(src.period) });

async function load(req, { year, period }) {
  const receipt = await SimpleReceipt.findOne({ where: { tenant_id: req.tenant_id, year, period } });
  // Presentado: se muestra la foto guardada (lo que se copió a la DIAN), no
  // un recálculo que pudo cambiar con asientos posteriores.
  const data = receipt?.status === 'presentado' && receipt.result
    ? receipt.result
    : await compute2593(req.tenant_id, { year, period, inputs: receipt?.inputs || {} });
  return { receipt, data };
}

const receiptJson = (r) => (r ? {
  id: r.id, year: r.year, period: r.period, status: r.status, inputs: r.inputs,
  form_number: r.form_number, presented_at: r.presented_at, updated_at: r.updated_at,
} : null);

// GET /api/accounting/simple-2593?year=&period=
exports.get = async (req, res) => {
  try {
    const { receipt, data } = await load(req, params(req.query));
    const { SHEET1, SHEET2 } = require('../../services/tax/simple2593Layout');
    res.json({ success: true, data: { receipt: receiptJson(receipt), result: data, layout: { sheet1: SHEET1, sheet2: SHEET2 } } });
  } catch (error) {
    fail(res, error, 'Error calculando el formulario 2593');
  }
};

// GET /api/accounting/simple-2593/receipts?year=
exports.list = async (req, res) => {
  try {
    const rows = await SimpleReceipt.findAll({
      where: { tenant_id: req.tenant_id, year: Number(req.query.year) || new Date().getFullYear() },
      order: [['period', 'ASC']],
    });
    res.json({ success: true, data: rows.map(receiptJson) });
  } catch (error) {
    fail(res, error, 'Error listando los recibos 2593');
  }
};

// PUT /api/accounting/simple-2593 -- { year, period, inputs } (guarda borrador)
exports.save = async (req, res) => {
  try {
    const { year, period } = params(req.body);
    const inputs = cleanInputs(req.body.inputs);
    const result = await compute2593(req.tenant_id, { year, period, inputs }); // valida año/bimestre
    let receipt = await SimpleReceipt.findOne({ where: { tenant_id: req.tenant_id, year, period } });
    if (receipt?.status === 'presentado') {
      return res.status(400).json({ success: false, message: 'Este recibo ya está marcado como presentado. Reábrelo para cambiarlo.' });
    }
    if (receipt) await receipt.update({ inputs });
    else receipt = await SimpleReceipt.create({ tenant_id: req.tenant_id, year, period, inputs, created_by: req.user?.id || null });
    res.json({ success: true, data: { receipt: receiptJson(receipt), result } });
  } catch (error) {
    fail(res, error, 'Error guardando el formulario 2593');
  }
};

// POST /api/accounting/simple-2593/present -- { year, period, inputs?, form_number? }
// Guarda la foto de las casillas: de ahí salen los excedentes del bimestre siguiente.
exports.present = async (req, res) => {
  try {
    const { year, period } = params(req.body);
    let receipt = await SimpleReceipt.findOne({ where: { tenant_id: req.tenant_id, year, period } });
    if (receipt?.status === 'presentado') return res.status(400).json({ success: false, message: 'Este recibo ya está marcado como presentado.' });
    const inputs = req.body.inputs ? cleanInputs(req.body.inputs) : (receipt?.inputs || {});
    const result = await compute2593(req.tenant_id, { year, period, inputs });
    const values = {
      inputs, result, status: 'presentado',
      form_number: String(req.body.form_number || '').trim().slice(0, 40) || null,
      presented_at: new Date(), presented_by: req.user?.id || null,
    };
    if (receipt) await receipt.update(values);
    else receipt = await SimpleReceipt.create({ tenant_id: req.tenant_id, year, period, ...values, created_by: req.user?.id || null });
    await audit({
      tenant_id: req.tenant_id, user_id: req.user?.id, action: 'simple_2593.present', entity: 'SimpleReceipt', entity_id: receipt.id,
      changes: { year, period, form_number: values.form_number, total_to_pay: result.sheet1.total_to_pay },
    }).catch(() => {});
    res.json({ success: true, data: { receipt: receiptJson(receipt), result } });
  } catch (error) {
    fail(res, error, 'Error marcando el formulario 2593 como presentado');
  }
};

// POST /api/accounting/simple-2593/reopen -- { year, period }
exports.reopen = async (req, res) => {
  try {
    const { year, period } = params(req.body);
    const receipt = await SimpleReceipt.findOne({ where: { tenant_id: req.tenant_id, year, period } });
    if (!receipt || receipt.status !== 'presentado') return res.status(400).json({ success: false, message: 'Este recibo no está marcado como presentado.' });
    const next = await SimpleReceipt.findOne({ where: { tenant_id: req.tenant_id, year, period: period + 1, status: 'presentado' } });
    if (next) return res.status(400).json({ success: false, message: `El bimestre ${period + 1} ya está presentado y usa los excedentes de este. Reábrelo primero.` });
    await receipt.update({ status: 'borrador', result: null, presented_at: null, presented_by: null });
    await audit({
      tenant_id: req.tenant_id, user_id: req.user?.id, action: 'simple_2593.reopen', entity: 'SimpleReceipt', entity_id: receipt.id,
      changes: { year, period },
    }).catch(() => {});
    const { data } = await load(req, { year, period });
    res.json({ success: true, data: { receipt: receiptJson(receipt), result: data } });
  } catch (error) {
    fail(res, error, 'Error reabriendo el formulario 2593');
  }
};

// GET /api/accounting/simple-2593/export?year=&period= (Excel con las dos hojas)
exports.exportExcel = async (req, res) => {
  try {
    const { receipt, data } = await load(req, params(req.query));
    const { buildSimple2593Excel } = require('../../services/tax/simple2593Excel.service');
    const buffer = await buildSimple2593Excel(data, receipt);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="formulario_2593_${data.year}_bim${data.period}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    fail(res, error, 'Error exportando el formulario 2593');
  }
};
