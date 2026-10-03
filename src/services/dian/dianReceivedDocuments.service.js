// backend/src/services/dian/dianReceivedDocuments.service.js
//
// Excel de "Documentos" del portal DIAN → registro dian_received_documents.
//
// El archivo que genera la DIAN usa XML con prefijo de namespace, que
// ExcelJS no soporta: se lee con utils/xlsxLite.js.
//
// Columnas del reporte (32): Tipo de documento, CUFE/CUDE, Folio, Prefijo,
// Divisa, Forma de Pago, Medio de Pago, Fecha Emisión, Fecha Recepción, NIT
// Emisor, Nombre Emisor, NIT Receptor, Nombre Receptor, IVA, ICA, IC, INC,
// Timbre, INC Bolsas, IN Carbono, IN Combustibles, IC Datos, ICL, INPP, IBUA,
// ICUI, Rete IVA, Rete Renta, Rete ICA, Total, Estado, Grupo.

'use strict';

const { Op } = require('sequelize');

/* ── Lectura del xlsx: utils/xlsxLite.js ──────────────────────────── */

const { readXlsxRows } = require('../../utils/xlsxLite');

/* ── Normalización ────────────────────────────────────────────────── */

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Encabezado normalizado → campo. Los impuestos menos comunes van a other_taxes.
const COLUMN_MAP = {
  tipodedocumento: 'document_type',
  cufecude: 'cufe',
  cufe: 'cufe',
  folio: 'folio',
  prefijo: 'prefix',
  divisa: 'currency',
  formadepago: 'payment_form',
  mediodepago: 'payment_method',
  fechaemision: 'issue_date',
  fecharecepcion: 'reception_date',
  nitemisor: 'issuer_nit',
  nombreemisor: 'issuer_name',
  nitreceptor: 'receiver_nit',
  nombrereceptor: 'receiver_name',
  iva: 'iva',
  ica: 'ica',
  inc: 'inc',
  reteiva: 'rete_iva',
  reterenta: 'rete_renta',
  reteica: 'rete_ica',
  total: 'total',
  estado: 'dian_status',
  grupo: 'dian_group',
};
const OTHER_TAX_COLUMNS = {
  ic: 'IC', timbre: 'Timbre', incbolsas: 'INC Bolsas', incarbono: 'IN Carbono', incombustibles: 'IN Combustibles',
  icdatos: 'IC Datos', icl: 'ICL', inpp: 'INPP', ibua: 'IBUA', icui: 'ICUI',
};
const MONEY_FIELDS = ['iva', 'ica', 'inc', 'rete_iva', 'rete_renta', 'rete_ica', 'total'];

// "1.234.567,89" | "1,234,567.89" | "1234567.89" | 1234567.89 → número.
function parseMoney(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v).replace(/[^\d,.-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Serial de Excel | "dd-mm-yyyy" | "dd/mm/yyyy[ hh:mm[:ss]]" | "yyyy-mm-dd..." → { date: 'YYYY-MM-DD', datetime: Date }
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return { date: d.toISOString().slice(0, 10), datetime: d };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    const date = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return { date, datetime: new Date(Date.UTC(+y, +mo - 1, +d, +h + 5, +mi, +se)) }; // hora Colombia (UTC-5)
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
    return { date: `${y}-${mo}-${d}`, datetime: new Date(Date.UTC(+y, +mo - 1, +d, +h + 5, +mi, +se)) };
  }
  return null;
}

const cleanNit = (v) => String(v ?? '').replace(/[^0-9]/g, '');

/**
 * @returns {{ documents: Array<object>, ignored: number, headerMissing: string[] }}
 */
