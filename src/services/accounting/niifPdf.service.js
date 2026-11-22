// backend/src/services/accounting/niifPdf.service.js
//
// PDF de los estados financieros NIIF: situación financiera, resultado
// integral, cambios en el patrimonio, flujo de efectivo y notas, con el
// bloque de firmas (art. 37 Ley 222 de 1995). Sirve para el paquete
// completo o para un solo estado. Mismo encabezado y pie que el resto de
// los PDF contables (reportsPdf.service.js).

const { startReportDoc, finishReportDoc, ensureSpace } = require('./reportsPdf.service');

const red = '#8b0000';
const gray = '#6b7280';
const darkGray = '#374151';
const border = '#e5e7eb';
const borderMd = '#d1d5db';
const black = '#111827';
const soft = '#f3f4f6';
const white = '#ffffff';

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
function money(v) {
  const n = Math.round(Number(v || 0));
  if (n === 0) return '—';
  return n < 0 ? `(${nf.format(-n)})` : nf.format(n);
}

/* ─────────────────────────── Primitivas ─────────────────────────── */

function newSection(ctx, title, subtitle, first) {
  const { doc, MARGIN, INNER_W } = ctx;
  if (!first) {
    doc.addPage();
    ctx.drawTopBar();
    ctx.y = 40;
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red).text(title.toUpperCase(), MARGIN, ctx.y, { width: INNER_W });
  ctx.y += 16;
  if (subtitle) {
    doc.font('Helvetica').fontSize(8.5).fillColor(gray).text(subtitle, MARGIN, ctx.y, { width: INNER_W });
    ctx.y += 13;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(gray).text('Cifras en pesos colombianos', MARGIN, ctx.y, { width: INNER_W });
  ctx.y += 14;
}

// Tabla de estado: [concepto | nota | actual | anterior]
function statementTable(ctx, headers, rows) {
  const { doc, MARGIN, INNER_W } = ctx;
  const X = { label: MARGIN, note: MARGIN + INNER_W - 230, cur: MARGIN + INNER_W - 200, prev: MARGIN + INNER_W - 100 };
  const W = 94;
  const head = () => {
    doc.roundedRect(MARGIN, ctx.y, INNER_W, 18, 3).fill(darkGray);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white)
      .text('CONCEPTO', X.label + 6, ctx.y + 5)
      .text('NOTA', X.note, ctx.y + 5, { width: 28, align: 'center' })
      .text(headers[0], X.cur, ctx.y + 5, { width: W, align: 'right' })
      .text(headers[1], X.prev, ctx.y + 5, { width: W, align: 'right' });
    ctx.y += 22;
  };
  head();
  for (const r of rows) {
    ensureSpace(ctx, 16, head);
    if (r.type === 'section') {
      ctx.y += 4;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(red).text(r.label.toUpperCase(), X.label + 6, ctx.y, { width: X.note - X.label - 10 });
      ctx.y += 13;
      continue;
    }
    if (r.type === 'total' || r.type === 'grand') {
      doc.moveTo(X.cur, ctx.y - 2).lineTo(MARGIN + INNER_W, ctx.y - 2).strokeColor(borderMd).lineWidth(0.6).stroke();
      if (r.type === 'grand') doc.rect(MARGIN, ctx.y - 1, INNER_W, 14).fill(soft);
    }
    const bold = r.type === 'total' || r.type === 'grand';
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(black)
      .text(r.label, X.label + 6 + (r.indent ? 12 : 0), ctx.y + 1, { width: X.note - X.label - 18, height: 10, ellipsis: true })
      .text(r.note ? String(r.note) : '', X.note, ctx.y + 1, { width: 28, align: 'center' })
      .text(money(r.current), X.cur, ctx.y + 1, { width: W, align: 'right' })
      .text(money(r.prior), X.prev, ctx.y + 1, { width: W, align: 'right' });
    ctx.y += bold ? 17 : 14;
  }
}

