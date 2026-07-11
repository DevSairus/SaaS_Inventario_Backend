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
      m.entry_number,
      m.description,
      Number(m.debit),
      Number(m.credit),
      Number(m.running_balance),
    ];
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

  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'number', width: 14 },
    { key: 'account', width: 28 },
    { key: 'detail', width: 32 },
    { key: 'debit', width: 16 },
    { key: 'credit', width: 16 },
    { key: 'balance', width: 18 },
  ];

  const tpLabel = data.third_party?.type === 'customer' ? 'Cliente' : 'Proveedor';
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
      m.entry_number,
      `${m.account_code} - ${m.account_name}`,
      m.description,
      Number(m.debit),
      Number(m.credit),
      Number(m.running_balance),
    ];
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
        sheetRow.values = [toExcelDate(row.entry_date), row.entry_number, row.source_type, row.description, Number(row.amount)];
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

module.exports = {
  generateTrialBalanceExcel,
  generateBalanceGeneralExcel,
  generateIncomeStatementExcel,
  generateLibroDiarioExcel,
  generateLibroMayorExcel,
  generateLibroAuxiliarExcel,
  generateLibroIvaExcel,
};
