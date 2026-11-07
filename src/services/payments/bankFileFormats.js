// backend/src/services/payments/bankFileFormats.js
//
// Archivo plano de pagos masivos para el portal del banco. Dos tipos de
// formato:
//   - Predefinidos (PRESETS): Bancolombia, Davivienda, BBVA y Banco de Bogotá.
//     IMPORTANTE: se armaron con la estructura general de cada banco, NO con
//     su manual oficial. Antes de cargar un archivo real hay que validarlo con
//     el manual vigente del banco (longitudes, códigos de transacción, tipo de
//     documento) y probarlo en el portal con un pago pequeño.
//   - Plantillas propias de la empresa (bank_payment_templates): columnas
//     separadas por un delimitador, en el orden que pida su banco.
//
// Cada campo es { source, width?, align?, pad?, format?, value? }:
//   source: una clave de FIELD_SOURCES o 'const' (con value).

const { findBank, accountKind } = require('./colombianBanks');

const digits = (v) => String(v ?? '').replace(/\D+/g, '');
const ascii = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/[,;|\t]/g, ' ').trim();

// Datos que puede llevar el archivo (para la plantilla propia).
const FIELD_SOURCES = {
  company_tax_id: 'NIT de la empresa (sin DV)',
  company_dv: 'Dígito de verificación de la empresa',
  company_name: 'Nombre de la empresa',
  batch_date: 'Fecha de pago',
  batch_number: 'Número del lote',
  record_count: 'Cantidad de pagos',
  total_amount: 'Valor total',
  debit_account: 'Cuenta a debitar',
  debit_account_type: 'Tipo de cuenta a debitar',
  beneficiary_doc_type: 'Tipo de documento del proveedor',
  beneficiary_tax_id: 'Documento del proveedor',
  beneficiary_name: 'Nombre del proveedor',
  beneficiary_bank_code: 'Código del banco del proveedor',
  beneficiary_bank_name: 'Banco del proveedor',
  beneficiary_account: 'Cuenta del proveedor',
  beneficiary_account_type: 'Tipo de cuenta del proveedor',
  amount: 'Valor a pagar',
  reference: 'Referencia (documento pagado)',
  email: 'Correo del proveedor',
  sequence: 'Consecutivo de la línea',
};

