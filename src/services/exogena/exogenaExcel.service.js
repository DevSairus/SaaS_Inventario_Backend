// backend/src/services/exogena/exogenaExcel.service.js
//
// Versión Excel de un formato de Exógena: los mismos registros que van al
// XML "muisca" (exogenaGenerator.resolveRecords), con encabezados legibles,
// totales por columna de valor y una hoja con los registros excluidos y su
// motivo. Pensado para revisar/cuadrar con el contador antes de presentar, o
// para compartir la información sin acceso a Pitbox. El archivo que se sube
// al MUISCA sigue siendo el XML.

const ExcelJS = require('exceljs');

const DARK = 'FF374151';
const WHITE = 'FFFFFFFF';
const LIGHT = 'FFF9FAFB';
const RED = 'FF8B0000';

// Atributos de los anexos técnicos (Resolución 000227/2025). Si un formato
// trae un atributo que no esté aquí, se muestra con su nombre técnico.
const ATTRIBUTE_LABELS = {
  cpt: 'Concepto',
  con: 'Concepto',
  tdoc: 'Tipo documento',
  nid: 'Número identificación',
  nit: 'Número identificación',
  dv: 'DV',
  apl1: 'Primer apellido',
  apl2: 'Segundo apellido',
  nom1: 'Primer nombre',
  nom2: 'Otros nombres',
  pap: 'Primer apellido',
  sap: 'Segundo apellido',
  pno: 'Primer nombre',
  ono: 'Otros nombres',
  raz: 'Razón social',
  dir: 'Dirección',
  dpto: 'Departamento',
  cdpt: 'Departamento',
  mun: 'Municipio',
  mcpo: 'Municipio',
  cmcp: 'Municipio',
  pais: 'País',
  paist: 'País',
  email: 'Correo electrónico',
  // 1001
  pago: 'Pago o abono en cuenta deducible',
  pnded: 'Pago o abono en cuenta NO deducible',
  ided: 'IVA mayor valor del costo deducible',
  inded: 'IVA mayor valor del costo NO deducible',
  retp: 'Retención en la fuente practicada (renta)',
  reta: 'Retención en la fuente asumida (renta)',
  comun: 'Retención IVA practicada (responsables)',
  ndom: 'Retención IVA practicada (no domiciliados)',
  // 1003
  valor: 'Valor acumulado del pago o abono sujeto a retención',
  ret: 'Retención que le practicaron',
  // 1004
  vdesc: 'Valor del descuento tributario',
  vdescsol: 'Valor del descuento solicitado',
  // 1005
  vimp: 'Impuesto descontable',
  ivade: 'IVA resultante por devoluciones en ventas',
  ivavcg: 'IVA descontable por servicios (venta de bienes o servicios)',
  // 1006
  imp: 'Impuesto generado',
  iva: 'IVA recuperado en devoluciones',
  icon: 'Impuesto al consumo',
  // 1007
  ibru: 'Ingresos brutos recibidos',
  dred: 'Devoluciones, rebajas y descuentos',
  // 1008 / 1009 / 1011
  sal: 'Saldo a 31 de diciembre',
  // 1010
  valnom: 'Valor patrimonial acciones o aportes (nominal)',
  valprm: 'Valor patrimonial acciones o aportes (prima)',
  por: 'Porcentaje de participación',
  dec: 'Decimales del porcentaje',
  // 1012
  val: 'Valor a 31 de diciembre',
  // 1647
  vtotal: 'Valor total de la operación',
  ving: 'Valor ingreso para terceros',
  vret: 'Valor retenido',
  tdoc2: 'Tipo documento (tercero)',
  nid2i: 'Identificación (tercero)',
  apl1i: 'Primer apellido (tercero)',
  apl2i: 'Segundo apellido (tercero)',
  nom1i: 'Primer nombre (tercero)',
  nom2i: 'Otros nombres (tercero)',
  razi: 'Razón social (tercero)',
  // 2276
  pasa: 'Pagos por salarios',
  paco: 'Pagos por comisiones',
  papre: 'Pagos por prestaciones sociales',
  cein: 'Cesantías e intereses pagadas directamente',
  ceco: 'Cesantías consignadas al fondo',
  apos: 'Aportes obligatorios salud',
  apof: 'Aportes obligatorios pensión y FSP',
  apov: 'Aportes voluntarios pensión',
  apafc: 'Aportes cuentas AFC',
  vare: 'Retención en la fuente',
  tingbtp: 'Total ingresos brutos por rentas de trabajo y pensión',
};