function signatures(ctx, sig = {}) {
  const { doc, MARGIN, INNER_W } = ctx;
  const people = [
    { role: 'Representante legal', name: sig.legal_rep_name, id: sig.legal_rep_id ? `C.C. ${sig.legal_rep_id}` : '' },
    { role: 'Contador público', name: sig.accountant_name, id: sig.accountant_tp ? `T.P. ${sig.accountant_tp}` : '' },
  ];
  if (sig.auditor_name) people.push({ role: 'Revisor fiscal', name: sig.auditor_name, id: sig.auditor_tp ? `T.P. ${sig.auditor_tp}` : '' });
  ensureSpace(ctx, 75);
  ctx.y += 40;
  const w = INNER_W / people.length;
  people.forEach((p, i) => {
    const x = MARGIN + i * w + 10;
    doc.moveTo(x, ctx.y).lineTo(x + w - 20, ctx.y).strokeColor(darkGray).lineWidth(0.6).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(black).text(p.name || ' ', x, ctx.y + 4, { width: w - 20 });
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text([p.role, p.id].filter(Boolean).join(' · '), x, ctx.y + 15, { width: w - 20 });
  });
  ctx.y += 32;
}

// Párrafo con prefijo **negrita** opcional.
function paragraph(ctx, text) {
  const { doc, MARGIN, INNER_W } = ctx;
  const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(text);
  const height = doc.font('Helvetica').fontSize(8.5).heightOfString(text.replace(/\*\*/g, ''), { width: INNER_W });
  ensureSpace(ctx, height + 6);
  if (m) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(black).text(`${m[1]} `, MARGIN, ctx.y, { width: INNER_W, continued: true, align: 'justify' });
    doc.font('Helvetica').text(m[2], { width: INNER_W, align: 'justify' });
  } else {
    doc.font('Helvetica').fontSize(8.5).fillColor(black).text(text, MARGIN, ctx.y, { width: INNER_W, align: 'justify' });
  }
  ctx.y = doc.y + 5;
}

function genericTable(ctx, t) {
  const { doc, MARGIN, INNER_W } = ctx;
  // Primera columna de texto más ancha; si hay dos de texto (cuenta + nombre), la segunda también.
  const textCols = t.columns.filter((c) => c.align !== 'right').length;
  const widths = t.columns.map((c, i) => {
    if (c.align === 'right') return 0;
    if (textCols === 2 && i === 0) return 50;
    return null;
  });
  const fixed = widths.reduce((s, w) => s + (w || 0), 0);
  const numCount = t.columns.filter((c) => c.align === 'right').length;
  const numW = Math.min(95, (INNER_W - fixed) / (numCount + 2));
  const flexCount = widths.filter((w) => w === null).length;
  const flexW = (INNER_W - fixed - numW * numCount) / Math.max(1, flexCount);
  const W = t.columns.map((c, i) => (c.align === 'right' ? numW : widths[i] === null ? flexW : widths[i]));
  const X = W.reduce((acc, w, i) => { acc.push(i === 0 ? MARGIN : acc[i - 1] + W[i - 1]); return acc; }, []);
  const isMoney = (i) => i >= (t.money_from ?? 99) && i <= (t.money_to ?? 99);
  const cell = (v, i) => (typeof v === 'number' && isMoney(i) ? money(v) : String(v ?? ''));

  if (t.title) {
    ensureSpace(ctx, 30);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray).text(t.title, MARGIN, ctx.y, { width: INNER_W });
    ctx.y += 12;
  }
  const head = () => {
    doc.rect(MARGIN, ctx.y, INNER_W, 15).fill(soft);
    t.columns.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(7).fillColor(darkGray)
      .text(c.label, X[i] + 3, ctx.y + 4, { width: W[i] - 6, height: 9, align: c.align || 'left', ellipsis: true }));
    ctx.y += 18;
  };
  ensureSpace(ctx, 34);
  head();
  for (const row of t.rows) {
    ensureSpace(ctx, 13, head);
    row.forEach((v, i) => doc.font('Helvetica').fontSize(7.5).fillColor(black)
      .text(cell(v, i), X[i] + 3, ctx.y, { width: W[i] - 6, height: 10, align: t.columns[i].align || 'left', ellipsis: true }));
    ctx.y += 12;
    doc.moveTo(MARGIN, ctx.y - 2).lineTo(MARGIN + INNER_W, ctx.y - 2).strokeColor(border).lineWidth(0.3).stroke();
  }
  if (t.total) {
    ensureSpace(ctx, 14);
    t.total.forEach((v, i) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor(black)
      .text(cell(v, i), X[i] + 3, ctx.y + 1, { width: W[i] - 6, height: 10, align: t.columns[i].align || 'left', ellipsis: true }));
    ctx.y += 14;
  }
  ctx.y += 6;
}

/* ─────────────────────────── Estados ─────────────────────────── */

