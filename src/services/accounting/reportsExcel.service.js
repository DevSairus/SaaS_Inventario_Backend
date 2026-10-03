// backend/src/services/accounting/reportsExcel.service.js
const ExcelJS = require('exceljs');

/* ── PALETA (misma que excelService.js — consistencia visual) ────── */
const RED = 'FF8B0000';
const GREEN = 'FF059669';
const REDAMT = 'FFDC2626';
const DARK = 'FF374151';
const LIGHT = 'FFF9FAFB';
const WHITE = 'FFFFFFFF';

function fmtDate(isoDateStr) {
  if (!isoDateStr) return '—';
  const [y, m, d] = isoDateStr.split('-');
  if (!y || !m || !d) return isoDateStr;
  return `${d}/${m}/${y}`;
}

// Los valores ya vienen como 'YYYY-MM-DD' (fecha de negocio, sin hora).
// Se convierten a Date usando componentes UTC explícitos para que Excel
// muestre el mismo día sin importar la zona horaria de quien lo abra
// (mismo patrón que excelService.js/generateCashFlowExcel).
function toExcelDate(isoDateStr) {
  if (!isoDateStr) return null;
  const [y, m, d] = isoDateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function addHeader(sheet, { title, tenant, subtitle, generatedByName, mergeCols }) {
  sheet.mergeCells(`A1:${mergeCols}1`);
  const titleCell = sheet.getCell('A1');
  titleCell.value = `${title} — ${tenant?.company_name || ''}`;
  titleCell.font = { bold: true, size: 14, color: { argb: RED } };

  sheet.mergeCells(`A2:${mergeCols}2`);
  sheet.getCell('A2').value = tenant?.tax_id ? `NIT: ${tenant.tax_id}` : '';
  sheet.getCell('A2').font = { size: 9, color: { argb: 'FF6B7280' } };

  sheet.mergeCells(`A3:${mergeCols}3`);
  sheet.getCell('A3').value = subtitle;
  sheet.getCell('A3').font = { size: 10, color: { argb: DARK } };

  sheet.mergeCells(`A4:${mergeCols}4`);
  sheet.getCell('A4').value = `Generado: ${new Date().toLocaleString('es-CO')}${generatedByName ? ' · ' + generatedByName : ''}`;
  sheet.getCell('A4').font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };
}

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    cell.alignment = { vertical: 'middle' };
  });
}

function zebraStripe(row, idx) {
  if (idx % 2 === 1) {
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    });
  }
}

/* ── DETALLE DE ASIENTOS (hoja anexa) ─────────────────────────────
 * Los reportes que solo listan el N° de asiento (Libro Mayor, Auxiliar,
 * IVA, Retenciones) quedan incompletos para quien recibe el archivo sin
 * acceso a Pitbox. Esta hoja anexa trae cada asiento referenciado con
 * todas sus líneas (cuenta, tercero, débito, crédito), y el N° de asiento
 * de la hoja principal queda como hipervínculo a su bloque aquí.
 *
 * `details` = { entries, truncated, total } (entryDetails.service.js).
 * Devuelve Map(entry_id → fila de inicio) para armar los hipervínculos.
 */
const DETAIL_SHEET_NAME = 'Detalle de Asientos';
const SOURCE_LABELS = {
  sale: 'Venta', payment: 'Abono de cliente', purchase: 'Compra', expense: 'Gasto', cash_session: 'Cierre de caja',
  customer_return: 'Devolución de cliente', credit_note: 'Nota crédito', debit_note: 'Nota débito',
  supplier_return: 'Devolución a proveedor', customer_advance: 'Anticipo de cliente', manual: 'Manual',
  payroll: 'Nómina', opening_balance: 'Saldo inicial', depreciation: 'Depreciación',
};

function addEntryDetailSheet(workbook, details, { tenant, subtitle, generatedByName } = {}) {
  const positions = new Map();
  if (!details) return positions;

  const sheet = workbook.addWorksheet(DETAIL_SHEET_NAME, { views: [{ state: 'frozen', ySplit: 6 }] });
  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'code', width: 12 },
    { key: 'account', width: 34 },
    { key: 'third', width: 30 },
    { key: 'detail', width: 34 },
    { key: 'debit', width: 16 },
    { key: 'credit', width: 16 },
  ];

  addHeader(sheet, {
    title: 'DETALLE DE ASIENTOS',
    tenant,
    subtitle: subtitle || 'Asientos referenciados en el reporte',
    generatedByName,
    mergeCols: 'H',
  });

  const headerRow = sheet.getRow(6);
  headerRow.values = ['Fecha', 'N° Asiento', 'Código', 'Cuenta', 'Tercero', 'Detalle', 'Débito', 'Crédito'];
  styleHeaderRow(headerRow);

  let r = 7;
  if (details.truncated) {
    sheet.mergeCells(`A${r}:H${r}`);
    sheet.getCell(`A${r}`).value = `El reporte referencia ${details.total} asientos; el detalle se omite por tamaño. Genera el reporte por un rango de fechas menor para incluirlo.`;
    sheet.getCell(`A${r}`).font = { italic: true, color: { argb: 'FF6B7280' } };
    return positions;
  }
  if (!details.entries || details.entries.length === 0) {
    sheet.mergeCells(`A${r}:H${r}`);
    sheet.getCell(`A${r}`).value = 'Sin asientos referenciados.';
    return positions;
  }

  for (const entry of details.entries) {
    positions.set(entry.id, r);

    // Encabezado del asiento
    const head = sheet.getRow(r);
    head.values = [toExcelDate(entry.entry_date), entry.entry_number, '', entry.description || '', '', SOURCE_LABELS[entry.source_type] || entry.source_type || '', '', ''];
    head.getCell(1).numFmt = 'dd/mm/yyyy';
    head.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, color: { argb: DARK } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    });
    r += 1;

    entry.lines.forEach((line, idx) => {
      const row = sheet.getRow(r);
      row.values = [
        '',
        '',
        line.account_code,
        line.account_name,
        line.third_party_name ? `${line.third_party_name}${line.third_party_tax_id ? ' - ' + line.third_party_tax_id : ''}` : '',
        line.description,
        Number(line.debit) || null,
        Number(line.credit) || null,
      ];
      row.getCell(7).numFmt = '$#,##0';
      row.getCell(8).numFmt = '$#,##0';
      zebraStripe(row, idx);
      r += 1;
    });

    const total = sheet.getRow(r);
    total.values = ['', '', '', '', '', 'Total asiento', Number(entry.total_debit), Number(entry.total_credit)];
    total.getCell(6).font = { bold: true };
    total.getCell(7).font = { bold: true };
    total.getCell(8).font = { bold: true };
    total.getCell(7).numFmt = '$#,##0';
    total.getCell(8).numFmt = '$#,##0';
    total.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
    r += 2;
  }

  return positions;
}

