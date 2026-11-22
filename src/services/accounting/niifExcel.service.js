// backend/src/services/accounting/niifExcel.service.js
//
// Excel de los estados financieros NIIF (niifStatements.service.js):
// situación financiera, resultado integral y cambios en el patrimonio.
// Mismo estilo que reportsExcel.service.js.

const ExcelJS = require('exceljs');

const RED = 'FF8B0000';
const DARK = 'FF374151';
const GRAY = 'FF6B7280';
const LIGHT = 'FFF3F4F6';
const WHITE = 'FFFFFFFF';
const MONEY = '#,##0.00;[Red]-#,##0.00';

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

function header(sheet, { title, tenant, subtitle, generatedByName, cols }) {
  const last = String.fromCharCode(64 + cols);
  const lines = [
    [`${title} — ${tenant?.company_name || ''}`, { bold: true, size: 14, color: { argb: RED } }],
    [tenant?.tax_id ? `NIT: ${tenant.tax_id}` : '', { size: 9, color: { argb: GRAY } }],
    [subtitle, { size: 10, color: { argb: DARK } }],
    [`Marco técnico: NIIF para Pymes (Grupo 2). Generado: ${new Date().toLocaleString('es-CO')}${generatedByName ? ' · ' + generatedByName : ''}`, { size: 9, italic: true, color: { argb: GRAY } }],
  ];
  lines.forEach(([text, font], i) => {
    sheet.mergeCells(`A${i + 1}:${last}${i + 1}`);
    const c = sheet.getCell(`A${i + 1}`);
    c.value = text;
    c.font = font;
  });
  sheet.addRow([]);
}

function headRow(sheet, values) {
  const row = sheet.addRow(values);
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
  });
  return row;
}

function boldRow(row, fill = true) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
  });
}

function money(row, fromCol) {
  row.eachCell((cell, col) => { if (col >= fromCol) cell.numFmt = MONEY; });
}

async function generateFinancialPositionExcel(data, tenant, generatedByName) {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet('Situación financiera');
  sh.columns = [{ width: 12 }, { width: 55 }, { width: 20 }, { width: 20 }];
  header(sh, { title: 'Estado de situación financiera', tenant, subtitle: `Al ${fmtDate(data.as_of)} comparado con ${fmtDate(data.compare_as_of)}`, generatedByName, cols: 4 });
  headRow(sh, ['Cuenta', 'Concepto', fmtDate(data.as_of), fmtDate(data.compare_as_of)]);

  const groupTotals = { activo: 'TOTAL ACTIVO', pasivo: 'TOTAL PASIVO', patrimonio: 'TOTAL PATRIMONIO' };
  let lastGroup = null;
  const flushGroup = (g) => {
    const r = sh.addRow(['', groupTotals[g], data.totals.current[g], data.totals.prior[g]]);
    boldRow(r); money(r, 3);
    sh.addRow([]);
  };
  for (const sec of data.sections) {
    if (lastGroup && lastGroup !== sec.group) flushGroup(lastGroup);
    lastGroup = sec.group;
    const sr = sh.addRow(['', sec.label.toUpperCase()]);
    sr.font = { bold: true, color: { argb: RED } };
    for (const rb of sec.rubros) {
      const rr = sh.addRow(['', rb.label, rb.current, rb.prior]);
      rr.font = { bold: true }; money(rr, 3);
      for (const a of rb.accounts) {
        const ar = sh.addRow([a.code, `    ${a.name}`, a.current, a.prior]);
        ar.font = { size: 9, color: { argb: GRAY } }; money(ar, 3);
      }
    }
    const tr = sh.addRow(['', `Total ${sec.label.toLowerCase()}`, sec.current, sec.prior]);
    boldRow(tr, false); money(tr, 3);
  }
  if (lastGroup) flushGroup(lastGroup);
  const tp = sh.addRow(['', 'TOTAL PASIVO Y PATRIMONIO', data.totals.current.pasivo_patrimonio, data.totals.prior.pasivo_patrimonio]);
  boldRow(tp); money(tp, 3);
  return wb.xlsx.writeBuffer();
}

async function generateComprehensiveIncomeExcel(data, tenant, generatedByName) {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet('Resultado integral');
  sh.columns = [{ width: 12 }, { width: 55 }, { width: 20 }, { width: 20 }];
  header(sh, {
    title: 'Estado del resultado integral', tenant, generatedByName, cols: 4,
    subtitle: `Del ${fmtDate(data.from)} al ${fmtDate(data.to)} comparado con ${fmtDate(data.compare_from)} – ${fmtDate(data.compare_to)}`,
  });
  headRow(sh, ['Cuenta', 'Concepto', `${fmtDate(data.from)} – ${fmtDate(data.to)}`, `${fmtDate(data.compare_from)} – ${fmtDate(data.compare_to)}`]);
  for (const l of data.lines) {
    const sign = l.negative ? -1 : 1;
    const r = sh.addRow(['', l.label, sign * l.current, sign * l.prior]);
    money(r, 3);
    if (l.subtotal) boldRow(r, !!l.strong); else r.font = { bold: true };
    for (const a of l.accounts || []) {
      const ar = sh.addRow([a.code, `    ${a.name}`, sign * a.current, sign * a.prior]);
      ar.font = { size: 9, color: { argb: GRAY } }; money(ar, 3);
    }
  }
  return wb.xlsx.writeBuffer();
}