// Atributos que son códigos/identificadores aunque vengan como número: no
// se formatean como moneda ni se totalizan.
const CODE_ATTRIBUTES = new Set([
  'cpt', 'con', 'tdoc', 'nid', 'nit', 'dv', 'dpto', 'cdpt', 'mun', 'mcpo', 'cmcp', 'pais', 'paist',
  'tdoc2', 'nid2i', 'por', 'dec',
]);

const SKIP_REASONS = {
  sin_concepto_mapeado: 'Sin concepto DIAN mapeado',
  proveedor_sin_nit: 'Proveedor sin NIT/documento',
  cliente_sin_nit: 'Cliente sin NIT/documento',
  empleado_sin_documento: 'Empleado sin documento',
  banco_sin_nit: 'Banco sin NIT',
};

const TDOC_LABELS = { 11: 'Registro civil', 12: 'Tarjeta de identidad', 13: 'Cédula de ciudadanía', 21: 'Tarjeta de extranjería', 22: 'Cédula de extranjería', 31: 'NIT', 41: 'Pasaporte', 42: 'Documento extranjero', 43: 'Sin identificación (exterior)', 47: 'PEP', 91: 'NUIP' };

function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 32;
}

function addTitle(sheet, lastCol, lines) {
  lines.forEach((line, idx) => {
    const r = idx + 1;
    sheet.mergeCells(`A${r}:${lastCol}${r}`);
    const cell = sheet.getCell(`A${r}`);
    cell.value = line.text;
    cell.font = line.font;
  });
}

/**
 * @returns {Promise<Buffer>}
 */