// Valor de celda para el N° de asiento: hipervínculo interno al bloque del
// asiento en la hoja de detalle, o el número plano si no hay detalle.
function entryNumberCell(entryNumber, entryId, positions) {
  const row = positions?.get(entryId);
  if (!row) return entryNumber;
  return { text: String(entryNumber ?? ''), hyperlink: `#'${DETAIL_SHEET_NAME}'!A${row}` };
}

function styleLinkCell(cell) {
  if (cell.value && typeof cell.value === 'object' && cell.value.hyperlink) {
    cell.font = { color: { argb: 'FF2563EB' }, underline: true };
  }
}

/**
 * Balance de Comprobación (trial balance) en Excel.
 * data = { accounts: [{code,name,account_type,total_debit,total_credit}], totals: {debit,credit}, branch_id }
 */
const generateTrialBalanceExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Balance de Comprobación', {
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  sheet.columns = [
    { key: 'code', width: 12 },
    { key: 'name', width: 38 },
    { key: 'type', width: 16 },
    { key: 'debit', width: 18 },
    { key: 'credit', width: 18 },
  ];

  addHeader(sheet, {
    title: 'BALANCE DE COMPROBACIÓN',
    tenant,
    subtitle: `Periodo: ${fmtDate(filters.from)} a ${fmtDate(filters.to)}`,
    generatedByName,
    mergeCols: 'E',
  });

  const headerRow = sheet.getRow(6);
  headerRow.values = ['Código', 'Cuenta', 'Tipo', 'Débito', 'Crédito'];
  styleHeaderRow(headerRow);

  const accounts = data.accounts || [];
  accounts.forEach((a, idx) => {
    const row = sheet.getRow(7 + idx);
    row.values = [a.code, a.name, a.account_type, Number(a.total_debit), Number(a.total_credit)];
    row.getCell(4).numFmt = '$#,##0';
    row.getCell(5).numFmt = '$#,##0';
    zebraStripe(row, idx);
  });

  const lastDataRow = 7 + accounts.length;
  if (accounts.length === 0) {
    sheet.getCell(`A${lastDataRow}`).value = 'Sin movimientos contabilizados en el periodo seleccionado.';
    sheet.mergeCells(`A${lastDataRow}:E${lastDataRow}`);
  } else {
    sheet.autoFilter = { from: 'A6', to: `E${lastDataRow - 1}` };
  }

  const totalRow = sheet.getRow(lastDataRow + 1);
  totalRow.values = ['', '', 'Total', Number(data.totals?.debit || 0), Number(data.totals?.credit || 0)];
  totalRow.getCell(3).font = { bold: true };
  totalRow.getCell(4).numFmt = '$#,##0';
  totalRow.getCell(5).numFmt = '$#,##0';
  totalRow.getCell(4).font = { bold: true };
  totalRow.getCell(5).font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  return workbook.xlsx.writeBuffer();
};

/**
 * Balance General en Excel.
 * data = { as_of, activo, pasivo, patrimonio, resultado_no_cerrado, totales }
 */
const generateBalanceGeneralExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Balance General', {
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  sheet.columns = [
    { key: 'code', width: 12 },
    { key: 'name', width: 40 },
    { key: 'balance', width: 18 },
  ];

  addHeader(sheet, {
    title: 'BALANCE GENERAL',
    tenant,
    subtitle: `Corte al: ${fmtDate(data.as_of)}`,
    generatedByName,
    mergeCols: 'C',
  });

  let r = 6;
  const sectionHeader = (label) => {
    sheet.mergeCells(`A${r}:C${r}`);
    const cell = sheet.getCell(`A${r}`);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    r += 1;
  };

  const writeRows = (rows, extra = []) => {
    rows.forEach((a, idx) => {
      const row = sheet.getRow(r);
      row.values = [a.code, a.name, Number(a.balance)];
      row.getCell(3).numFmt = '$#,##0';
      zebraStripe(row, idx);
      r += 1;
    });
    extra.forEach(([label, value, bold]) => {
      const row = sheet.getRow(r);
      row.values = ['', label, Number(value)];
      row.getCell(3).numFmt = '$#,##0';
      if (bold) {
        row.getCell(2).font = { bold: true };
        row.getCell(3).font = { bold: true };
        row.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
      } else {
        row.getCell(2).font = { italic: true, color: { argb: 'FF6B7280' } };
        row.getCell(3).font = { italic: true, color: { argb: 'FF6B7280' } };
      }
      r += 1;
    });
    r += 1; // fila en blanco entre secciones
  };

  sectionHeader('ACTIVO');
  writeRows(data.activo || [], [['Total Activo', data.totales?.total_activo || 0, true]]);

  sectionHeader('PASIVO');
  writeRows(data.pasivo || [], [['Total Pasivo', data.totales?.total_pasivo || 0, true]]);

  sectionHeader('PATRIMONIO');
  writeRows(data.patrimonio || [], [
    ['Resultado del ejercicio (no cerrado)', data.resultado_no_cerrado || 0, false],
    ['Total Patrimonio', data.totales?.total_patrimonio || 0, true],
  ]);

  const cuadra = data.totales?.cuadra;
  sheet.mergeCells(`A${r}:C${r}`);
  const checkCell = sheet.getCell(`A${r}`);
  checkCell.value = cuadra
    ? '✓ El balance cuadra (Activo = Pasivo + Patrimonio)'
    : '✗ El balance no cuadra — revisar los asientos';
  checkCell.font = { bold: true, color: { argb: cuadra ? GREEN : REDAMT } };

  return workbook.xlsx.writeBuffer();
};