async function generateEquityChangesExcel(data, tenant, generatedByName) {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet('Cambios en el patrimonio');
  const cols = data.columns.length + 2;
  sh.columns = [{ width: 45 }, ...data.columns.map(() => ({ width: 20 })), { width: 20 }];
  header(sh, { title: 'Estado de cambios en el patrimonio', tenant, subtitle: `Del ${fmtDate(data.from)} al ${fmtDate(data.to)}`, generatedByName, cols });
  const hr = headRow(sh, ['Concepto', ...data.columns.map((c) => c.label), 'Total patrimonio']);
  hr.alignment = { wrapText: true, vertical: 'middle' };
  for (const r of data.rows) {
    const row = sh.addRow([r.label, ...data.columns.map((c) => r.values[c.code]), r.total]);
    money(row, 2);
    if (r.strong) boldRow(row);
  }
  return wb.xlsx.writeBuffer();
}

// Conciliación fiscal: soporte del formato 2516 (no es el archivo del
// prevalidador DIAN; sirve para diligenciarlo y sustentarlo).
async function generateFiscalReconciliationExcel({ esf, eri }, tenant, generatedByName) {
  const wb = new ExcelJS.Workbook();

  const sh = wb.addWorksheet('Patrimonial (ESF)');
  sh.columns = [{ width: 12 }, { width: 60 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 13 }];
  header(sh, { title: 'Conciliación fiscal patrimonial', tenant, subtitle: `Al ${fmtDate(esf.cutoff)} — soporte del formato 2516`, generatedByName, cols: 6 });
  headRow(sh, ['Cuenta', 'Concepto', 'Valor contable', 'Ajustes', 'Valor fiscal', 'Tipo']);
  for (const group of ['activo', 'pasivo']) {
    const gr = sh.addRow(['', group === 'activo' ? 'ACTIVOS' : 'PASIVOS']);
    gr.font = { bold: true, color: { argb: RED } };
    for (const r of esf.rubros.filter((x) => x.group === group)) {
      const rr = sh.addRow(['', r.label, r.book, r.adjustment, r.fiscal]);
      rr.font = { bold: true }; money(rr, 3);
      for (const a of r.accounts) {
        const ar = sh.addRow([a.code, `    ${a.name}`, a.book]);
        ar.font = { size: 9, color: { argb: GRAY } }; money(ar, 3);
      }
      for (const adj of r.adjustments) {
        const jr = sh.addRow(['', `    Ajuste: ${adj.label}`, null, adj.amount, null, adj.type]);
        jr.font = { size: 9, italic: true, color: { argb: DARK } }; money(jr, 3);
      }
    }
    const t = sh.addRow(['', `TOTAL ${group.toUpperCase()}S`, esf.totals.book[group], esf.totals.adjustment[group], esf.totals.fiscal[group]]);
    boldRow(t); money(t, 3);
    sh.addRow([]);
  }
  const pt = sh.addRow(['', 'PATRIMONIO (activos − pasivos)', esf.totals.book.patrimonio, esf.totals.adjustment.patrimonio, esf.totals.fiscal.patrimonio]);
  boldRow(pt); money(pt, 3);

  const sr = wb.addWorksheet('Renta líquida');
  sr.columns = [{ width: 70 }, { width: 20 }];
  header(sr, { title: 'Conciliación de renta líquida', tenant, subtitle: `Año gravable ${eri.year}`, generatedByName, cols: 2 });
  headRow(sr, ['Concepto', 'Valor']);
  const line = (label, v, strong) => { const r = sr.addRow([label, v]); money(r, 2); if (strong) boldRow(r); return r; };
  line('Resultado contable antes de impuestos', eri.resultado_antes_impuestos, true);
  sr.addRow(['Diferencias temporarias (variación en el año)']).font = { bold: true, color: { argb: RED } };
  for (const t of eri.temporary) line(`    ${t.label}`, t.effect);
  line('Total diferencias temporarias', eri.totals.temporary, true);
  sr.addRow(['Diferencias permanentes y otros ajustes']).font = { bold: true, color: { argb: RED } };
  for (const p of eri.permanent) line(`    ${p.label}`, p.effect);
  line('Total diferencias permanentes', eri.totals.permanent, true);
  line('Renta líquida (pérdida fiscal si es negativa)', eri.totals.renta_liquida, true);
  line('Compensación de pérdidas fiscales', -eri.totals.compensacion_perdidas);
  line('Renta líquida gravable', eri.totals.renta_liquida_gravable, true);
  line(`Impuesto de renta estimado (${eri.settings.tax_rate}%)`, eri.totals.impuesto_estimado, true);
  line('Impuesto de renta contabilizado en el año', eri.impuesto_contabilizado);

  return wb.xlsx.writeBuffer();
}

module.exports = { generateFinancialPositionExcel, generateComprehensiveIncomeExcel, generateEquityChangesExcel, generateFiscalReconciliationExcel };