function drawFinancialPosition(ctx, esf, notesRef, sig, first) {
  newSection(ctx, 'Estado de situación financiera', `Al ${fmtDate(esf.as_of)} y ${fmtDate(esf.compare_as_of)}`, first);
  const rows = [];
  const groups = [['activo', 'TOTAL ACTIVO'], ['pasivo', 'TOTAL PASIVO'], ['patrimonio', 'TOTAL PATRIMONIO']];
  for (const [g, totalLabel] of groups) {
    for (const sec of esf.sections.filter((s) => s.group === g)) {
      rows.push({ type: 'section', label: sec.label });
      for (const r of sec.rubros) rows.push({ label: r.label, note: notesRef?.[r.code], current: r.current, prior: r.prior, indent: true });
      if (g !== 'patrimonio') rows.push({ type: 'total', label: `Total ${sec.label.toLowerCase()}`, current: sec.current, prior: sec.prior });
    }
    rows.push({ type: 'grand', label: totalLabel, current: esf.totals.current[g], prior: esf.totals.prior[g] });
  }
  rows.push({ type: 'grand', label: 'TOTAL PASIVO Y PATRIMONIO', current: esf.totals.current.pasivo_patrimonio, prior: esf.totals.prior.pasivo_patrimonio });
  statementTable(ctx, [fmtDate(esf.as_of), fmtDate(esf.compare_as_of)], rows);
  signatures(ctx, sig);
}

function drawComprehensiveIncome(ctx, eri, notesRef, sig, first) {
  newSection(ctx, 'Estado del resultado integral', `Del ${fmtDate(eri.from)} al ${fmtDate(eri.to)}, comparado con ${fmtDate(eri.compare_from)} – ${fmtDate(eri.compare_to)}`, first);
  const rows = eri.lines.map((l) => {
    const sign = l.negative ? -1 : 1;
    if (l.subtotal) return { type: l.strong ? 'grand' : 'total', label: l.label, current: l.current, prior: l.prior };
    return { label: l.label, note: l.rubro ? notesRef?.[l.rubro] : null, current: sign * l.current, prior: sign * l.prior, indent: true };
  });
  statementTable(ctx, [`${fmtDate(eri.from)}–${fmtDate(eri.to)}`.slice(0, 23), `${fmtDate(eri.compare_from)}–${fmtDate(eri.compare_to)}`.slice(0, 23)], rows);
  signatures(ctx, sig);
}

function drawEquityChanges(ctx, ecp, sig, first) {
  newSection(ctx, 'Estado de cambios en el patrimonio', `Del ${fmtDate(ecp.from)} al ${fmtDate(ecp.to)}`, first);
  const { doc, MARGIN, INNER_W } = ctx;
  if (!ecp.columns.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin movimientos de patrimonio en el periodo.', MARGIN, ctx.y);
    ctx.y += 16;
    signatures(ctx, sig);
    return;
  }
  const cols = [...ecp.columns, { code: '_total', label: 'Total patrimonio' }];
  const labelW = 190;
  const colW = (INNER_W - labelW) / cols.length;
  const headH = 30;
  doc.rect(MARGIN, ctx.y, INNER_W, headH).fill(darkGray);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(white).text('CONCEPTO', MARGIN + 6, ctx.y + 11);
  cols.forEach((c, i) => doc.text(c.label, MARGIN + labelW + i * colW + 2, ctx.y + 4, { width: colW - 6, align: 'right', height: headH - 4 }));
  ctx.y += headH + 4;
  for (const r of ecp.rows) {
    ensureSpace(ctx, 15);
    if (r.strong) doc.rect(MARGIN, ctx.y - 2, INNER_W, 14).fill(soft);
    const label = r.key === 'saldo_inicial' ? `Saldo al ${fmtDate(ecp.opening_date)}` : r.key === 'saldo_final' ? `Saldo al ${fmtDate(ecp.to)}` : r.label;
    doc.font(r.strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(black).text(label, MARGIN + 6, ctx.y + 1, { width: labelW - 10, height: 10, ellipsis: true });
    cols.forEach((c, i) => doc.text(money(c.code === '_total' ? r.total : r.values[c.code]), MARGIN + labelW + i * colW + 2, ctx.y + 1, { width: colW - 6, align: 'right' }));
    ctx.y += 15;
  }
  signatures(ctx, sig);
}

function drawCashFlow(ctx, cf, sig, first) {
  newSection(ctx, 'Estado de flujos de efectivo (método indirecto)', `Del ${fmtDate(cf.from)} al ${fmtDate(cf.to)}`, first);
  const { doc, MARGIN, INNER_W } = ctx;
  const line = (label, v, opts = {}) => {
    ensureSpace(ctx, 14);
    if (opts.grand) doc.rect(MARGIN, ctx.y - 2, INNER_W, 14).fill(soft);
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(opts.section ? red : black)
      .text(label, MARGIN + 6 + (opts.indent ? 12 : 0), ctx.y, { width: INNER_W - 130, height: 10, ellipsis: true });
    if (v !== undefined) doc.text(money(v), MARGIN + INNER_W - 110, ctx.y, { width: 104, align: 'right' });
    ctx.y += opts.bold ? 16 : 13;
  };
  line('ACTIVIDADES DE OPERACIÓN', undefined, { section: true, bold: true });
  line('Resultado del periodo', cf.net_income, { indent: true });
  for (const r of cf.operating.changes) line(`${r.code} ${r.name}`, r.cash_impact, { indent: true });
  line('Efectivo neto de actividades de operación', cf.operating.total, { bold: true });
  line('ACTIVIDADES DE INVERSIÓN', undefined, { section: true, bold: true });
  for (const r of cf.investing.changes) line(`${r.code} ${r.name}`, r.cash_impact, { indent: true });
  line('Efectivo neto de actividades de inversión', cf.investing.total, { bold: true });
  line('ACTIVIDADES DE FINANCIACIÓN', undefined, { section: true, bold: true });
  for (const r of cf.financing.changes) line(`${r.code} ${r.name}`, r.cash_impact, { indent: true });
  line('Efectivo neto de actividades de financiación', cf.financing.total, { bold: true });
  line('Aumento (disminución) neto del efectivo', cf.net_cash_flow, { bold: true, grand: true });
  line('Efectivo al inicio del periodo', cf.cash.opening);
  line('Efectivo al final del periodo', cf.cash.closing, { bold: true, grand: true });
  if (!cf.cash.matches) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(red)
      .text(`Diferencia sin conciliar contra la variación real del efectivo: ${money(cf.cash.difference)}. Revise cuentas sin rubro o movimientos de patrimonio.`, MARGIN, ctx.y, { width: INNER_W });
    ctx.y = doc.y + 6;
  }
  signatures(ctx, sig);
}