/**
 * Estado de Resultados (P&G) en Excel.
 * data = { from, to, ingresos, costos, gastos, totales }
 */
const generateIncomeStatementExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Estado de Resultados', {
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  sheet.columns = [
    { key: 'code', width: 12 },
    { key: 'name', width: 40 },
    { key: 'total', width: 18 },
  ];

  addHeader(sheet, {
    title: 'ESTADO DE RESULTADOS (P&G)',
    tenant,
    subtitle: `Periodo: ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
    mergeCols: 'C',
  });

  let r = 6;
  const sectionHeader = (label) => {
    sheet.mergeCells(`A${r}:C${r}`);
    const cell = sheet.getCell(`A${r}`);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    r += 1;
  };

  const writeRows = (rows, extra = []) => {
    rows.forEach((a, idx) => {
      const row = sheet.getRow(r);
      row.values = [a.code, a.name, Number(a.total)];
      row.getCell(3).numFmt = '$#,##0';
      zebraStripe(row, idx);
      r += 1;
    });
    extra.forEach(([label, value, color]) => {
      const row = sheet.getRow(r);
      row.values = ['', label, Number(value)];
      row.getCell(3).numFmt = '$#,##0';
      row.getCell(2).font = { bold: true, color: color ? { argb: color } : undefined };
      row.getCell(3).font = { bold: true, color: color ? { argb: color } : undefined };
      row.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
      r += 1;
    });
    r += 1;
  };

  const totales = data.totales || {};

  sectionHeader('INGRESOS');
  writeRows(data.ingresos || [], [['Total Ingresos', totales.total_ingresos || 0]]);

  sectionHeader('COSTO DE VENTAS');
  writeRows(data.costos || [], [
    ['Total Costos', totales.total_costos || 0],
    ['Utilidad Bruta', totales.utilidad_bruta || 0, 'FF4F46E5'],
  ]);

  sectionHeader('GASTOS OPERATIVOS');
  const utilidadNeta = totales.utilidad_neta || 0;
  writeRows(data.gastos || [], [
    ['Total Gastos', totales.total_gastos || 0],
    ['Utilidad Neta', utilidadNeta, utilidadNeta >= 0 ? GREEN : REDAMT],
  ]);

  return workbook.xlsx.writeBuffer();
};

/**
 * Libro Diario en Excel — una fila por línea de asiento (no agregada),
 * ordenado cronológicamente. `data.rows` viene ya aplanado y ordenado desde
 * el controller (entry_date, entry_number, line_order).
 */
const generateLibroDiarioExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Libro Diario', {
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'code', width: 10 },
    { key: 'account', width: 34 },
    { key: 'detail', width: 30 },
    { key: 'debit', width: 16 },
    { key: 'credit', width: 16 },
  ];

  addHeader(sheet, {
    title: 'LIBRO DIARIO',
    tenant,
    subtitle: `Periodo: ${fmtDate(filters.from)} a ${fmtDate(filters.to)}  ·  ${data.entry_count} asientos, ${data.line_count} líneas`,
    generatedByName,
    mergeCols: 'G',
  });

  const headerRow = sheet.getRow(6);
  headerRow.values = ['Fecha', 'N° Asiento', 'Código', 'Cuenta', 'Detalle', 'Débito', 'Crédito'];
  styleHeaderRow(headerRow);

  const rows = data.rows || [];
  let r = 7;
  let currentEntry = null;
  rows.forEach((line) => {
    // Línea en blanco entre asientos distintos, para que el contador
    // distinga visualmente dónde empieza cada uno sin perder el detalle.
    if (currentEntry !== null && currentEntry !== line.entry_id) {
      r += 1;
    }
    currentEntry = line.entry_id;

    const row = sheet.getRow(r);
    row.values = [
      toExcelDate(line.entry_date),
      line.entry_number,
      line.account_code,
      line.account_name,
      line.line_description || line.entry_description || '',
      Number(line.debit),
      Number(line.credit),
    ];
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(6).numFmt = '$#,##0';
    row.getCell(7).numFmt = '$#,##0';
    r += 1;
  });

  const lastDataRow = r - 1;
  if (rows.length === 0) {
    sheet.getCell(`A${r}`).value = 'Sin asientos contabilizados en el periodo seleccionado.';
    sheet.mergeCells(`A${r}:G${r}`);
    r += 1;
  } else {
    sheet.autoFilter = { from: 'A6', to: `G${lastDataRow}` };
  }

  const totalRow = sheet.getRow(r + 1);
  totalRow.values = ['', '', '', '', 'Total', Number(data.totals?.debit || 0), Number(data.totals?.credit || 0)];
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(6).numFmt = '$#,##0';
  totalRow.getCell(7).numFmt = '$#,##0';
  totalRow.getCell(6).font = { bold: true };
  totalRow.getCell(7).font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  return workbook.xlsx.writeBuffer();
};

/**
 * Libro Mayor en Excel — movimientos de UNA cuenta con saldo corrido
 * (running balance), precedidos por el saldo inicial del período.
 * data = { account, from, to, opening_balance, closing_balance, movements, totals }
 */
const generateLibroMayorExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Libro Mayor', {
    views: [{ state: 'frozen', ySplit: 7 }],
  });
  const entryRows = addEntryDetailSheet(workbook, data.entry_details, {
    tenant,
    subtitle: `Libro Mayor · Cuenta ${data.account?.code || ''} - ${data.account?.name || ''} · ${fmtDate(filters.from)} a ${fmtDate(filters.to)}`,
    generatedByName,
  });

  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'detail', width: 40 },
    { key: 'debit', width: 16 },
    { key: 'credit', width: 16 },
    { key: 'balance', width: 18 },
  ];

  addHeader(sheet, {
    title: 'LIBRO MAYOR',
    tenant,
    subtitle: `Cuenta: ${data.account?.code || ''} - ${data.account?.name || ''}  ·  Periodo: ${fmtDate(filters.from)} a ${fmtDate(filters.to)}`,
    generatedByName,
    mergeCols: 'F',
  });

  const openingRowNum = 6;
  const openingRow = sheet.getRow(openingRowNum);
  openingRow.values = ['', '', 'Saldo inicial', '', '', Number(data.opening_balance || 0)];
  openingRow.getCell(3).font = { italic: true, color: { argb: 'FF6B7280' } };
  openingRow.getCell(6).font = { bold: true, italic: true };
  openingRow.getCell(6).numFmt = '$#,##0';

  const headerRowNum = openingRowNum + 1;
  const headerRow = sheet.getRow(headerRowNum);
  headerRow.values = ['Fecha', 'N° Asiento', 'Detalle', 'Débito', 'Crédito', 'Saldo'];
  styleHeaderRow(headerRow);

  const movements = data.movements || [];
  const firstDataRow = headerRowNum + 1;
  movements.forEach((m, idx) => {
    const row = sheet.getRow(firstDataRow + idx);
    row.values = [
      toExcelDate(m.entry_date),
      entryNumberCell(m.entry_number, m.entry_id, entryRows),
      m.description,
      Number(m.debit),
      Number(m.credit),
      Number(m.running_balance),
    ];
    styleLinkCell(row.getCell(2));
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(4).numFmt = '$#,##0';
    row.getCell(5).numFmt = '$#,##0';
    row.getCell(6).numFmt = '$#,##0';
    zebraStripe(row, idx);
  });

  const lastDataRow = firstDataRow + movements.length - 1;
  if (movements.length === 0) {
    sheet.getCell(`A${firstDataRow}`).value = 'Sin movimientos en el periodo seleccionado.';
    sheet.mergeCells(`A${firstDataRow}:F${firstDataRow}`);
  } else {
    sheet.autoFilter = { from: `A${headerRowNum}`, to: `F${lastDataRow}` };
  }

  const totalRowNum = (movements.length === 0 ? firstDataRow : lastDataRow) + 2;
  const totalRow = sheet.getRow(totalRowNum);
  totalRow.values = ['', '', 'Total periodo / Saldo final', Number(data.totals?.debit || 0), Number(data.totals?.credit || 0), Number(data.closing_balance || 0)];
  totalRow.getCell(3).font = { bold: true };
  totalRow.getCell(4).numFmt = '$#,##0';
  totalRow.getCell(5).numFmt = '$#,##0';
  totalRow.getCell(6).numFmt = '$#,##0';
  totalRow.getCell(4).font = { bold: true };
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(6).font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  return workbook.xlsx.writeBuffer();
};

/**
 * Libro Auxiliar por tercero en Excel — mismo formato que Libro Mayor pero
 * filtrado por cliente/proveedor en vez de por cuenta.
 * data = { third_party, from, to, opening_balance, closing_balance, movements, totals }
 */
const generateLibroAuxiliarExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Libro Auxiliar', {
    views: [{ state: 'frozen', ySplit: 7 }],
  });
  const entryRows = addEntryDetailSheet(workbook, data.entry_details, {
    tenant,
    subtitle: `Libro Auxiliar · ${data.third_party?.name || ''} · ${fmtDate(filters.from)} a ${fmtDate(filters.to)}`,
    generatedByName,
  });

  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'account', width: 28 },
    { key: 'detail', width: 32 },
    { key: 'debit', width: 16 },
    { key: 'credit', width: 16 },
    { key: 'balance', width: 18 },
  ];

  const tpLabel = { customer: 'Cliente', supplier: 'Proveedor', employee: 'Empleado' }[data.third_party?.type] || 'Tercero';
  addHeader(sheet, {
    title: 'LIBRO AUXILIAR POR TERCERO',
    tenant,
    subtitle: `${tpLabel}: ${data.third_party?.name || ''}${data.third_party?.tax_id ? ' - ' + data.third_party.tax_id : ''}  ·  Periodo: ${fmtDate(filters.from)} a ${fmtDate(filters.to)}`,
    generatedByName,
    mergeCols: 'G',
  });

  const openingRowNum = 6;
  const openingRow = sheet.getRow(openingRowNum);
  openingRow.values = ['', '', '', 'Saldo inicial', '', '', Number(data.opening_balance || 0)];
  openingRow.getCell(4).font = { italic: true, color: { argb: 'FF6B7280' } };
  openingRow.getCell(7).font = { bold: true, italic: true };
  openingRow.getCell(7).numFmt = '$#,##0';

  const headerRowNum = openingRowNum + 1;
  const headerRow = sheet.getRow(headerRowNum);
  headerRow.values = ['Fecha', 'N° Asiento', 'Cuenta', 'Detalle', 'Débito', 'Crédito', 'Saldo'];
  styleHeaderRow(headerRow);

  const movements = data.movements || [];
  const firstDataRow = headerRowNum + 1;
  movements.forEach((m, idx) => {
    const row = sheet.getRow(firstDataRow + idx);
    row.values = [
      toExcelDate(m.entry_date),
      entryNumberCell(m.entry_number, m.entry_id, entryRows),
      `${m.account_code} - ${m.account_name}`,
      m.description,
      Number(m.debit),
      Number(m.credit),
      Number(m.running_balance),
    ];
    styleLinkCell(row.getCell(2));
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(5).numFmt = '$#,##0';
    row.getCell(6).numFmt = '$#,##0';
    row.getCell(7).numFmt = '$#,##0';
    zebraStripe(row, idx);
  });

  const lastDataRow = firstDataRow + movements.length - 1;
  if (movements.length === 0) {
    sheet.getCell(`A${firstDataRow}`).value = 'Sin movimientos en el periodo seleccionado.';
    sheet.mergeCells(`A${firstDataRow}:G${firstDataRow}`);
  } else {
    sheet.autoFilter = { from: `A${headerRowNum}`, to: `G${lastDataRow}` };
  }

  const totalRowNum = (movements.length === 0 ? firstDataRow : lastDataRow) + 2;
  const totalRow = sheet.getRow(totalRowNum);
  totalRow.values = ['', '', '', 'Total periodo / Saldo final', Number(data.totals?.debit || 0), Number(data.totals?.credit || 0), Number(data.closing_balance || 0)];
  totalRow.getCell(4).font = { bold: true };
  totalRow.getCell(5).numFmt = '$#,##0';
  totalRow.getCell(6).numFmt = '$#,##0';
  totalRow.getCell(7).numFmt = '$#,##0';
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(6).font = { bold: true };
  totalRow.getCell(7).font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  // Saldo al corte por cuenta (el saldo final mezcla cuentas: ej. cuenta
  // por pagar al proveedor + retenciones que se le practicaron).
  if (Array.isArray(data.by_account) && data.by_account.length > 0) {
    let br = totalRowNum + 3;
    sheet.mergeCells(`A${br}:G${br}`);
    sheet.getCell(`A${br}`).value = `SALDO POR CUENTA AL ${fmtDate(filters.to)}`;
    sheet.getCell(`A${br}`).font = { bold: true, color: { argb: WHITE } };
    sheet.getCell(`A${br}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    br += 1;
    data.by_account.forEach((a, idx) => {
      const row = sheet.getRow(br);
      row.values = ['', '', `${a.account_code} - ${a.account_name}`, '', '', '', Number(a.balance)];
      row.getCell(7).numFmt = '$#,##0';
      zebraStripe(row, idx);
      br += 1;
    });
  }

  return workbook.xlsx.writeBuffer();
};