function parseDianExcel(buffer) {
  const rows = readXlsxRows(buffer);
  const headerIdx = rows.findIndex((r) => (r || []).some((c) => ['cufecude', 'cufe'].includes(norm(c))));
  if (headerIdx < 0) {
    const err = new Error('No se encontró la columna "CUFE/CUDE": verifica que sea el Excel de documentos descargado del portal DIAN');
    err.statusCode = 400;
    throw err;
  }
  const header = rows[headerIdx].map(norm);
  const required = ['cufecude', 'nitemisor', 'total'];
  const headerMissing = required.filter((k) => !header.includes(k) && !(k === 'cufecude' && header.includes('cufe')));

  const documents = [];
  let ignored = 0;
  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || row.every((c) => c === null || c === undefined || c === '')) continue;
    const doc = { other_taxes: {} };
    header.forEach((key, i) => {
      const value = row[i];
      if (COLUMN_MAP[key]) doc[COLUMN_MAP[key]] = value;
      else if (OTHER_TAX_COLUMNS[key]) {
        const n = parseMoney(value);
        if (n) doc.other_taxes[OTHER_TAX_COLUMNS[key]] = n;
      }
    });
    doc.cufe = String(doc.cufe || '').trim();
    if (!doc.cufe) { ignored += 1; continue; }

    for (const f of MONEY_FIELDS) doc[f] = parseMoney(doc[f]);
    const issue = parseDate(doc.issue_date);
    const reception = parseDate(doc.reception_date);
    doc.issue_date = issue?.date || null;
    doc.reception_date = reception?.datetime || null;
    doc.issuer_nit = cleanNit(doc.issuer_nit);
    doc.receiver_nit = cleanNit(doc.receiver_nit);
    for (const f of ['document_type', 'folio', 'prefix', 'currency', 'payment_form', 'payment_method', 'issuer_name', 'receiver_name', 'dian_status', 'dian_group']) {
      doc[f] = doc[f] === null || doc[f] === undefined ? null : String(doc[f]).trim() || null;
    }
    documents.push(doc);
  }
  return { documents, ignored, headerMissing };
}

/* ── Clasificación ────────────────────────────────────────────────── */

// Solo se registran documentos RECIBIDOS (los emitidos por el tenant son
// sus propias ventas/documentos soporte y ya viven en Pitbox). Si el reporte
// no trae "Grupo", se decide por el NIT receptor.
function isReceived(doc, tenantNit) {
  const g = norm(doc.dian_group);
  if (g) return g.startsWith('recibid');
  return tenantNit ? doc.receiver_nit === tenantNit : true;
}

// Facturas que se pueden cargar como compra. Notas crédito/débito y
// eventos (ApplicationResponse) se registran, pero no se cargan como compra.
function isInvoice(doc) {
  const t = norm(doc.document_type);
  return t.includes('factura') && !t.includes('nota');
}

function documentNumber(doc) {
  return `${doc.prefix || ''}${doc.folio || ''}`.trim();
}

/* ── Registro + conciliación ──────────────────────────────────────── */

/**
 * Busca la compra existente de cada documento: por CUFE (lo más fiable),
 * y si no, por NIT del proveedor + número de factura (con/sin prefijo y
 * con/sin guion) — compras cargadas a mano antes de tener CUFE.
 * @returns {Map<cufe, purchase>}
 */
async function findExistingPurchases(tenantId, docs) {
  const { Purchase, Supplier } = require('../../models');
  const byCufe = new Map();
  const cufes = docs.map((d) => d.cufe);
  if (cufes.length === 0) return byCufe;

  const withCufe = await Purchase.findAll({
    where: { tenant_id: tenantId, cufe: { [Op.in]: cufes } },
    attributes: ['id', 'cufe', 'purchase_number', 'supplier_id', 'status'],
  });
  for (const p of withCufe) byCufe.set(p.cufe, p);

  const remaining = docs.filter((d) => !byCufe.has(d.cufe) && d.folio);
  if (remaining.length === 0) return byCufe;

  const numbers = new Set();
  for (const d of remaining) {
    numbers.add(documentNumber(d));
    numbers.add(String(d.folio));
    if (d.prefix) numbers.add(`${d.prefix}-${d.folio}`);
  }
  const candidates = await Purchase.findAll({
    where: { tenant_id: tenantId, invoice_number: { [Op.in]: [...numbers] } },
    attributes: ['id', 'cufe', 'purchase_number', 'supplier_id', 'status', 'invoice_number'],
    include: [{ model: Supplier, as: 'supplier', attributes: ['tax_id'] }],
  });
  const normInv = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toUpperCase();
  for (const d of remaining) {
    const nit = cleanNit(d.issuer_nit).slice(0, 9);
    if (!nit) continue; // sin NIT del emisor no se puede asegurar que sea la misma factura
    const target = [documentNumber(d), String(d.folio)].map(normInv);
    const match = candidates.find((p) =>
      cleanNit(p.supplier?.tax_id).startsWith(nit) && target.includes(normInv(p.invoice_number))
    );
    if (match) byCufe.set(d.cufe, match);
  }
  return byCufe;
}