async function buildExogenaWorkbook({ formatCode, formatName, version, year, records, skipped, tenant, totalValueField }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  // Columnas: unión de atributos en el orden en que aparecen (el mismo del XML).
  const keys = [];
  for (const rec of records) {
    for (const k of Object.keys(rec)) if (!keys.includes(k)) keys.push(k);
  }
  const numericKeys = new Set(
    keys.filter((k) => !CODE_ATTRIBUTES.has(k) && records.some((r) => typeof r[k] === 'number')
      && records.every((r) => r[k] === null || r[k] === undefined || r[k] === '' || typeof r[k] === 'number'))
  );
  const hasTdoc = keys.includes('tdoc');

  const sheet = workbook.addWorksheet(`Formato ${formatCode}`, { views: [{ state: 'frozen', ySplit: 6 }] });
  const columns = [];
  for (const k of keys) {
    columns.push({ key: k, label: ATTRIBUTE_LABELS[k] || k, numeric: numericKeys.has(k) });
    if (k === 'tdoc' && hasTdoc) columns.push({ key: '__tdoc_label', label: 'Tipo documento (nombre)', numeric: false });
  }
  const lastCol = columnLetter(Math.max(columns.length, 4));

  addTitle(sheet, lastCol, [
    { text: `INFORMACIÓN EXÓGENA — FORMATO ${formatCode}${version ? ` (v${version})` : ''} — ${tenant?.company_name || ''}`, font: { bold: true, size: 14, color: { argb: RED } } },
    { text: `${formatName || ''}${tenant?.tax_id ? `  ·  NIT: ${tenant.tax_id}` : ''}`, font: { size: 10, color: { argb: DARK } } },
    { text: `Año gravable: ${year}  ·  ${records.length} registro(s)${skipped?.length ? `  ·  ${skipped.length} excluido(s), ver hoja "Excluidos"` : ''}`, font: { size: 10, color: { argb: DARK } } },
    { text: `Generado: ${new Date().toLocaleString('es-CO')}  ·  Documento de revisión — el archivo que se presenta a la DIAN es el XML.`, font: { size: 9, italic: true, color: { argb: 'FF6B7280' } } },
  ]);

  sheet.columns = columns.map((c) => ({ key: c.key, width: c.numeric ? 18 : Math.min(Math.max(c.label.length, 10), 32) }));

  const headerRowNum = 6;
  const headerRow = sheet.getRow(headerRowNum);
  headerRow.values = columns.map((c) => c.label);
  styleHeaderRow(headerRow);

  // Fila con el nombre técnico del atributo (lo que se ve en el XML/MUISCA).
  // Se pone como nota en el encabezado para no ensuciar la tabla.
  columns.forEach((c, idx) => {
    if (!c.key.startsWith('__')) headerRow.getCell(idx + 1).note = `Atributo XML: ${c.key}`;
  });

  let r = headerRowNum + 1;
  if (records.length === 0) {
    sheet.mergeCells(`A${r}:${lastCol}${r}`);
    sheet.getCell(`A${r}`).value = 'Sin registros para el año gravable seleccionado.';
    r += 1;
  } else {
    records.forEach((rec, idx) => {
      const row = sheet.getRow(r);
      row.values = columns.map((c) => {
        if (c.key === '__tdoc_label') return TDOC_LABELS[Number(rec.tdoc)] || '';
        const v = rec[c.key];
        return v === undefined ? null : v;
      });
      columns.forEach((c, cIdx) => { if (c.numeric) row.getCell(cIdx + 1).numFmt = '$#,##0'; });
      if (idx % 2 === 1) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; });
      r += 1;
    });
    sheet.autoFilter = { from: `A${headerRowNum}`, to: `${columnLetter(columns.length)}${r - 1}` };

    // Totales por columna de valor (fórmula, para que se recalcule si el
    // contador filtra o ajusta algo en la hoja).
    const totalRow = sheet.getRow(r);
    const firstData = headerRowNum + 1;
    const lastData = r - 1;
    let labelPlaced = false;
    columns.forEach((c, cIdx) => {
      const cell = totalRow.getCell(cIdx + 1);
      if (c.numeric) {
        const col = columnLetter(cIdx + 1);
        const total = records.reduce((s, rec) => s + Number(rec[c.key] || 0), 0);
        cell.value = { formula: `SUBTOTAL(9,${col}${firstData}:${col}${lastData})`, result: total };
        cell.numFmt = '$#,##0';
        cell.font = c.key === totalValueField ? { bold: true, color: { argb: RED } } : { bold: true };
      } else if (!labelPlaced) {
        cell.value = 'TOTAL';
        cell.font = { bold: true };
        labelPlaced = true;
      }
      cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
    });
  }

  // ── Excluidos ──
  if (skipped && skipped.length > 0) {
    const sk = workbook.addWorksheet('Excluidos');
    const skKeys = [];
    for (const row of skipped) for (const k of Object.keys(row)) if (k !== 'reason' && !skKeys.includes(k)) skKeys.push(k);
    addTitle(sk, columnLetter(Math.max(skKeys.length + 1, 4)), [
      { text: `REGISTROS EXCLUIDOS — FORMATO ${formatCode} — ${year}`, font: { bold: true, size: 13, color: { argb: RED } } },
      { text: 'Filas que no se incluyen en el archivo por falta de datos. Corrígelas y vuelve a generar.', font: { size: 10, color: { argb: DARK } } },
    ]);
    sk.columns = [{ width: 30 }, ...skKeys.map(() => ({ width: 38 }))];
    const h = sk.getRow(4);
    h.values = ['Motivo', ...skKeys];
    styleHeaderRow(h);
    skipped.forEach((row, idx) => {
      const sr = sk.getRow(5 + idx);
      sr.values = [SKIP_REASONS[row.reason] || row.reason, ...skKeys.map((k) => (row[k] === undefined ? null : row[k]))];
    });
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildExogenaWorkbook, ATTRIBUTE_LABELS };