/**
 * Libro de IVA en Excel — IVA generado (ventas) vs IVA descontable (compras)
 * en el período, con el neto (IVA a pagar) al final.
 * data = { from, to, generado: [...], descontable: [...], totals }
 */
const generateLibroIvaExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Libro de IVA');
  const entryRows = addEntryDetailSheet(workbook, data.entry_details, {
    tenant,
    subtitle: `Libro de IVA · ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
  });

  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'source', width: 14 },
    { key: 'detail', width: 36 },
    { key: 'amount', width: 18 },
  ];

  addHeader(sheet, {
    title: 'LIBRO DE IVA',
    tenant,
    subtitle: `Periodo: ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
    mergeCols: 'E',
  });

  let r = 6;
  const sectionHeader = (label) => {
    sheet.mergeCells(`A${r}:E${r}`);
    const cell = sheet.getCell(`A${r}`);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    r += 1;
  };

  const writeSection = (rows, totalLabel, total) => {
    const headerRow = sheet.getRow(r);
    headerRow.values = ['Fecha', 'N° Asiento', 'Origen', 'Detalle', 'Valor'];
    styleHeaderRow(headerRow);
    r += 1;

    if (rows.length === 0) {
      sheet.getCell(`A${r}`).value = 'Sin movimientos en el periodo seleccionado.';
      sheet.mergeCells(`A${r}:E${r}`);
      r += 1;
    } else {
      rows.forEach((row, idx) => {
        const sheetRow = sheet.getRow(r);
        sheetRow.values = [toExcelDate(row.entry_date), entryNumberCell(row.entry_number, row.entry_id, entryRows), row.source_type, row.description, Number(row.amount)];
        styleLinkCell(sheetRow.getCell(2));
        sheetRow.getCell(1).numFmt = 'dd/mm/yyyy';
        sheetRow.getCell(5).numFmt = '$#,##0';
        zebraStripe(sheetRow, idx);
        r += 1;
      });
    }

    const totalRow = sheet.getRow(r);
    totalRow.values = ['', '', '', totalLabel, Number(total || 0)];
    totalRow.getCell(4).font = { bold: true };
    totalRow.getCell(5).font = { bold: true };
    totalRow.getCell(5).numFmt = '$#,##0';
    totalRow.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
    r += 2;
  };

  sectionHeader('IVA GENERADO (VENTAS)');
  writeSection(data.generado || [], 'Total IVA Generado', data.totals?.generado);

  sectionHeader('IVA DESCONTABLE (COMPRAS)');
  writeSection(data.descontable || [], 'Total IVA Descontable', data.totals?.descontable);

  const ivaAPagar = data.totals?.iva_a_pagar || 0;
  sheet.mergeCells(`A${r}:D${r}`);
  sheet.getCell(`A${r}`).value = ivaAPagar >= 0 ? 'IVA A PAGAR' : 'SALDO A FAVOR';
  sheet.getCell(`A${r}`).font = { bold: true, size: 12, color: { argb: ivaAPagar >= 0 ? RED : GREEN } };
  sheet.getCell(`E${r}`).value = Number(ivaAPagar);
  sheet.getCell(`E${r}`).numFmt = '$#,##0';
  sheet.getCell(`E${r}`).font = { bold: true, size: 12, color: { argb: ivaAPagar >= 0 ? RED : GREEN } };

  return workbook.xlsx.writeBuffer();
};

