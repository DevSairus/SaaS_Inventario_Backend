// backend/src/services/accounting/reportsPdf.service.js
const PDFDocument = require('pdfkit');
const https = require('https');
const http = require('http');

/* ── PALETA (misma que el resto de los PDF del sistema) ──────────── */
const red = '#8b0000';
const gray = '#6b7280';
const darkGray = '#374151';
const softGray = '#f9fafb';
const border = '#e5e7eb';
const borderMd = '#d1d5db';
const black = '#111827';
const green = '#059669';
const redAmt = '#dc2626';
const white = '#ffffff';
const indigo = '#4f46e5';

const downloadImage = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      })
      .on('error', reject);
  });

function fmtDate(isoDateStr) {
  if (!isoDateStr) return '—';
  const [y, m, d] = isoDateStr.split('-');
  if (!y || !m || !d) return isoDateStr;
  return `${d}/${m}/${y}`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value || 0);
}

/**
 * Crea el documento, dibuja el encabezado común (logo, razón social, NIT,
 * título del reporte, período, generado por) y devuelve { doc, y } listo
 * para que cada reporte siga dibujando su tabla desde ahí.
 */
async function startReportDoc(res, { title, subtitle, filenamePrefix, tenant, generatedByName }) {
  const bufferMode = !res;
  let bufferPromise = null;
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

  if (!bufferMode) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filenamePrefix}.pdf"`);
    doc.pipe(res);
  } else {
    const chunks = [];
    bufferPromise = new Promise((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
  }

  const PAGE_W = doc.page.width;
  const MARGIN = 40;
  const INNER_W = PAGE_W - MARGIN * 2;

  const drawTopBar = () => doc.rect(0, 0, PAGE_W, 5).fill(red);
  drawTopBar();

  let y = 20;

  if (tenant?.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      const src = await downloadImage(tenant.logo_url);
      doc.image(src, MARGIN, y, { fit: [70, 36], align: 'left', valign: 'center' });
    } catch (e) { /* sin logo */ }
  }

  doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray)
    .text(tenant?.company_name || 'Empresa', MARGIN + 80, y, { width: INNER_W - 240 });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(tenant?.tax_id ? `NIT: ${tenant.tax_id}` : '', MARGIN + 80, y + 13, { width: INNER_W - 240 });

  doc.font('Helvetica-Bold').fontSize(15).fillColor(red)
    .text(title, MARGIN, y, { width: INNER_W, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(gray)
    .text(subtitle, MARGIN, y + 18, { width: INNER_W, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`Generado: ${new Date().toLocaleString('es-CO')}${generatedByName ? ' · ' + generatedByName : ''}`,
      MARGIN, y + 30, { width: INNER_W, align: 'right' });

  y += 55;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.5).stroke();
  y += 16;

  return { doc, y, MARGIN, INNER_W, PAGE_W, drawTopBar, bufferMode, bufferPromise };
}

function finishReportDoc({ doc, PAGE_W, MARGIN, INNER_W, red: _red, bufferMode, bufferPromise }) {
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(i);
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(red);
    doc.font('Helvetica').fontSize(7).fillColor(gray)
      .text(`Página ${i + 1} de ${pageRange.count}`, MARGIN, doc.page.height - 24, { width: INNER_W, align: 'center' });
  }
  doc.end();
  return bufferMode ? bufferPromise : null;
}

function ensureSpace(ctx, needed, redrawHeader) {
  if (ctx.y + needed > 740) {
    ctx.doc.addPage();
    ctx.drawTopBar();
    ctx.y = 40;
    if (redrawHeader) redrawHeader();
  }
}

/* ══════════════════════════════════════════════════════════════════
   1) BALANCE DE COMPROBACIÓN
   ══════════════════════════════════════════════════════════════════ */
const generateTrialBalancePDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'BALANCE DE COMPROBACIÓN',
      subtitle: `Periodo: ${fmtDate(filters.from)} — ${fmtDate(filters.to)}`,
      filenamePrefix: `Balance-Comprobacion-${filters.from || ''}_${filters.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { code: MARGIN, name: MARGIN + 55, type: MARGIN + 280, debit: MARGIN + INNER_W - 170, credit: MARGIN + INNER_W - 80 };

    const drawTableHeader = () => {
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 18, 3).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white)
        .text('CÓDIGO', COLS.code + 6, ctx.y + 5)
        .text('CUENTA', COLS.name + 6, ctx.y + 5)
        .text('TIPO', COLS.type + 6, ctx.y + 5)
        .text('DÉBITO', COLS.debit, ctx.y + 5, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text('CRÉDITO', COLS.credit, ctx.y + 5, { width: MARGIN + INNER_W - COLS.credit - 6, align: 'right' });
      ctx.y += 22;
    };

    drawTableHeader();

    const accounts = data.accounts || [];
    if (accounts.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin movimientos contabilizados en el periodo seleccionado.', MARGIN, ctx.y);
      ctx.y += 16;
    }

    accounts.forEach((a, idx) => {
      ensureSpace(ctx, 15, drawTableHeader);
      doc.font('Helvetica').fontSize(7.8).fillColor(black)
        .text(a.code, COLS.code + 6, ctx.y, { width: COLS.name - COLS.code - 8 })
        .text(a.name, COLS.name + 6, ctx.y, { width: COLS.type - COLS.name - 8, ellipsis: true })
        .text(a.account_type, COLS.type + 6, ctx.y, { width: COLS.debit - COLS.type - 8, ellipsis: true })
        .text(formatCurrency(a.total_debit), COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text(formatCurrency(a.total_credit), COLS.credit, ctx.y, { width: MARGIN + INNER_W - COLS.credit - 6, align: 'right' });
      ctx.y += 13;
      if (idx < accounts.length - 1) {
        doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(border).lineWidth(0.3).stroke();
        ctx.y += 4;
      }
    });

    ensureSpace(ctx, 30);
    ctx.y += 10;
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.8).stroke();
    ctx.y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray)
      .text('TOTAL', COLS.type, ctx.y)
      .text(formatCurrency(data.totals?.debit), COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
      .text(formatCurrency(data.totals?.credit), COLS.credit, ctx.y, { width: MARGIN + INNER_W - COLS.credit - 6, align: 'right' });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando balance de comprobación' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   2) BALANCE GENERAL
   ══════════════════════════════════════════════════════════════════ */
const generateBalanceGeneralPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'BALANCE GENERAL',
      subtitle: `Corte al: ${fmtDate(data.as_of)}`,
      filenamePrefix: `Balance-General-${data.as_of || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { code: MARGIN, name: MARGIN + 55, amount: MARGIN + INNER_W - 90 };

    const drawSectionHeader = (label) => {
      ensureSpace(ctx, 24);
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 16, 2).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text(label, MARGIN + 6, ctx.y + 4);
      ctx.y += 20;
    };

    const drawRows = (rows, extras = []) => {
      rows.forEach((a) => {
        ensureSpace(ctx, 14);
        doc.font('Helvetica').fontSize(8).fillColor(black)
          .text(a.code, COLS.code + 4, ctx.y, { width: COLS.name - COLS.code - 4 })
          .text(a.name, COLS.name + 2, ctx.y, { width: COLS.amount - COLS.name - 8, ellipsis: true })
          .text(formatCurrency(a.balance), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 4, align: 'right' });
        ctx.y += 13;
      });
      extras.forEach(([label, value, bold]) => {
        ensureSpace(ctx, 16);
        if (bold) {
          doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
          ctx.y += 4;
        }
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica-Oblique').fontSize(bold ? 9 : 7.8).fillColor(bold ? darkGray : gray)
          .text(label, COLS.name + 2, ctx.y, { width: COLS.amount - COLS.name - 8 })
          .text(formatCurrency(value), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 4, align: 'right' });
        ctx.y += bold ? 16 : 13;
      });
      ctx.y += 8;
    };

    const totales = data.totales || {};

    drawSectionHeader('ACTIVO');
    drawRows(data.activo || [], [['Total Activo', totales.total_activo || 0, true]]);

    drawSectionHeader('PASIVO');
    drawRows(data.pasivo || [], [['Total Pasivo', totales.total_pasivo || 0, true]]);

    drawSectionHeader('PATRIMONIO');
    drawRows(data.patrimonio || [], [
      ['Resultado del ejercicio (no cerrado)', data.resultado_no_cerrado || 0, false],
      ['Total Patrimonio', totales.total_patrimonio || 0, true],
    ]);

    ensureSpace(ctx, 24);
    const cuadra = totales.cuadra;
    doc.roundedRect(MARGIN, ctx.y, INNER_W, 20, 3).fill(cuadra ? '#ecfdf5' : '#fef2f2');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(cuadra ? green : redAmt)
      .text(cuadra ? '✓ El balance cuadra (Activo = Pasivo + Patrimonio)' : '✗ El balance no cuadra — revisar los asientos',
        MARGIN, ctx.y + 6, { width: INNER_W, align: 'center' });
    ctx.y += 20;

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando balance general' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   3) ESTADO DE RESULTADOS (P&G)
   ══════════════════════════════════════════════════════════════════ */
const generateIncomeStatementPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'ESTADO DE RESULTADOS (P&G)',
      subtitle: `Periodo: ${fmtDate(data.from)} — ${fmtDate(data.to)}`,
      filenamePrefix: `Estado-Resultados-${data.from || ''}_${data.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { code: MARGIN, name: MARGIN + 55, amount: MARGIN + INNER_W - 90 };

    const drawSectionHeader = (label) => {
      ensureSpace(ctx, 24);
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 16, 2).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text(label, MARGIN + 6, ctx.y + 4);
      ctx.y += 20;
    };

    const drawRows = (rows, extras = []) => {
      rows.forEach((a) => {
        ensureSpace(ctx, 14);
        doc.font('Helvetica').fontSize(8).fillColor(black)
          .text(a.code, COLS.code + 4, ctx.y, { width: COLS.name - COLS.code - 4 })
          .text(a.name, COLS.name + 2, ctx.y, { width: COLS.amount - COLS.name - 8, ellipsis: true })
          .text(formatCurrency(a.total), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 4, align: 'right' });
        ctx.y += 13;
      });
      extras.forEach(([label, value, color]) => {
        ensureSpace(ctx, 16);
        doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
        ctx.y += 4;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(color || darkGray)
          .text(label, COLS.name + 2, ctx.y, { width: COLS.amount - COLS.name - 8 })
          .text(formatCurrency(value), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 4, align: 'right' });
        ctx.y += 16;
      });
      ctx.y += 8;
    };

    const totales = data.totales || {};

    drawSectionHeader('INGRESOS');
    drawRows(data.ingresos || [], [['Total Ingresos', totales.total_ingresos || 0]]);

    drawSectionHeader('COSTO DE VENTAS');
    drawRows(data.costos || [], [
      ['Total Costos', totales.total_costos || 0],
      ['Utilidad Bruta', totales.utilidad_bruta || 0, indigo],
    ]);

    drawSectionHeader('GASTOS OPERATIVOS');
    const utilidadNeta = totales.utilidad_neta || 0;
    drawRows(data.gastos || [], [
      ['Total Gastos', totales.total_gastos || 0],
      ['Utilidad Neta', utilidadNeta, utilidadNeta >= 0 ? green : redAmt],
    ]);

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando estado de resultados' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   4) LIBRO DIARIO — agrupado por asiento (formato legal para archivo)
   ══════════════════════════════════════════════════════════════════ */
const SOURCE_LABELS = { sale: 'Venta', purchase: 'Compra', expense: 'Gasto', cash_session: 'Cierre de Caja', manual: 'Manual', adjustment: 'Ajuste' };

const generateLibroDiarioPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'LIBRO DIARIO',
      subtitle: `Periodo: ${fmtDate(filters.from)} — ${fmtDate(filters.to)}  ·  ${data.entry_count} asientos, ${data.line_count} líneas`,
      filenamePrefix: `Libro-Diario-${filters.from || ''}_${filters.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { code: MARGIN, account: MARGIN + 45, detail: MARGIN + 220, amount: MARGIN + INNER_W - 160 };

    const entries = data.entries || [];
    if (entries.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin asientos contabilizados en el periodo seleccionado.', MARGIN, ctx.y);
      ctx.y += 16;
    }

    entries.forEach((entry, entryIdx) => {
      const blockHeight = 20 + entry.lines.length * 13 + 14;
      ensureSpace(ctx, blockHeight);

      // Encabezado del asiento
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 16, 2).fill(softGray);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray)
        .text(`${entry.entry_number}`, MARGIN + 6, ctx.y + 4, { width: 90 })
        .text(fmtDate(entry.entry_date), MARGIN + 96, ctx.y + 4, { width: 60 })
        .font('Helvetica').fillColor(gray)
        .text(SOURCE_LABELS[entry.source_type] || entry.source_type || '—', MARGIN + 160, ctx.y + 4, { width: 80 })
        .text(entry.description || '—', MARGIN + 245, ctx.y + 4, { width: INNER_W - 250, ellipsis: true });
      ctx.y += 20;

      entry.lines.forEach((line) => {
        doc.font('Helvetica').fontSize(7.8).fillColor(black)
          .text(line.account_code, COLS.code + 6, ctx.y, { width: COLS.account - COLS.code - 8 })
          .text(line.account_name, COLS.account + 4, ctx.y, { width: COLS.detail - COLS.account - 8, ellipsis: true })
          .text(line.description || '—', COLS.detail + 4, ctx.y, { width: COLS.amount - COLS.detail - 60, ellipsis: true })
          .text(line.debit ? formatCurrency(line.debit) : '—', COLS.amount, ctx.y, { width: 78, align: 'right' })
          .text(line.credit ? formatCurrency(line.credit) : '—', COLS.amount + 80, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 80 - 4, align: 'right' });
        ctx.y += 13;
      });

      // Subtotal del asiento
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(gray)
        .text(`Subtotal: ${formatCurrency(entry.total_debit)} / ${formatCurrency(entry.total_credit)}`,
          COLS.detail + 4, ctx.y, { width: MARGIN + INNER_W - COLS.detail - 8, align: 'right' });
      ctx.y += 14;

      if (entryIdx < entries.length - 1) {
        doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(border).lineWidth(0.3).stroke();
        ctx.y += 6;
      }
    });

    ensureSpace(ctx, 30);
    ctx.y += 10;
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.8).stroke();
    ctx.y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray)
      .text('TOTAL PERIODO', COLS.detail, ctx.y)
      .text(formatCurrency(data.totals?.debit), COLS.amount, ctx.y, { width: 78, align: 'right' })
      .text(formatCurrency(data.totals?.credit), COLS.amount + 80, ctx.y, { width: MARGIN + INNER_W - COLS.amount - 80 - 4, align: 'right' });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando libro diario' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   5) LIBRO MAYOR — movimientos de una cuenta con saldo corrido
   ══════════════════════════════════════════════════════════════════ */
const generateLibroMayorPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'LIBRO MAYOR',
      subtitle: `Cuenta: ${data.account?.code || ''} - ${data.account?.name || ''}  ·  Periodo: ${fmtDate(filters.from)} — ${fmtDate(filters.to)}`,
      filenamePrefix: `Libro-Mayor-${data.account?.code || ''}-${filters.from || ''}_${filters.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = {
      date: MARGIN,
      number: MARGIN + 55,
      detail: MARGIN + 135,
      debit: MARGIN + INNER_W - 220,
      credit: MARGIN + INNER_W - 145,
      balance: MARGIN + INNER_W - 70,
    };

    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(gray)
      .text(`Saldo inicial: ${formatCurrency(data.opening_balance)}`, MARGIN, ctx.y);
    ctx.y += 16;

    const drawTableHeader = () => {
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 18, 3).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white)
        .text('FECHA', COLS.date + 6, ctx.y + 5)
        .text('N° ASIENTO', COLS.number + 6, ctx.y + 5)
        .text('DETALLE', COLS.detail + 6, ctx.y + 5)
        .text('DÉBITO', COLS.debit, ctx.y + 5, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text('CRÉDITO', COLS.credit, ctx.y + 5, { width: COLS.balance - COLS.credit - 8, align: 'right' })
        .text('SALDO', COLS.balance, ctx.y + 5, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });
      ctx.y += 22;
    };

    drawTableHeader();

    const movements = data.movements || [];
    if (movements.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin movimientos en el periodo seleccionado.', MARGIN, ctx.y);
      ctx.y += 16;
    }

    movements.forEach((m, idx) => {
      ensureSpace(ctx, 15, drawTableHeader);
      doc.font('Helvetica').fontSize(7.8).fillColor(black)
        .text(fmtDate(m.entry_date), COLS.date + 6, ctx.y, { width: COLS.number - COLS.date - 8 })
        .text(String(m.entry_number || ''), COLS.number + 6, ctx.y, { width: COLS.detail - COLS.number - 8, ellipsis: true })
        .text(m.description || '—', COLS.detail + 6, ctx.y, { width: COLS.debit - COLS.detail - 8, ellipsis: true })
        .text(m.debit ? formatCurrency(m.debit) : '—', COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text(m.credit ? formatCurrency(m.credit) : '—', COLS.credit, ctx.y, { width: COLS.balance - COLS.credit - 8, align: 'right' })
        .text(formatCurrency(m.running_balance), COLS.balance, ctx.y, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });
      ctx.y += 13;
      if (idx < movements.length - 1) {
        doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(border).lineWidth(0.3).stroke();
        ctx.y += 4;
      }
    });

    ensureSpace(ctx, 30);
    ctx.y += 10;
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.8).stroke();
    ctx.y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray)
      .text('TOTAL PERIODO / SALDO FINAL', COLS.detail, ctx.y)
      .text(formatCurrency(data.totals?.debit), COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
      .text(formatCurrency(data.totals?.credit), COLS.credit, ctx.y, { width: COLS.balance - COLS.credit - 8, align: 'right' })
      .text(formatCurrency(data.closing_balance), COLS.balance, ctx.y, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando libro mayor' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   6) LIBRO AUXILIAR POR TERCERO — movimientos de un cliente/proveedor
   ══════════════════════════════════════════════════════════════════ */
const generateLibroAuxiliarPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const tpLabel = data.third_party?.type === 'customer' ? 'Cliente' : 'Proveedor';
    const ctx = await startReportDoc(res, {
      title: 'LIBRO AUXILIAR POR TERCERO',
      subtitle: `${tpLabel}: ${data.third_party?.name || ''}${data.third_party?.tax_id ? ' - ' + data.third_party.tax_id : ''}  ·  Periodo: ${fmtDate(filters.from)} — ${fmtDate(filters.to)}`,
      filenamePrefix: `Libro-Auxiliar-${data.third_party?.name || ''}-${filters.from || ''}_${filters.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = {
      date: MARGIN,
      number: MARGIN + 55,
      detail: MARGIN + 135,
      debit: MARGIN + INNER_W - 220,
      credit: MARGIN + INNER_W - 145,
      balance: MARGIN + INNER_W - 70,
    };

    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(gray)
      .text(`Saldo inicial: ${formatCurrency(data.opening_balance)}`, MARGIN, ctx.y);
    ctx.y += 16;

    const drawTableHeader = () => {
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 18, 3).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white)
        .text('FECHA', COLS.date + 6, ctx.y + 5)
        .text('N° ASIENTO', COLS.number + 6, ctx.y + 5)
        .text('CUENTA / DETALLE', COLS.detail + 6, ctx.y + 5)
        .text('DÉBITO', COLS.debit, ctx.y + 5, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text('CRÉDITO', COLS.credit, ctx.y + 5, { width: COLS.balance - COLS.credit - 8, align: 'right' })
        .text('SALDO', COLS.balance, ctx.y + 5, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });
      ctx.y += 22;
    };

    drawTableHeader();

    const movements = data.movements || [];
    if (movements.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin movimientos en el periodo seleccionado.', MARGIN, ctx.y);
      ctx.y += 16;
    }

    movements.forEach((m, idx) => {
      ensureSpace(ctx, 15, drawTableHeader);
      doc.font('Helvetica').fontSize(7.8).fillColor(black)
        .text(fmtDate(m.entry_date), COLS.date + 6, ctx.y, { width: COLS.number - COLS.date - 8 })
        .text(String(m.entry_number || ''), COLS.number + 6, ctx.y, { width: COLS.detail - COLS.number - 8, ellipsis: true })
        .text(`${m.account_code} - ${m.description || '—'}`, COLS.detail + 6, ctx.y, { width: COLS.debit - COLS.detail - 8, ellipsis: true })
        .text(m.debit ? formatCurrency(m.debit) : '—', COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
        .text(m.credit ? formatCurrency(m.credit) : '—', COLS.credit, ctx.y, { width: COLS.balance - COLS.credit - 8, align: 'right' })
        .text(formatCurrency(m.running_balance), COLS.balance, ctx.y, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });
      ctx.y += 13;
      if (idx < movements.length - 1) {
        doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(border).lineWidth(0.3).stroke();
        ctx.y += 4;
      }
    });

    ensureSpace(ctx, 30);
    ctx.y += 10;
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.8).stroke();
    ctx.y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray)
      .text('TOTAL PERIODO / SALDO FINAL', COLS.detail, ctx.y)
      .text(formatCurrency(data.totals?.debit), COLS.debit, ctx.y, { width: COLS.credit - COLS.debit - 8, align: 'right' })
      .text(formatCurrency(data.totals?.credit), COLS.credit, ctx.y, { width: COLS.balance - COLS.credit - 8, align: 'right' })
      .text(formatCurrency(data.closing_balance), COLS.balance, ctx.y, { width: MARGIN + INNER_W - COLS.balance - 6, align: 'right' });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando libro auxiliar' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   7) LIBRO DE IVA — IVA generado (ventas) vs IVA descontable (compras)
   ══════════════════════════════════════════════════════════════════ */
const generateLibroIvaPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'LIBRO DE IVA',
      subtitle: `Periodo: ${fmtDate(data.from)} — ${fmtDate(data.to)}`,
      filenamePrefix: `Libro-IVA-${data.from || ''}_${data.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { date: MARGIN, number: MARGIN + 55, source: MARGIN + 135, detail: MARGIN + 195, amount: MARGIN + INNER_W - 80 };

    const drawSectionHeader = (label) => {
      ensureSpace(ctx, 24);
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 16, 2).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text(label, MARGIN + 6, ctx.y + 4);
      ctx.y += 20;
    };

    const drawTableHeader = () => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(gray)
        .text('FECHA', COLS.date, ctx.y)
        .text('N° ASIENTO', COLS.number, ctx.y)
        .text('ORIGEN', COLS.source, ctx.y)
        .text('DETALLE', COLS.detail, ctx.y)
        .text('VALOR', COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount, align: 'right' });
      ctx.y += 12;
    };

    const drawSection = (rows, totalLabel, total) => {
      drawTableHeader();
      if (rows.length === 0) {
        doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin movimientos en el periodo seleccionado.', MARGIN, ctx.y);
        ctx.y += 14;
      }
      rows.forEach((row) => {
        ensureSpace(ctx, 14, drawTableHeader);
        doc.font('Helvetica').fontSize(7.8).fillColor(black)
          .text(fmtDate(row.entry_date), COLS.date, ctx.y, { width: COLS.number - COLS.date - 4 })
          .text(String(row.entry_number || ''), COLS.number, ctx.y, { width: COLS.source - COLS.number - 4, ellipsis: true })
          .text(SOURCE_LABELS[row.source_type] || row.source_type || '—', COLS.source, ctx.y, { width: COLS.detail - COLS.source - 4, ellipsis: true })
          .text(row.description || '—', COLS.detail, ctx.y, { width: COLS.amount - COLS.detail - 8, ellipsis: true })
          .text(formatCurrency(row.amount), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount, align: 'right' });
        ctx.y += 13;
      });
      ensureSpace(ctx, 18);
      doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
      ctx.y += 4;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(darkGray)
        .text(totalLabel, COLS.detail, ctx.y)
        .text(formatCurrency(total), COLS.amount, ctx.y, { width: MARGIN + INNER_W - COLS.amount, align: 'right' });
      ctx.y += 20;
    };

    drawSectionHeader('IVA GENERADO (VENTAS)');
    drawSection(data.generado || [], 'Total IVA Generado', data.totals?.generado);

    drawSectionHeader('IVA DESCONTABLE (COMPRAS)');
    drawSection(data.descontable || [], 'Total IVA Descontable', data.totals?.descontable);

    ensureSpace(ctx, 26);
    const ivaAPagar = data.totals?.iva_a_pagar || 0;
    doc.roundedRect(MARGIN, ctx.y, INNER_W, 22, 3).fill(ivaAPagar >= 0 ? '#fef2f2' : '#ecfdf5');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ivaAPagar >= 0 ? redAmt : green)
      .text(ivaAPagar >= 0 ? 'IVA A PAGAR' : 'SALDO A FAVOR', MARGIN + 10, ctx.y + 6)
      .text(formatCurrency(ivaAPagar), MARGIN, ctx.y + 6, { width: INNER_W - 10, align: 'right' });
    ctx.y += 22;

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando libro de IVA' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   8) ANTIGÜEDAD DE CARTERA / CUENTAS POR PAGAR (aging)
   ══════════════════════════════════════════════════════════════════ */
const generateAgingPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const label = data.type === 'customer' ? 'Cartera (Clientes)' : 'Cuentas por Pagar (Proveedores)';
    const ctx = await startReportDoc(res, {
      title: `ANTIGÜEDAD DE SALDOS`,
      subtitle: `${label} · Corte al: ${fmtDate(data.as_of)}`,
      filenamePrefix: `Antiguedad-${data.type}-${data.as_of || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const bucketW = (INNER_W - 150) / 5;
    const COLS = { name: MARGIN, b0: MARGIN + 150, b1: MARGIN + 150 + bucketW, b2: MARGIN + 150 + bucketW * 2, b3: MARGIN + 150 + bucketW * 3, b4: MARGIN + 150 + bucketW * 4 };

    const drawTableHeader = () => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(gray)
        .text('TERCERO', COLS.name, ctx.y)
        .text('SIN VENCER', COLS.b0, ctx.y, { width: bucketW - 4, align: 'right' })
        .text('1-30', COLS.b1, ctx.y, { width: bucketW - 4, align: 'right' })
        .text('31-60', COLS.b2, ctx.y, { width: bucketW - 4, align: 'right' })
        .text('61-90', COLS.b3, ctx.y, { width: bucketW - 4, align: 'right' })
        .text('+90 / TOTAL', COLS.b4, ctx.y, { width: bucketW - 4, align: 'right' });
      ctx.y += 12;
    };

    drawTableHeader();
    if (data.third_parties.length === 0) {
      doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin saldos abiertos a la fecha de corte.', MARGIN, ctx.y);
      ctx.y += 14;
    }
    data.third_parties.forEach((tp) => {
      ensureSpace(ctx, 14, drawTableHeader);
      doc.font('Helvetica').fontSize(7.8).fillColor(black)
        .text(tp.name, COLS.name, ctx.y, { width: COLS.b0 - COLS.name - 4, ellipsis: true })
        .text(formatCurrency(tp.buckets.current), COLS.b0, ctx.y, { width: bucketW - 4, align: 'right' })
        .text(formatCurrency(tp.buckets.d1_30), COLS.b1, ctx.y, { width: bucketW - 4, align: 'right' })
        .text(formatCurrency(tp.buckets.d31_60), COLS.b2, ctx.y, { width: bucketW - 4, align: 'right' })
        .text(formatCurrency(tp.buckets.d61_90), COLS.b3, ctx.y, { width: bucketW - 4, align: 'right' })
        .text(formatCurrency(tp.buckets.d90_plus), COLS.b4, ctx.y, { width: bucketW - 4, align: 'right' });
      ctx.y += 11;
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(darkGray)
        .text(`Total ${formatCurrency(tp.total)}`, COLS.b4, ctx.y, { width: bucketW - 4, align: 'right' });
      ctx.y += 12;
    });

    ensureSpace(ctx, 20);
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
    ctx.y += 6;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(`TOTAL GENERAL: ${formatCurrency(data.grand_total)}`, MARGIN, ctx.y, { width: INNER_W, align: 'right' });
    ctx.y += 16;

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando reporte de antigüedad' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   9) BALANCE DE COMPROBACIÓN COMPARATIVO
   ══════════════════════════════════════════════════════════════════ */
const generateTrialBalanceComparativePDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'BALANCE COMPARATIVO',
      subtitle: `Actual: ${fmtDate(data.from)}—${fmtDate(data.to)}  ·  Anterior: ${fmtDate(data.compare_from)}—${fmtDate(data.compare_to)}`,
      filenamePrefix: `Balance-Comparativo-${data.from || ''}_${data.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { code: MARGIN, name: MARGIN + 45, current: MARGIN + 220, prior: MARGIN + 300, variance: MARGIN + 380, pct: MARGIN + INNER_W - 45 };

    const drawTableHeader = () => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(gray)
        .text('CÓDIGO', COLS.code, ctx.y)
        .text('CUENTA', COLS.name, ctx.y)
        .text('ACTUAL', COLS.current, ctx.y, { width: 75, align: 'right' })
        .text('ANTERIOR', COLS.prior, ctx.y, { width: 75, align: 'right' })
        .text('VARIACIÓN', COLS.variance, ctx.y, { width: 75, align: 'right' })
        .text('VAR %', COLS.pct, ctx.y, { width: 45, align: 'right' });
      ctx.y += 12;
    };

    drawTableHeader();
    data.accounts.forEach((a) => {
      ensureSpace(ctx, 13, drawTableHeader);
      const varianceColor = a.variance < 0 ? redAmt : a.variance > 0 ? green : black;
      doc.font('Helvetica').fontSize(7.5).fillColor(black)
        .text(a.code, COLS.code, ctx.y, { width: 40 })
        .text(a.name, COLS.name, ctx.y, { width: COLS.current - COLS.name - 4, ellipsis: true })
        .text(formatCurrency(a.current_balance), COLS.current, ctx.y, { width: 75, align: 'right' })
        .text(formatCurrency(a.prior_balance), COLS.prior, ctx.y, { width: 75, align: 'right' });
      doc.fillColor(varianceColor)
        .text(formatCurrency(a.variance), COLS.variance, ctx.y, { width: 75, align: 'right' })
        .text(a.variance_pct === null ? '—' : `${a.variance_pct.toFixed(1)}%`, COLS.pct, ctx.y, { width: 45, align: 'right' });
      ctx.y += 12;
    });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando balance comparativo' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   10) CERTIFICADO / REPORTE DE RETENCIONES
   ══════════════════════════════════════════════════════════════════ */
const generateWithholdingPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const single = data.customer_id && data.customers.length === 1;
    const ctx = await startReportDoc(res, {
      title: single ? 'CERTIFICADO DE RETENCIONES' : 'REPORTE DE RETENCIONES',
      subtitle: `${single ? data.customers[0].customer_name + ' · ' : ''}Periodo: ${fmtDate(data.from)} — ${fmtDate(data.to)}`,
      filenamePrefix: `Retenciones-${data.from || ''}_${data.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const COLS = { date: MARGIN, number: MARGIN + 55, customer: MARGIN + 120, base: MARGIN + INNER_W - 220, retefuente: MARGIN + INNER_W - 145, reteica: MARGIN + INNER_W - 70 };

    const drawTableHeader = () => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(gray)
        .text('FECHA', COLS.date, ctx.y)
        .text('N° VENTA', COLS.number, ctx.y)
        .text(single ? '' : 'CLIENTE', COLS.customer, ctx.y)
        .text('BASE', COLS.base, ctx.y, { width: 70, align: 'right' })
        .text('RETEFUENTE', COLS.retefuente, ctx.y, { width: 70, align: 'right' })
        .text('RETEICA', COLS.reteica, ctx.y, { width: MARGIN + INNER_W - COLS.reteica, align: 'right' });
      ctx.y += 12;
    };

    drawTableHeader();
    if (data.sales.length === 0) {
      doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin ventas con retención en el periodo seleccionado.', MARGIN, ctx.y);
      ctx.y += 14;
    }
    data.sales.forEach((s) => {
      ensureSpace(ctx, 13, drawTableHeader);
      doc.font('Helvetica').fontSize(7.5).fillColor(black)
        .text(fmtDate(s.sale_date), COLS.date, ctx.y, { width: 50 })
        .text(s.sale_number || '', COLS.number, ctx.y, { width: COLS.customer - COLS.number - 4, ellipsis: true })
        .text(single ? '' : s.customer_name, COLS.customer, ctx.y, { width: COLS.base - COLS.customer - 4, ellipsis: true })
        .text(formatCurrency(s.subtotal), COLS.base, ctx.y, { width: 70, align: 'right' })
        .text(formatCurrency(s.retefuente_amount), COLS.retefuente, ctx.y, { width: 70, align: 'right' })
        .text(formatCurrency(s.reteica_amount), COLS.reteica, ctx.y, { width: MARGIN + INNER_W - COLS.reteica, align: 'right' });
      ctx.y += 12;
    });

    ensureSpace(ctx, 22);
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
    ctx.y += 6;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray)
      .text(`Base: ${formatCurrency(data.totals.base)}   ·   ReteFuente: ${formatCurrency(data.totals.retefuente)}   ·   ReteICA: ${formatCurrency(data.totals.reteica)}`,
        MARGIN, ctx.y, { width: INNER_W, align: 'right' });
    ctx.y += 20;

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando reporte de retenciones' });
    if (!res) throw error;
  }
};