// ── Formatos predefinidos (por validar con el manual del banco) ──────────
const PRESETS = {
  bancolombia_pab: {
    key: 'bancolombia_pab',
    label: 'Bancolombia · Pagos a proveedores (PAB, ancho fijo)',
    bank: 'Bancolombia',
    format: 'fixed',
    extension: 'txt',
    account_type_codes: { savings: '37', checking: '27' },
    debit_account_type_codes: { savings: 'S', checking: 'D' },
    doc_type_codes: { '13': '1', '22': '2', '31': '3', '12': '4', '41': '5', default: '1' },
    header: [
      { source: 'const', value: '1', width: 1 },
      { source: 'company_tax_id', width: 15, align: 'right', pad: '0' },
      { source: 'company_name', width: 16, format: 'upper' },
      { source: 'const', value: '220', width: 3 },
      { source: 'const', value: 'PAGOS PROV', width: 10 },
      { source: 'batch_date', width: 8, format: 'yyyymmdd' },
      { source: 'const', value: 'A', width: 2 },
      { source: 'batch_date', width: 8, format: 'yyyymmdd' },
      { source: 'record_count', width: 6, align: 'right', pad: '0' },
      { source: 'const', value: '0', width: 17, align: 'right', pad: '0' },
      { source: 'total_amount', width: 17, align: 'right', pad: '0', format: 'cents' },
      { source: 'debit_account', width: 11, align: 'right', pad: '0' },
      { source: 'debit_account_type', width: 1 },
    ],
    detail: [
      { source: 'const', value: '6', width: 1 },
      { source: 'beneficiary_tax_id', width: 15, align: 'left' },
      { source: 'beneficiary_name', width: 30, format: 'upper' },
      { source: 'beneficiary_bank_code', width: 9, align: 'right', pad: '0' },
      { source: 'beneficiary_account', width: 17, align: 'left' },
      { source: 'const', value: ' ', width: 1 },
      { source: 'beneficiary_account_type', width: 2 },
      { source: 'amount', width: 17, align: 'right', pad: '0', format: 'cents' },
      { source: 'batch_date', width: 8, format: 'yyyymmdd' },
      { source: 'reference', width: 21, format: 'upper' },
      { source: 'beneficiary_doc_type', width: 1 },
      { source: 'const', value: '', width: 5 },
      { source: 'const', value: '', width: 15 },
      { source: 'email', width: 80 },
      { source: 'const', value: '', width: 15 },
      { source: 'const', value: '', width: 27 },
    ],
  },
  davivienda: {
    key: 'davivienda',
    label: 'Davivienda · Pagos a terceros (ancho fijo)',
    bank: 'Davivienda',
    format: 'fixed',
    extension: 'txt',
    account_type_codes: { savings: 'CA', checking: 'CC' },
    debit_account_type_codes: { savings: 'CA', checking: 'CC' },
    doc_type_codes: { '13': '01', '22': '02', '31': '03', '41': '05', default: '01' },
    header: [
      { source: 'const', value: 'RC', width: 2 },
      { source: 'company_tax_id', width: 16, align: 'right', pad: '0' },
      { source: 'const', value: 'PROV', width: 4 },
      { source: 'debit_account', width: 16, align: 'right', pad: '0' },
      { source: 'debit_account_type', width: 2 },
      { source: 'const', value: '000051', width: 6 },
      { source: 'total_amount', width: 18, align: 'right', pad: '0', format: 'cents' },
      { source: 'record_count', width: 6, align: 'right', pad: '0' },
      { source: 'batch_date', width: 8, format: 'yyyymmdd' },
    ],
    detail: [
      { source: 'const', value: 'TR', width: 2 },
      { source: 'beneficiary_tax_id', width: 16, align: 'right', pad: '0' },
      { source: 'reference', width: 16 },
      { source: 'beneficiary_account', width: 16, align: 'right', pad: '0' },
      { source: 'beneficiary_account_type', width: 2 },
      { source: 'beneficiary_bank_code', width: 6, align: 'right', pad: '0' },
      { source: 'amount', width: 18, align: 'right', pad: '0', format: 'cents' },
      { source: 'beneficiary_doc_type', width: 2 },
      { source: 'beneficiary_name', width: 40, format: 'upper' },
    ],
  },
  bbva: {
    key: 'bbva',
    label: 'BBVA · Net Cash pagos a proveedores (separado por comas)',
    bank: 'BBVA Colombia',
    format: 'delimited',
    delimiter: ',',
    extension: 'csv',
    include_header: false,
    account_type_codes: { savings: '02', checking: '01' },
    doc_type_codes: { '13': '1', '22': '2', '31': '3', '41': '4', default: '1' },
    detail: [
      { source: 'beneficiary_doc_type' },
      { source: 'beneficiary_tax_id' },
      { source: 'beneficiary_name', format: 'upper' },
      { source: 'beneficiary_bank_code' },
      { source: 'beneficiary_account_type' },
      { source: 'beneficiary_account' },
      { source: 'amount', format: 'decimal_dot' },
      { source: 'reference' },
      { source: 'email' },
    ],
  },
  bogota: {
    key: 'bogota',
    label: 'Banco de Bogotá · Pagos masivos (separado por punto y coma)',
    bank: 'Banco de Bogotá',
    format: 'delimited',
    delimiter: ';',
    extension: 'txt',
    include_header: false,
    account_type_codes: { savings: 'AH', checking: 'CC' },
    doc_type_codes: { '13': 'C', '22': 'E', '31': 'N', '41': 'P', default: 'C' },
    detail: [
      { source: 'beneficiary_doc_type' },
      { source: 'beneficiary_tax_id' },
      { source: 'beneficiary_name', format: 'upper' },
      { source: 'beneficiary_bank_code' },
      { source: 'beneficiary_account_type' },
      { source: 'beneficiary_account' },
      { source: 'amount', format: 'decimal_dot' },
      { source: 'batch_date', format: 'ddmmyyyy' },
      { source: 'reference' },
    ],
  },
};

const pad = (value, field) => {
  const width = field.width;
  let s = String(value ?? '');
  if (!width) return s;
  if (s.length > width) s = field.align === 'right' ? s.slice(-width) : s.slice(0, width);
  const fill = field.pad || ' ';
  return field.align === 'right' ? s.padStart(width, fill) : s.padEnd(width, fill);
};

function formatValue(raw, field, tpl) {
  let v = raw;
  switch (field.format) {
    case 'cents': v = String(Math.round((Number(raw) || 0) * 100)); break;
    case 'integer': v = String(Math.round(Number(raw) || 0)); break;
    case 'decimal_dot': v = (Number(raw) || 0).toFixed(2); break;
    case 'decimal_comma': v = (Number(raw) || 0).toFixed(2).replace('.', ','); break;
    case 'yyyymmdd': v = String(raw).slice(0, 10).replace(/-/g, ''); break;
    case 'ddmmyyyy': { const [y, m, d] = String(raw).slice(0, 10).split('-'); v = `${d}${m}${y}`; break; }
    case 'dd/mm/yyyy': { const [y, m, d] = String(raw).slice(0, 10).split('-'); v = `${d}/${m}/${y}`; break; }
    case 'upper': v = ascii(raw).toUpperCase(); break;
    default: v = typeof raw === 'number' ? String(raw) : ascii(raw);
  }
  if (tpl.format === 'delimited' && tpl.delimiter) v = String(v).split(tpl.delimiter).join(' ');
  return v;
}