/* ══════════════════════════════════════════════════════════════════
   8) ANTIGÜEDAD DE CARTERA / CUENTAS POR PAGAR (aging)
   ══════════════════════════════════════════════════════════════════ */
const generateAgingExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const label = data.type === 'customer' ? 'Cartera (Clientes)' : 'Cuentas por Pagar (Proveedores)';
  const sheet = workbook.addWorksheet('Antigüedad de Saldos');

  sheet.columns = [
    { key: 'name', width: 32 },
    { key: 'current', width: 15 },
    { key: 'd1_30', width: 15 },
    { key: 'd31_60', width: 15 },
    { key: 'd61_90', width: 15 },
    { key: 'd90_plus', width: 15 },
    { key: 'total', width: 16 },
  ];

  addHeader(sheet, {
    title: `ANTIGÜEDAD DE SALDOS — ${label.toUpperCase()}`,
    tenant,
    subtitle: `Corte al: ${fmtDate(data.as_of)}`,
    generatedByName,
    mergeCols: 'G',
  });

  let r = 6;
  const headerRow = sheet.getRow(r);
  headerRow.values = ['Tercero', 'Sin vencer', '1-30 días', '31-60 días', '61-90 días', 'Más de 90', 'Total'];
  styleHeaderRow(headerRow);
  r += 1;

  if (data.third_parties.length === 0) {
    sheet.mergeCells(`A${r}:G${r}`);
    sheet.getCell(`A${r}`).value = 'Sin saldos abiertos a la fecha de corte.';
    r += 1;
  } else {
    data.third_parties.forEach((tp, idx) => {
      const row = sheet.getRow(r);
      row.values = [
        tp.name,
        Number(tp.buckets.current || 0),
        Number(tp.buckets.d1_30 || 0),
        Number(tp.buckets.d31_60 || 0),
        Number(tp.buckets.d61_90 || 0),
        Number(tp.buckets.d90_plus || 0),
        Number(tp.total),
      ];
      for (let c = 2; c <= 7; c += 1) row.getCell(c).numFmt = '$#,##0';
      zebraStripe(row, idx);
      r += 1;
    });
  }

  const totalRow = sheet.getRow(r);
  const bucketTotal = (key) => data.buckets.find((b) => b.key === key)?.total || 0;
  totalRow.values = ['TOTAL', bucketTotal('current'), bucketTotal('d1_30'), bucketTotal('d31_60'), bucketTotal('d61_90'), bucketTotal('d90_plus'), data.grand_total];
  totalRow.eachCell((cell) => { cell.font = { bold: true }; cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
  for (let c = 2; c <= 7; c += 1) totalRow.getCell(c).numFmt = '$#,##0';

  return workbook.xlsx.writeBuffer();
};

/* ══════════════════════════════════════════════════════════════════
   9) BALANCE DE COMPROBACIÓN COMPARATIVO
   ══════════════════════════════════════════════════════════════════ */
const generateTrialBalanceComparativeExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Balance Comparativo', { views: [{ state: 'frozen', ySplit: 6 }] });

  sheet.columns = [
    { key: 'code', width: 12 },
    { key: 'name', width: 34 },
    { key: 'current', width: 16 },
    { key: 'prior', width: 16 },
    { key: 'variance', width: 16 },
    { key: 'pct', width: 12 },
  ];

  addHeader(sheet, {
    title: 'BALANCE DE COMPROBACIÓN COMPARATIVO',
    tenant,
    subtitle: `Actual: ${fmtDate(data.from)} a ${fmtDate(data.to)}  ·  Anterior: ${fmtDate(data.compare_from)} a ${fmtDate(data.compare_to)}`,
    generatedByName,
    mergeCols: 'F',
  });

  let r = 6;
  const headerRow = sheet.getRow(r);
  headerRow.values = ['Código', 'Cuenta', 'Periodo Actual', 'Periodo Anterior', 'Variación', 'Var. %'];
  styleHeaderRow(headerRow);
  r += 1;

  data.accounts.forEach((a, idx) => {
    const row = sheet.getRow(r);
    row.values = [a.code, a.name, a.current_balance, a.prior_balance, a.variance, a.variance_pct === null ? '' : a.variance_pct / 100];
    row.getCell(3).numFmt = '$#,##0';
    row.getCell(4).numFmt = '$#,##0';
    row.getCell(5).numFmt = '$#,##0';
    row.getCell(6).numFmt = '0.0%';
    if (a.variance < 0) row.getCell(5).font = { color: { argb: REDAMT } };
    else if (a.variance > 0) row.getCell(5).font = { color: { argb: GREEN } };
    zebraStripe(row, idx);
    r += 1;
  });

  return workbook.xlsx.writeBuffer();
};