async function findSuppliers(tenantId, docs) {
  const { Supplier } = require('../../models');
  const nits = [...new Set(docs.map((d) => d.issuer_nit).filter(Boolean))];
  if (nits.length === 0) return new Map();
  const suppliers = await Supplier.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'tax_id'] });
  const map = new Map();
  for (const s of suppliers) {
    const n = cleanNit(s.tax_id);
    // tax_id puede venir con o sin DV: se compara por los 9 primeros dígitos
    // del NIT (o completo si es más corto, ej. cédulas).
    for (const nit of nits) if (n && (n === nit || n.slice(0, nit.length) === nit || nit.slice(0, n.length) === n)) map.set(nit, s.id);
  }
  return map;
}

/**
 * Registra (o actualiza) los documentos del Excel. Nunca duplica: la llave es
 * (tenant_id, cufe). En re-cargas solo se refrescan los datos que vienen de
 * la DIAN; status/purchase_id del usuario se conservan, salvo que la factura
 * aparezca ya cargada como compra (entonces pasa a 'loaded').
 */
async function importDocuments(tenant, buffer) {
  const { DianReceivedDocument } = require('../../models');
  const tenantNit = cleanNit(tenant.dian_config?.nit || tenant.tax_id).slice(0, 9);

  const { documents, ignored, headerMissing } = parseDianExcel(buffer);
  const received = documents.filter((d) => isReceived(d, tenantNit));
  const emitted = documents.length - received.length;
  const foreignReceiver = tenantNit
    ? received.filter((d) => d.receiver_nit && !d.receiver_nit.startsWith(tenantNit)).length
    : 0;

  // Deduplicar dentro del mismo archivo (por si la DIAN repite filas).
  const unique = [...new Map(received.map((d) => [d.cufe, d])).values()];

  const existing = await DianReceivedDocument.findAll({
    where: { tenant_id: tenant.id, cufe: { [Op.in]: unique.map((d) => d.cufe) } },
  });
  const existingByCufe = new Map(existing.map((e) => [e.cufe, e]));
  const purchasesByCufe = await findExistingPurchases(tenant.id, unique);
  const supplierByNit = await findSuppliers(tenant.id, unique);

  const summary = {
    total_rows: documents.length + ignored,
    received: unique.length,
    emitted_skipped: emitted,
    invalid_rows: ignored,
    new: 0,
    already_registered: 0,
    already_loaded: 0,
    newly_linked: 0,
    pending: 0,
    foreign_receiver: foreignReceiver,
    header_missing: headerMissing,
  };

  const now = new Date();
  for (const d of unique) {
    const purchase = purchasesByCufe.get(d.cufe);
    const supplier_id = supplierByNit.get(d.issuer_nit) || purchase?.supplier_id || null;
    const dianFields = {
      document_type: d.document_type, folio: d.folio, prefix: d.prefix, currency: d.currency,
      payment_form: d.payment_form, payment_method: d.payment_method, issue_date: d.issue_date,
      reception_date: d.reception_date, issuer_nit: d.issuer_nit, issuer_name: d.issuer_name,
      receiver_nit: d.receiver_nit, receiver_name: d.receiver_name, iva: d.iva, ica: d.ica, inc: d.inc,
      other_taxes: d.other_taxes, rete_iva: d.rete_iva, rete_renta: d.rete_renta, rete_ica: d.rete_ica,
      total: d.total, dian_status: d.dian_status, dian_group: d.dian_group,
    };

    const row = existingByCufe.get(d.cufe);
    if (row) {
      summary.already_registered += 1;
      const update = { ...dianFields, last_seen_at: now, times_seen: (row.times_seen || 1) + 1 };
      if (!row.supplier_id && supplier_id) update.supplier_id = supplier_id;
      if (purchase && !row.purchase_id) {
        update.purchase_id = purchase.id;
        update.status = 'loaded';
        summary.newly_linked += 1;
      }
      await row.update(update);
      const finalStatus = update.status || row.status;
      if (finalStatus === 'loaded') summary.already_loaded += 1;
      else if (finalStatus === 'pending') summary.pending += 1;
    } else {
      summary.new += 1;
      await DianReceivedDocument.create({
        tenant_id: tenant.id,
        cufe: d.cufe,
        ...dianFields,
        supplier_id,
        purchase_id: purchase?.id || null,
        status: purchase ? 'loaded' : 'pending',
        first_seen_at: now,
        last_seen_at: now,
      });
      if (purchase) { summary.already_loaded += 1; summary.newly_linked += 1; } else summary.pending += 1;
    }
  }

  return summary;
}

module.exports = {
  readXlsxRows,
  parseDianExcel,
  importDocuments,
  findExistingPurchases,
  isInvoice,
  documentNumber,
  cleanNit,
};