/* ══════════════════════════════════════════════════════════════════
   11) ESTADO DE FLUJO DE EFECTIVO — MÉTODO INDIRECTO
   ══════════════════════════════════════════════════════════════════ */
const generateCashFlowIndirectPDF = async (res, data, tenant, filters = {}, generatedByName = '') => {
  try {
    const ctx = await startReportDoc(res, {
      title: 'FLUJO DE EFECTIVO (INDIRECTO)',
      subtitle: `Periodo: ${fmtDate(data.from)} — ${fmtDate(data.to)}`,
      filenamePrefix: `Flujo-Efectivo-Indirecto-${data.from || ''}_${data.to || ''}`,
      tenant,
      generatedByName,
    });
    const { doc, MARGIN, INNER_W } = ctx;

    const sectionHeader = (label) => {
      ensureSpace(ctx, 20);
      doc.roundedRect(MARGIN, ctx.y, INNER_W, 16, 2).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text(label, MARGIN + 6, ctx.y + 4);
      ctx.y += 20;
    };
    const line = (label, value, bold = false) => {
      ensureSpace(ctx, 12);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).fillColor(bold ? darkGray : black)
        .text(label, MARGIN, ctx.y, { width: INNER_W - 100 })
        .text(formatCurrency(value), MARGIN, ctx.y, { width: INNER_W, align: 'right' });
      ctx.y += bold ? 14 : 12;
    };

    sectionHeader('ACTIVIDADES DE OPERACIÓN');
    line('Utilidad neta del período', data.net_income);
    data.operating.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
    line('Efectivo neto de operación', data.operating.total, true);

    sectionHeader('ACTIVIDADES DE INVERSIÓN');
    if (data.investing.changes.length === 0) line('Sin movimientos', 0);
    data.investing.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
    line('Efectivo neto de inversión', data.investing.total, true);

    sectionHeader('ACTIVIDADES DE FINANCIACIÓN');
    if (data.financing.changes.length === 0) line('Sin movimientos', 0);
    data.financing.changes.forEach((c) => line(`  Δ ${c.code} - ${c.name}`, c.cash_impact));
    line('Efectivo neto de financiación', data.financing.total, true);

    ensureSpace(ctx, 30);
    doc.moveTo(MARGIN, ctx.y).lineTo(MARGIN + INNER_W, ctx.y).strokeColor(borderMd).lineWidth(0.5).stroke();
    ctx.y += 6;
    line('FLUJO DE EFECTIVO NETO DEL PERÍODO', data.net_cash_flow, true);
    line('Efectivo al inicio', data.cash.opening);
    line('Efectivo al final', data.cash.closing);

    ensureSpace(ctx, 24);
    doc.roundedRect(MARGIN, ctx.y, INNER_W, 18, 3).fill(data.cash.matches ? '#ecfdf5' : '#fef2f2');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(data.cash.matches ? green : redAmt)
      .text(data.cash.matches ? 'Cuadra con la variación real de caja' : `Diferencia sin explicar: ${formatCurrency(data.cash.difference)}`,
        MARGIN + 8, ctx.y + 5);
    ctx.y += 24;

    doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(gray).text(data.methodology_note, MARGIN, ctx.y, { width: INNER_W });

    return finishReportDoc(ctx);
  } catch (error) {
    console.error(error);
    if (res && !res.headersSent) res.status(500).json({ message: 'Error generando flujo de efectivo indirecto' });
    if (!res) throw error;
  }
};

module.exports = {
  generateTrialBalancePDF,
  generateBalanceGeneralPDF,
  generateIncomeStatementPDF,
  generateLibroDiarioPDF,
  generateLibroMayorPDF,
  generateLibroAuxiliarPDF,
  generateLibroIvaPDF,
  generateAgingPDF,
  generateTrialBalanceComparativePDF,
  generateWithholdingPDF,
  generateCashFlowIndirectPDF,
};
