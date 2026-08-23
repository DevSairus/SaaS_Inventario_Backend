// backend/src/services/excelService.js
const ExcelJS = require('exceljs');

const SOURCE_LABELS = {
  sale: 'Venta',
  purchase: 'Compra',
  expense: 'Gasto',
  work_order: 'Abono OT',
  customer_advance: 'Anticipo recibido',
  customer_advance_refund: 'Devolución anticipo',
};

// Los valores ya vienen como 'YYYY-MM-DD' (fecha de negocio, sin hora).
// Se convierten a Date usando componentes UTC explícitos para que Excel
// muestre el mismo día sin importar la zona horaria de quien lo abra.
function toExcelDate(isoDateStr) {
  if (!isoDateStr) return null;
  const [y, m, d] = isoDateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Genera el cuadre de caja en Excel.
 * cashFlow = { summary: {total_in, total_out, net, total_transactions},
 *              by_day: [...], transactions: [...] } — misma forma que
 * devuelve GET /api/cashflow (usar `allTransactions`, sin recortar a 100).
 * Devuelve un Buffer listo para enviar como descarga.
 */
const generateCashFlowExcel = async (cashFlow, tenant, filters = {}, generatedByName = '') => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = tenant?.company_name || 'Pitbox';
  workbook.created = new Date();

  const RED = 'FF8B0000';
  const GREEN = 'FF059669';
  const REDAMT = 'FFDC2626';
  const DARK = 'FF374151';
  const LIGHT = 'FFF9FAFB';
  const WHITE = 'FFFFFFFF';

  const sheet = workbook.addWorksheet('Cuadre de Caja', {
    views: [{ state: 'frozen', ySplit: 9 }] // congela encabezado + resumen
  });

  sheet.columns = [
    { key: 'date', width: 13 },
    { key: 'type', width: 10 },
    { key: 'source', width: 10 },
    { key: 'reference', width: 16 },
    { key: 'detail', width: 32 },
    { key: 'method', width: 14 },
    { key: 'amount', width: 16 },
  ];

  /* ── TÍTULO Y METADATOS ──────────────────────────────────── */
  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `CUADRE DE CAJA — ${tenant?.company_name || ''}`;
  titleCell.font = { bold: true, size: 14, color: { argb: RED } };

  sheet.mergeCells('A2:G2');
  sheet.getCell('A2').value =
    `Periodo: ${filters.from_date || 'inicio'} a ${filters.to_date || 'hoy'}`;
  sheet.getCell('A2').font = { size: 10, color: { argb: DARK } };

  sheet.mergeCells('A3:G3');
  sheet.getCell('A3').value =
    `Generado: ${new Date().toLocaleString('es-CO')}${generatedByName ? ' · ' + generatedByName : ''}`;
  sheet.getCell('A3').font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };

  /* ── RESUMEN ──────────────────────────────────────────────── */
  const summary = cashFlow.summary || { total_in: 0, total_out: 0, net: 0 };

  sheet.getCell('A5').value = 'Entradas';
  sheet.getCell('B5').value = summary.total_in;
  sheet.getCell('A6').value = 'Salidas';
  sheet.getCell('B6').value = summary.total_out;
  sheet.getCell('A7').value = 'Neto del periodo';
  sheet.getCell('B7').value = summary.net;

  ['B5', 'B6', 'B7'].forEach(ref => {
    sheet.getCell(ref).numFmt = '$#,##0';
    sheet.getCell(ref).font = { bold: true };
  });
  sheet.getCell('B5').font = { bold: true, color: { argb: GREEN } };
  sheet.getCell('B6').font = { bold: true, color: { argb: REDAMT } };
  sheet.getCell('B7').font = { bold: true, color: { argb: summary.net >= 0 ? GREEN : REDAMT } };
  ['A5', 'A6', 'A7'].forEach(ref => { sheet.getCell(ref).font = { bold: true, color: { argb: DARK } }; });

  /* ── ENCABEZADO DE TABLA (fila 9) ─────────────────────────── */
  const headerRow = sheet.getRow(9);
  headerRow.values = ['Fecha', 'Tipo', 'Origen', 'Referencia', 'Detalle', 'Método', 'Monto'];
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    cell.alignment = { vertical: 'middle' };
  });

  /* ── FILAS DE MOVIMIENTOS ────────────────────────────────── */
  const transactions = [...(cashFlow.transactions || [])].sort(
    (a, b) => (a.date || '').localeCompare(b.date || '')
  );

  transactions.forEach((t, idx) => {
    const row = sheet.getRow(10 + idx);
    row.values = [
      toExcelDate(t.date),
      t.direction === 'in' ? 'Entrada' : 'Salida',
      SOURCE_LABELS[t.source] || t.source || '—',
      t.reference || '—',
      t.detail || '—',
      t.method || '—',
      t.direction === 'in' ? t.amount : -t.amount,
    ];
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(7).numFmt = '$#,##0';
    row.getCell(7).font = { bold: true, color: { argb: t.direction === 'in' ? GREEN : REDAMT } };
    if (idx % 2 === 1) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      });
    }
  });

  const lastRow = 10 + transactions.length;
  if (transactions.length === 0) {
    sheet.getCell(`A${lastRow}`).value = 'Sin movimientos en el periodo seleccionado.';
    sheet.mergeCells(`A${lastRow}:G${lastRow}`);
  }

  // Autofiltro sobre la tabla de movimientos
  if (transactions.length > 0) {
    sheet.autoFilter = { from: 'A9', to: `G${lastRow - 1}` };
  }

  return workbook.xlsx.writeBuffer();
};

module.exports = { generateCashFlowExcel };