/* ══════════════════════════════════════════════════════════════════
   10) CERTIFICADO / REPORTE DE RETENCIONES (ReteFuente, ReteICA)
   ══════════════════════════════════════════════════════════════════ */
const generateWithholdingExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Retenciones');
  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'customer', width: 30 },
    { key: 'base', width: 16 },
    { key: 'retefuente', width: 16 },
    { key: 'reteica', width: 16 },
    { key: 'entry', width: 14 },
  ];
  const entryRows = addEntryDetailSheet(workbook, data.entry_details, {
    tenant,
    subtitle: `Retenciones · ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
  });

  addHeader(sheet, {
    title: 'CERTIFICADO DE RETENCIONES',
    tenant,
    subtitle: `Periodo: ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
    mergeCols: 'G',
  });

  let r = 6;
  const headerRow = sheet.getRow(r);
  headerRow.values = ['Fecha', 'N° Venta', 'Cliente', 'Base', 'ReteFuente', 'ReteICA', 'N° Asiento'];
  styleHeaderRow(headerRow);
  r += 1;

  data.sales.forEach((s, idx) => {
    const row = sheet.getRow(r);
    row.values = [
      toExcelDate(s.sale_date), s.sale_number, s.customer_name, s.subtotal, s.retefuente_amount, s.reteica_amount,
      s.entry_id ? entryNumberCell(s.entry_number, s.entry_id, entryRows) : '',
    ];
    styleLinkCell(row.getCell(7));
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(4).numFmt = '$#,##0';
    row.getCell(5).numFmt = '$#,##0';
    row.getCell(6).numFmt = '$#,##0';
    zebraStripe(row, idx);
    r += 1;
  });

  const totalRow = sheet.getRow(r);
  totalRow.values = ['', '', 'TOTAL', data.totals.base, data.totals.retefuente, data.totals.reteica];
  totalRow.eachCell((cell) => { cell.font = { bold: true }; cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });
  totalRow.getCell(4).numFmt = '$#,##0';
  totalRow.getCell(5).numFmt = '$#,##0';
  totalRow.getCell(6).numFmt = '$#,##0';

  return workbook.xlsx.writeBuffer();
};