function drawNotes(ctx, notes, first) {
  newSection(ctx, 'Notas a los estados financieros', `Al ${fmtDate(notes.as_of)} — ${notes.tenant.name}${notes.tenant.tax_id ? `, NIT ${notes.tenant.tax_id}` : ''}`, first);
  const { doc, MARGIN, INNER_W } = ctx;
  for (const n of notes.notes) {
    ensureSpace(ctx, 40);
    ctx.y += 4;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(red).text(`Nota ${n.number}. ${n.title}`, MARGIN, ctx.y, { width: INNER_W });
    ctx.y = doc.y + 5;
    const replace = n.custom?.mode === 'replace';
    if (!replace) for (const p of n.paragraphs || []) paragraph(ctx, p);
    if (n.custom?.body) for (const p of n.custom.body.split(/\n{2,}|\r\n\r\n/)) if (p.trim()) paragraph(ctx, p.trim());
    for (const t of n.tables || []) if (t.rows.length) genericTable(ctx, t);
  }
}

/**
 * @param {object} res express res, o null para devolver un Buffer
 * @param {{ esf?, eri?, ecp?, cashflow?, notes? }} parts — se dibujan las que vengan, en orden
 */
async function generateNiifPdf(res, parts, tenant, generatedByName, { title, filename }) {
  const subtitle = parts.esf ? `Al ${fmtDate(parts.esf.as_of)}` : parts.eri ? `${fmtDate(parts.eri.from)} – ${fmtDate(parts.eri.to)}` : '';
  const ctx = await startReportDoc(res, { title, subtitle, filenamePrefix: filename, tenant, generatedByName });
  const sig = parts.notes?.signatures || parts.signatures || {};
  const ref = parts.notes?.rubro_note_numbers || null;
  let first = true;
  if (parts.esf) { drawFinancialPosition(ctx, parts.esf, ref, sig, first); first = false; }
  if (parts.eri) { drawComprehensiveIncome(ctx, parts.eri, ref, sig, first); first = false; }
  if (parts.ecp) { drawEquityChanges(ctx, parts.ecp, sig, first); first = false; }
  if (parts.cashflow) { drawCashFlow(ctx, parts.cashflow, sig, first); first = false; }
  if (parts.notes && parts.includeNotes !== false) { drawNotes(ctx, parts.notes, first); first = false; }
  return finishReportDoc(ctx);
}

module.exports = { generateNiifPdf };