function renderLine(fields, ctx, tpl) {
  const parts = fields.map((f) => {
    const raw = f.source === 'const' ? (f.value ?? '') : ctx[f.source];
    const value = formatValue(raw ?? '', f, tpl);
    return tpl.format === 'fixed' ? pad(value, f) : value;
  });
  return tpl.format === 'fixed' ? parts.join('') : parts.join(tpl.delimiter || ',');
}

/** Plantilla propia (bank_payment_templates) → mismo formato que un preset. */
function fromCustomTemplate(row) {
  return {
    key: `custom:${row.id}`,
    label: row.name,
    bank: row.bank_name || null,
    format: 'delimited',
    delimiter: row.delimiter || ',',
    extension: row.extension || 'csv',
    include_header: row.include_header !== false,
    account_type_codes: { savings: row.savings_code || 'Ahorros', checking: row.checking_code || 'Corriente' },
    doc_type_codes: { default: '' },
    raw_doc_type: true,
    detail: (row.columns || []).map((c) => ({ source: c.source, value: c.value, format: c.format, label: c.label })),
    header_labels: (row.columns || []).map((c) => c.label || FIELD_SOURCES[c.source] || c.source),
  };
}

const DOC_TYPE_DEFAULTS = { nit: '31', cc: '13' };

/**
 * Genera el archivo. Devuelve { content, filename, problems } -- problems:
 * líneas que no se pueden pagar por archivo (proveedor sin cuenta, banco
 * desconocido...). Si hay problemas no se genera nada.
 */
function buildBankFile(tpl, { company, batch, items }) {
  const problems = [];
  const lines = items.map((it, idx) => {
    const bank = findBank(it.bank_name);
    const kind = accountKind(it.account_type);
    const account = digits(it.account_number);
    const missing = [];
    if (!digits(it.tax_id)) missing.push('documento');
    if (!bank) missing.push('banco');
    if (!kind) missing.push('tipo de cuenta');
    if (!account) missing.push('número de cuenta');
    if (missing.length) problems.push({ reference: it.reference, beneficiary: it.name, missing });
    const docType = it.doc_type || (digits(it.tax_id).length >= 9 && /^[89]/.test(digits(it.tax_id)) ? DOC_TYPE_DEFAULTS.nit : DOC_TYPE_DEFAULTS.cc);
    return {
      beneficiary_doc_type: tpl.raw_doc_type ? docType : (tpl.doc_type_codes?.[docType] ?? tpl.doc_type_codes?.default ?? docType),
      beneficiary_tax_id: digits(String(it.tax_id || '').split('-')[0]),
      beneficiary_name: it.name,
      beneficiary_bank_code: bank?.code || '',
      beneficiary_bank_name: bank?.name || it.bank_name || '',
      beneficiary_account: account,
      beneficiary_account_type: kind ? (tpl.account_type_codes?.[kind] ?? kind) : '',
      amount: Number(it.amount) || 0,
      reference: it.reference,
      email: it.email || '',
      sequence: idx + 1,
    };
  });
  if (problems.length) return { content: null, filename: null, problems };

  const debitKind = accountKind(batch.debit_account_type) || 'savings';
  const ctx = {
    company_tax_id: digits(String(company.tax_id || '').split('-')[0]),
    company_dv: String(company.tax_id || '').split('-')[1] || company.dv || '',
    company_name: company.name,
    batch_date: batch.payment_date,
    batch_number: batch.batch_number,
    record_count: lines.length,
    total_amount: lines.reduce((s, l) => s + l.amount, 0),
    debit_account: digits(batch.debit_account),
    debit_account_type: tpl.debit_account_type_codes?.[debitKind] ?? debitKind,
  };
  const out = [];
  if (tpl.header) out.push(renderLine(tpl.header, ctx, tpl));
  if (tpl.format === 'delimited' && tpl.include_header) {
    out.push((tpl.header_labels || tpl.detail.map((f) => FIELD_SOURCES[f.source] || f.source)).join(tpl.delimiter || ','));
  }
  for (const l of lines) out.push(renderLine(tpl.detail, { ...ctx, ...l }, tpl));
  if (tpl.footer) out.push(renderLine(tpl.footer, ctx, tpl));
  return {
    content: `${out.join('\r\n')}\r\n`,
    filename: `${batch.batch_number}-${(tpl.bank || 'banco').replace(/[^A-Za-z0-9]+/g, '')}.${tpl.extension || 'txt'}`,
    problems: [],
  };
}

module.exports = { PRESETS, FIELD_SOURCES, buildBankFile, fromCustomTemplate };