/* ══════════════════════════════════════════════════════════════════
   11) ESTADO DE FLUJO DE EFECTIVO — MÉTODO INDIRECTO
   ══════════════════════════════════════════════════════════════════ */
const generateCashFlowIndirectExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Flujo de Efectivo');
  sheet.columns = [{ key: 'label', width: 42 }, { key: 'value', width: 18 }];

  addHeader(sheet, {
    title: 'ESTADO DE FLUJO DE EFECTIVO (MÉTODO INDIRECTO)',
    tenant,
    subtitle: `Periodo: ${fmtDate(data.from)} a ${fmtDate(data.to)}`,
    generatedByName,
    mergeCols: 'B',
  });

  let r = 6;
  const section = (label) => {
    sheet.mergeCells(`A${r}:B${r}`);
    const cell = sheet.getCell(`A${r}`);
    cell.value = label;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    r += 1;
  };
  const line = (label, value, bold = false) => {
    const row = sheet.getRow(r);
    row.values = [label, Number(value)];
    row.getCell(2).numFmt = '$#,##0';
    if (bold) { row.getCell(1).font = { bold: true }; row.getCell(2).font = { bold: true }; }
    r += 1;
  };

  section('ACTIVIDADES DE OPERACIÓN');
  line('Utilidad neta del período', data.net_income);
  data.operating.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
  line('Efectivo neto de operación', data.operating.total, true);
  r += 1;

  section('ACTIVIDADES DE INVERSIÓN');
  if (data.investing.changes.length === 0) line('Sin movimientos', 0);
  data.investing.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
  line('Efectivo neto de inversión', data.investing.total, true);
  r += 1;

  section('ACTIVIDADES DE FINANCIACIÓN');
  if (data.financing.changes.length === 0) line('Sin movimientos', 0);
  data.financing.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
  line('Efectivo neto de financiación', data.financing.total, true);
  r += 1;

  line('FLUJO DE EFECTIVO NETO DEL PERÍODO', data.net_cash_flow, true);
  line('Efectivo al inicio', data.cash.opening);
  line('Efectivo al final', data.cash.closing);
  r += 1;
  line(data.cash.matches ? 'Cuadre: coincide con la variación real de caja' : 'Diferencia sin explicar (revisar cuentas)', data.cash.difference);

  sheet.getCell(`A${r}`).value = data.methodology_note;
  sheet.mergeCells(`A${r}:B${r}`);
  sheet.getCell(`A${r}`).font = { italic: true, size: 8, color: { argb: 'FF6B7280' } };
  sheet.getCell(`A${r}`).alignment = { wrapText: true };

  return workbook.xlsx.writeBuffer();
};

/* ══════════════════════════════════════════════════════════════════
   12) RETENCIONES PRACTICADAS A PROVEEDORES — POR CONCEPTO
   data = withholdingPracticed.controller.fetchWithholdingPracticed (+ entry_details)
   ══════════════════════════════════════════════════════════════════ */
const generateWithholdingPracticedExcel = async (data, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const single = data.supplier_id && data.by_supplier.length === 1;
  const period = `Periodo: ${fmtDate(data.from)} a ${fmtDate(data.to)}`;
  const rateLabel = (x) => `${x.rate}${x.rate_unit}`;
  const money = (row, cols) => cols.forEach((c) => { row.getCell(c).numFmt = '$#,##0'; });
  const boldTotal = (row) => row.eachCell((cell) => { cell.font = { bold: true }; cell.border = { top: { style: 'thin', color: { argb: 'FFD1D5DB' } } }; });

  // ── Hoja 1: resumen por concepto ──
  const summary = workbook.addWorksheet('Por concepto', { views: [{ state: 'frozen', ySplit: 6 }] });
  summary.columns = [
    { width: 14 }, { width: 40 }, { width: 10 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 12 },
  ];
  addHeader(summary, {
    title: single ? `RETENCIONES PRACTICADAS — ${data.by_supplier[0].supplier_name}` : 'RETENCIONES PRACTICADAS A PROVEEDORES',
    tenant,
    subtitle: `${period}${single && data.by_supplier[0].supplier_tax_id ? '  ·  NIT proveedor: ' + data.by_supplier[0].supplier_tax_id : ''}`,
    generatedByName,
    mergeCols: 'G',
  });
  let r = 6;
  const sh = summary.getRow(r);
  sh.values = ['Tipo', 'Concepto', 'Tarifa', 'Base', 'Valor retenido', 'Documentos', 'Proveedores'];
  styleHeaderRow(sh);
  r += 1;

  if (data.by_concept.length === 0) {
    summary.mergeCells(`A${r}:G${r}`);
    summary.getCell(`A${r}`).value = 'Sin retenciones practicadas en el periodo seleccionado.';
    r += 1;
  }
  // Agrupado por tipo con subtotal (es como se diligencia el Formulario 350).
  for (const code of ['07', '05', '06']) {
    const group = data.by_concept.filter((c) => c.code === code);
    if (group.length === 0) continue;
    group.forEach((c, idx) => {
      const row = summary.getRow(r);
      row.values = [c.type_name, c.concept, rateLabel(c), c.base, c.amount, c.documents, c.suppliers];
      money(row, [4, 5]);
      zebraStripe(row, idx);
      r += 1;
    });
    const sub = summary.getRow(r);
    sub.values = ['', `Subtotal ${group[0].type_name}`, '', group.reduce((s, c) => s + c.base, 0), group.reduce((s, c) => s + c.amount, 0)];
    money(sub, [4, 5]);
    boldTotal(sub);
    r += 2;
  }
  const tot = summary.getRow(r);
  tot.values = ['', 'TOTAL RETENCIONES PRACTICADAS', '', '', data.totals.total];
  money(tot, [5]);
  tot.getCell(2).font = { bold: true, color: { argb: RED } };
  tot.getCell(5).font = { bold: true, color: { argb: RED } };

  // ── Hoja 2: por proveedor → concepto (base del certificado) ──
  const bySup = workbook.addWorksheet('Por proveedor', { views: [{ state: 'frozen', ySplit: 6 }] });
  bySup.columns = [{ width: 34 }, { width: 16 }, { width: 14 }, { width: 38 }, { width: 10 }, { width: 18 }, { width: 18 }];
  addHeader(bySup, { title: 'RETENCIONES PRACTICADAS POR PROVEEDOR', tenant, subtitle: period, generatedByName, mergeCols: 'G' });
  r = 6;
  const bh = bySup.getRow(r);
  bh.values = ['Proveedor', 'NIT', 'Tipo', 'Concepto', 'Tarifa', 'Base', 'Valor retenido'];
  styleHeaderRow(bh);
  r += 1;
  for (const s of data.by_supplier) {
    s.concepts.forEach((c, idx) => {
      const row = bySup.getRow(r);
      row.values = [idx === 0 ? s.supplier_name : '', idx === 0 ? s.supplier_tax_id : '', c.type_name, c.concept, rateLabel(c), c.base, c.amount];
      money(row, [6, 7]);
      r += 1;
    });
    const sub = bySup.getRow(r);
    sub.values = ['', '', '', `Total ${s.supplier_name}`, '', '', s.totals.total];
    money(sub, [7]);
    boldTotal(sub);
    r += 2;
  }

  // ── Hoja 3: detalle por documento ──
  const det = workbook.addWorksheet('Detalle', { views: [{ state: 'frozen', ySplit: 6 }] });
  det.columns = [
    { width: 12 }, { width: 10 }, { width: 14 }, { width: 22 }, { width: 30 }, { width: 16 },
    { width: 12 }, { width: 36 }, { width: 10 }, { width: 16 }, { width: 16 }, { width: 14 },
  ];
  addHeader(det, { title: 'DETALLE DE RETENCIONES PRACTICADAS', tenant, subtitle: period, generatedByName, mergeCols: 'L' });
  const entryRows = addEntryDetailSheet(workbook, data.entry_details, {
    tenant, subtitle: `Retenciones practicadas · ${fmtDate(data.from)} a ${fmtDate(data.to)}`, generatedByName,
  });
  r = 6;
  const dh = det.getRow(r);
  dh.values = ['Fecha', 'Origen', 'N° Documento', 'Factura / Detalle', 'Proveedor', 'NIT', 'Tipo', 'Concepto', 'Tarifa', 'Base', 'Valor retenido', 'N° Asiento'];
  styleHeaderRow(dh);
  r += 1;
  data.lines.forEach((l, idx) => {
    const row = det.getRow(r);
    row.values = [
      toExcelDate(l.doc_date), l.source === 'purchase' ? 'Compra' : 'Gasto', l.doc_number, l.doc_reference,
      l.supplier_name, l.supplier_tax_id, l.type_name, l.concept, rateLabel(l), l.base, l.amount,
      l.entry_id ? entryNumberCell(l.entry_number, l.entry_id, entryRows) : '',
    ];
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    money(row, [10, 11]);
    styleLinkCell(row.getCell(12));
    zebraStripe(row, idx);
    r += 1;
  });
  if (data.lines.length > 0) {
    det.autoFilter = { from: 'A6', to: `L${r - 1}` };
    const dt = det.getRow(r);
    dt.values = ['', '', '', '', '', '', '', 'TOTAL', '', '', data.totals.total];
    money(dt, [11]);
    boldTotal(dt);
  }

  return workbook.xlsx.writeBuffer();
};

module.exports = {
  generateWithholdingPracticedExcel,
  generateTrialBalanceExcel,
  generateBalanceGeneralExcel,
  generateIncomeStatementExcel,
  generateLibroDiarioExcel,
  generateLibroMayorExcel,
  generateLibroAuxiliarExcel,
  generateLibroIvaExcel,
  generateAgingExcel,
  generateTrialBalanceComparativeExcel,
  generateWithholdingExcel,
  generateCashFlowIndirectExcel,
};
