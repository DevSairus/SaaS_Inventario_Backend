// backend/src/services/projects/projectCuts.service.js
//
// Cortes de obra y facturación parcial (módulo Proyectos).
//
// Contrato = la cotización del proyecto (projects.quote_id): queda como
// contrato y no se convierte entera en factura (sales.controller confirm lo
// bloquea si el proyecto tiene cortes). Cada corte registra, por línea, la
// cantidad ejecutada ACUMULADA (o un % global para hitos) y se factura solo lo
// nuevo, al precio neto de la cotización (con su descuento global y su AIU).
//
// Decisiones (2026-11-06):
//   - Anticipo: cada factura parcial amortiza los anticipos del proyecto
//     (customer_advances.project_id) en proporción: total de la factura ×
//     (anticipos del proyecto / total del contrato). El último corte (100 %)
//     amortiza lo que quede.
//   - Retención de garantía: projects.retention_pct sobre el subtotal antes de
//     IVA. Queda en la factura (retention_guarantee_amount): se debe pero no
//     vence hasta liberarla (utils/saleAmounts.js), y contablemente pasa de
//     130505 a 130595 (mapeo sale_retention_guarantee).
//
// La factura se crea con el mismo flujo de ventas (POST /api/sales y
// /confirm, luego /apply-advance) desde el frontend, con el cuerpo que arma
// invoicePayload; aquí se vincula (linkDraft) y se cierra (finalizeInvoice).
// Las líneas van como líneas libres: no mueven inventario (el material ya
// está en la bodega de la obra y se consume con el cierre del proyecto).

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const {
  Project, ProjectCut, ProjectCutItem, Sale, SaleItem, Customer, CustomerAdvance, User,
} = require('../../models');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

const COUNTED = ['approved', 'invoicing', 'invoiced']; // cortes que ya cuentan como ejecutado
const OPEN = ['draft', 'approved', 'invoicing'];
// Estados de la cotización-contrato: admite cortes / ya terminó.
const CONTRACT_BILLABLE = ['aprobada', 'parcial', 'contratada'];
const CONTRACT_DONE = ['facturada', 'cerrada'];
const SIGNATURE_MAX = 400 * 1024;

// ── Contrato ──────────────────────────────────────────────────────────
async function loadContract(tenantId, project, transaction) {
  if (!project.quote_id) throw httpError(400, 'El proyecto no tiene cotización: vincúlala o crea el proyecto desde la cotización para facturar por cortes');
  const quote = await Sale.findOne({
    where: { id: project.quote_id, tenant_id: tenantId },
    include: [{ model: SaleItem, as: 'items' }],
    transaction,
  });
  if (!quote) throw httpError(400, 'No se encontró la cotización del proyecto');
  if (quote.document_type !== 'cotizacion') {
    throw httpError(409, `La cotización ${quote.quote_number || quote.sale_number} ya se convirtió en ${quote.document_type}: el contrato se facturó completo`);
  }
  const items = (quote.items || []).filter((i) => i.approval_status !== 'rechazado' && num(i.quantity) > 0);
  if (!items.length) throw httpError(400, 'La cotización del proyecto no tiene líneas');
  const aiu = quote.aiu_enabled ? {
    admin_pct: num(quote.aiu_admin_pct),
    unforeseen_pct: num(quote.aiu_unforeseen_pct),
    profit_pct: num(quote.aiu_profit_pct),
    // IVA sobre la utilidad, con la tarifa que usó la cotización.
    iva_rate: num(quote.aiu_profit_amount) > 0 ? round4(num(quote.tax_amount) / num(quote.aiu_profit_amount)) : 0.19,
    object: quote.aiu_object || null,
  } : null;
  // El descuento global de la cotización se reparte en el precio de cada línea.
  const itemsSubtotal = items.reduce((s, i) => s + num(i.subtotal), 0);
  const factor = itemsSubtotal > 0 ? (itemsSubtotal - num(quote.global_discount_amount)) / itemsSubtotal : 1;
  const lines = items
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .map((i) => ({
      sale_item_id: i.id,
      description: i.product_name,
      sku: i.product_sku || null,
      qty_contract: round4(num(i.quantity)),
      unit_price: round4((num(i.subtotal) / num(i.quantity)) * factor),
      tax_pct: aiu ? 0 : num(i.tax_percentage),
      amount_contract: round2(num(i.subtotal) * factor),
    }));
  return {
    quote,
    lines,
    aiu,
    total: round2(num(quote.total_amount)),
    subtotal: round2(num(quote.total_amount) - num(quote.tax_amount)),
  };
}

async function executedByLine(tenantId, projectId, { excludeCutId, transaction } = {}) {
  const rows = await ProjectCutItem.findAll({
    attributes: ['sale_item_id', [sequelize.fn('SUM', sequelize.col('qty_this')), 'qty']],
    include: [{
      model: ProjectCut, as: 'cut', attributes: [],
      where: { tenant_id: tenantId, project_id: projectId, status: COUNTED, ...(excludeCutId ? { id: { [Op.ne]: excludeCutId } } : {}) },
    }],
    group: ['sale_item_id'],
    raw: true,
    transaction,
  });
  return new Map(rows.map((r) => [r.sale_item_id, num(r.qty)]));
}

// Anticipos del proyecto: recibido (neto de devoluciones y reasignaciones) y saldo disponible.
async function projectAdvances(tenantId, project, transaction) {
  const rows = await CustomerAdvance.findAll({
    where: { tenant_id: tenantId, project_id: project.id, status: { [Op.notIn]: ['voided'] } },
    order: [['received_date', 'ASC'], ['created_at', 'ASC']],
    transaction,
  });
  const received = round2(rows.reduce((s, a) => s + num(a.amount) - num(a.refunded_amount) - num(a.reassigned_amount), 0));
  const available = rows.filter((a) => a.status === 'active' && num(a.balance) > 0);
  return {
    received,
    applied: round2(rows.reduce((s, a) => s + num(a.applied_amount), 0)),
    available: round2(available.reduce((s, a) => s + num(a.balance), 0)),
    rows: available.map((a) => ({ id: a.id, number: a.advance_number, balance: num(a.balance), customer_id: a.customer_id })),
  };
}

/**
 * Cálculo puro del corte.
 * input: { global_pct?, items: [{ sale_item_id, qty_cumulative? , pct_cumulative? }] }
 * ctx: { lines, previous: Map, aiu, retentionPct, advanceReceived, advanceAvailable, contractTotal }
 */
function computeCut(input, ctx) {
  const byId = new Map((input.items || []).map((i) => [i.sale_item_id, i]));
  const globalPct = input.global_pct === null || input.global_pct === undefined || input.global_pct === '' ? null : Number(input.global_pct);
  if (globalPct !== null && !(globalPct >= 0 && globalPct <= 100)) throw httpError(400, 'El % global va de 0 a 100');

  const items = [];
  for (const l of ctx.lines) {
    const prev = round4(num(ctx.previous.get(l.sale_item_id)));
    const given = byId.get(l.sale_item_id);
    let cumulative;
    if (given && given.qty_cumulative !== undefined && given.qty_cumulative !== null && given.qty_cumulative !== '') {
      cumulative = round4(Number(given.qty_cumulative));
    } else if (given && given.pct_cumulative !== undefined && given.pct_cumulative !== null && given.pct_cumulative !== '') {
      cumulative = round4(l.qty_contract * Number(given.pct_cumulative) / 100);
    } else if (globalPct !== null) {
      cumulative = Math.max(prev, round4(l.qty_contract * globalPct / 100));
    } else {
      cumulative = prev;
    }
    if (!Number.isFinite(cumulative) || cumulative < 0) throw httpError(400, `${l.description}: cantidad inválida`);
    if (cumulative > l.qty_contract + 0.0001) {
      throw httpError(400, `${l.description}: el acumulado (${cumulative}) supera lo contratado (${l.qty_contract}). Un mayor valor requiere otrosí o una cotización adicional.`);
    }
    if (cumulative < prev - 0.0001) {
      throw httpError(400, `${l.description}: el acumulado no puede bajar de lo ya facturado (${prev}); las correcciones se hacen con nota crédito`);
    }
    const qtyThis = round4(cumulative - prev);
    items.push({
      sale_item_id: l.sale_item_id, description: l.description, qty_contract: l.qty_contract, qty_previous: prev,
      qty_cumulative: cumulative, qty_this: qtyThis, unit_price: l.unit_price, tax_pct: l.tax_pct,
      amount: round2(qtyThis * l.unit_price),
    });
  }

  const direct = round2(items.reduce((s, i) => s + i.amount, 0));
  let aiuAmount = 0;
  let tax;
  if (ctx.aiu) {
    const a = round2(direct * ctx.aiu.admin_pct / 100);
    const i = round2(direct * ctx.aiu.unforeseen_pct / 100);
    const u = round2(direct * ctx.aiu.profit_pct / 100);
    aiuAmount = round2(a + i + u);
    tax = round2(u * ctx.aiu.iva_rate);
  } else {
    tax = round2(items.reduce((s, it) => s + it.amount * it.tax_pct / 100, 0));
  }
  const subtotal = round2(direct + aiuAmount);
  const total = round2(subtotal + tax);
  const retention = round2(subtotal * num(ctx.retentionPct) / 100);

  // Avance acumulado del contrato (por valor) y si este corte lo completa.
  const contractDirect = ctx.lines.reduce((s, l) => s + l.qty_contract * l.unit_price, 0);
  const cumulativeDirect = items.reduce((s, it) => s + it.qty_cumulative * it.unit_price, 0);
  const progressPct = contractDirect > 0 ? Math.round((cumulativeDirect / contractDirect) * 10000) / 100 : 0;
  const isFinal = items.every((it) => Math.abs(it.qty_cumulative - it.qty_contract) < 0.0001);

  const rate = ctx.contractTotal > 0 ? Math.min(num(ctx.advanceReceived) / ctx.contractTotal, 1) : 0;
  const cap = Math.max(Math.min(num(ctx.advanceAvailable), total - retention), 0);
  const advance = round2(isFinal ? cap : Math.min(round2(total * rate), cap));

  return {
    items,
    direct_amount: direct,
    aiu_amount: aiuAmount,
    subtotal,
    tax_amount: tax,
    total_amount: total,
    retention_amount: retention,
    advance_amount: advance,
    net_amount: round2(total - advance - retention),
    progress_pct: progressPct,
    is_final: isFinal,
    advance_rate: Math.round(rate * 10000) / 100,
  };
}

async function cutContext(tenantId, project, { excludeCutId, transaction } = {}) {
  const contract = await loadContract(tenantId, project, transaction);
  const [previous, advances] = await Promise.all([
    executedByLine(tenantId, project.id, { excludeCutId, transaction }),
    projectAdvances(tenantId, project, transaction),
  ]);
  return {
    contract,
    advances,
    ctx: {
      lines: contract.lines, previous, aiu: contract.aiu, retentionPct: num(project.retention_pct),
      advanceReceived: advances.received, advanceAvailable: advances.available, contractTotal: contract.total,
    },
  };
}

// ── Consultas ─────────────────────────────────────────────────────────
async function billingSummary(tenantId, project) {
  let contract = null;
  let contractError = null;
  try { contract = await loadContract(tenantId, project); } catch (e) { contractError = e.message; }
  const [cuts, advances] = await Promise.all([
    ProjectCut.findAll({
      where: { tenant_id: tenantId, project_id: project.id },
      attributes: { exclude: ['approved_signature'] },
      include: [
        { model: ProjectCutItem, as: 'items' },
        { model: Sale, as: 'sale', attributes: ['id', 'sale_number', 'status', 'document_type', 'total_amount', 'paid_amount', 'retention_guarantee_amount', 'retention_released_at', 'dian_status'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['cut_no', 'DESC']],
    }),
    projectAdvances(tenantId, project),
  ]);
  const invoiced = cuts.filter((c) => c.status === 'invoiced');
  const executed = contract ? await executedByLine(tenantId, project.id) : new Map();
  const lines = contract ? contract.lines.map((l) => ({
    ...l,
    qty_executed: round4(num(executed.get(l.sale_item_id))),
    pct_executed: l.qty_contract > 0 ? Math.round((num(executed.get(l.sale_item_id)) / l.qty_contract) * 10000) / 100 : 0,
  })) : [];
  const contractDirect = lines.reduce((s, l) => s + l.qty_contract * l.unit_price, 0);
  const executedDirect = lines.reduce((s, l) => s + l.qty_executed * l.unit_price, 0);
  const retentionHeld = round2(invoiced.reduce((s, c) => s + (c.sale && !c.sale.retention_released_at ? num(c.sale.retention_guarantee_amount) : 0), 0));
  return {
    contract: contract ? {
      quote_id: contract.quote.id,
      quote_number: contract.quote.quote_number || contract.quote.sale_number,
      quote_status: contract.quote.quote_status,
      closed_at: contract.quote.contract_closed_at,
      close_reason: contract.quote.contract_close_reason,
      unexecuted_amount: contract.quote.contract_unexecuted_amount === null ? null : num(contract.quote.contract_unexecuted_amount),
      total: contract.total,
      subtotal: contract.subtotal,
      aiu: contract.aiu,
    } : null,
    contract_error: contractError,
    lines,
    progress_pct: contractDirect > 0 ? Math.round((executedDirect / contractDirect) * 10000) / 100 : 0,
    invoiced_total: round2(invoiced.reduce((s, c) => s + num(c.total_amount), 0)),
    invoiced_subtotal: round2(invoiced.reduce((s, c) => s + num(c.subtotal), 0)),
    retention_pct: num(project.retention_pct),
    retention_held: retentionHeld,
    retention_released_at: project.retention_released_at,
    advances,
    advance_amortized: round2(invoiced.reduce((s, c) => s + num(c.advance_amount), 0)),
    cuts,
    open_cut: cuts.find((c) => OPEN.includes(c.status)) || null,
  };
}

async function loadCut(tenantId, project, cutId, { transaction, lock } = {}) {
  const cut = await ProjectCut.findOne({
    where: { id: cutId, tenant_id: tenantId, project_id: project.id },
    include: [{ model: ProjectCutItem, as: 'items' }],
    transaction,
    // Solo la fila del corte: FOR UPDATE no aplica al lado nulable del LEFT JOIN de las líneas.
    ...(lock ? { lock: { level: transaction.LOCK.UPDATE, of: ProjectCut } } : {}),
  });
  if (!cut) throw httpError(404, 'Corte no encontrado');
  return cut;
}

/** Vista previa del cálculo (sin guardar). */
async function previewCut(tenantId, project, body, cutId = null) {
  const { ctx, advances, contract } = await cutContext(tenantId, project, { excludeCutId: cutId });
  return { ...computeCut(body, ctx), advances, contract_total: contract.total, retention_pct: num(project.retention_pct) };
}

// ── Escritura ─────────────────────────────────────────────────────────
function assertProjectOpen(project) {
  if (['closed', 'cancelled'].includes(project.status)) throw httpError(409, 'El proyecto está cerrado');
}

function cutFields(body) {
  const out = {};
  if (body.cut_date !== undefined) {
    if (!isDate(body.cut_date)) throw httpError(400, 'Fecha del corte inválida');
    out.cut_date = body.cut_date;
  }
  for (const k of ['period_from', 'period_to']) {
    if (body[k] === undefined) continue;
    if (body[k] && !isDate(body[k])) throw httpError(400, 'Periodo inválido');
    out[k] = body[k] || null;
  }
  if (out.period_from && out.period_to && out.period_from > out.period_to) throw httpError(400, 'El periodo está al revés');
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim().slice(0, 5000) || null;
  if (body.global_pct !== undefined) out.global_pct = body.global_pct === '' || body.global_pct === null ? null : Number(body.global_pct);
  return out;
}

async function saveCut(tenantId, userId, project, cutId, body) {
  assertProjectOpen(project);
  return sequelize.transaction(async (t) => {
    await Project.findByPk(project.id, { transaction: t, lock: t.LOCK.UPDATE });
    let cut = null;
    if (cutId) {
      cut = await loadCut(tenantId, project, cutId, { transaction: t, lock: true });
      if (cut.status !== 'draft') throw httpError(409, 'Solo se edita un corte en borrador');
    } else {
      const open = await ProjectCut.findOne({ where: { tenant_id: tenantId, project_id: project.id, status: OPEN }, transaction: t });
      if (open) throw httpError(409, `Termina primero el corte ${open.cut_no} (está ${open.status === 'draft' ? 'en borrador' : open.status === 'approved' ? 'aprobado sin facturar' : 'facturándose'})`);
    }
    if (!['approved', 'in_progress', 'on_hold', 'completed'].includes(project.status)) {
      throw httpError(409, 'Los cortes se hacen con el proyecto aprobado o en ejecución');
    }
    const { ctx, contract } = await cutContext(tenantId, project, { excludeCutId: cut?.id, transaction: t });
    const contractNo = contract.quote.quote_number || contract.quote.sale_number;
    if (CONTRACT_DONE.includes(contract.quote.quote_status)) {
      throw httpError(409, contract.quote.quote_status === 'facturada'
        ? `El contrato ${contractNo} ya se facturó completo: un mayor valor requiere otrosí o una cotización adicional`
        : `El contrato ${contractNo} está cerrado: no admite más cortes`);
    }
    if (!CONTRACT_BILLABLE.includes(contract.quote.quote_status)) {
      throw httpError(409, `El contrato (cotización ${contractNo}) debe estar aprobado por el cliente`);
    }
    const calc = computeCut(body, ctx);
    if (!(calc.direct_amount > 0)) throw httpError(400, 'El corte no tiene avance nuevo: aumenta el acumulado de alguna línea');
    const values = {
      ...cutFields(body),
      direct_amount: calc.direct_amount, aiu_amount: calc.aiu_amount, subtotal: calc.subtotal, tax_amount: calc.tax_amount,
      total_amount: calc.total_amount, advance_amount: calc.advance_amount, retention_amount: calc.retention_amount,
      net_amount: calc.net_amount, progress_pct: calc.progress_pct,
    };
    if (!cut) {
      const max = await ProjectCut.max('cut_no', { where: { project_id: project.id }, transaction: t });
      cut = await ProjectCut.create({
        tenant_id: tenantId, project_id: project.id, cut_no: (max || 0) + 1, cut_date: values.cut_date || todayLocal(),
        status: 'draft', created_by: userId, ...values,
      }, { transaction: t });
    } else {
      await cut.update(values, { transaction: t });
      await ProjectCutItem.destroy({ where: { cut_id: cut.id }, transaction: t });
    }
    await ProjectCutItem.bulkCreate(calc.items.filter((i) => i.qty_this > 0).map((i) => ({
      tenant_id: tenantId, cut_id: cut.id, sale_item_id: i.sale_item_id, description: String(i.description).slice(0, 500),
      qty_contract: i.qty_contract, qty_previous: i.qty_previous, qty_cumulative: i.qty_cumulative, qty_this: i.qty_this,
      unit_price: i.unit_price, tax_pct: i.tax_pct, amount: i.amount,
    })), { transaction: t });
    return cut;
  });
}

async function deleteCut(tenantId, project, cutId) {
  return sequelize.transaction(async (t) => {
    const cut = await loadCut(tenantId, project, cutId, { transaction: t, lock: true });
    if (cut.status === 'draft') { await cut.destroy({ transaction: t }); return { deleted: true }; }
    if (cut.status === 'approved') { await cut.update({ status: 'cancelled' }, { transaction: t }); return { cancelled: true }; }
    throw httpError(409, cut.status === 'invoiced' ? 'El corte ya está facturado: se corrige con nota crédito' : 'El corte se está facturando');
  });
}

async function approveCut(tenantId, userId, project, cutId, body) {
  assertProjectOpen(project);
  const name = String(body.approved_by_name || '').trim().slice(0, 200);
  if (!name) throw httpError(400, 'Indica quién aprueba el corte por parte del cliente');
  const signature = body.approved_signature || null;
  if (signature && (typeof signature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > SIGNATURE_MAX)) {
    throw httpError(400, 'Firma inválida');
  }
  return sequelize.transaction(async (t) => {
    const cut = await loadCut(tenantId, project, cutId, { transaction: t, lock: true });
    if (cut.status !== 'draft') throw httpError(409, 'Solo se aprueba un corte en borrador');
    await cut.update({
      status: 'approved', approved_by_name: name, approved_by_document: String(body.approved_by_document || '').trim().slice(0, 30) || null,
      approved_signature: signature, approved_at: new Date(), approved_user_id: userId,
    }, { transaction: t });
    return cut;
  });
}

// ── Facturación ───────────────────────────────────────────────────────
/** Cuerpos para crear (POST /api/sales) y confirmar la factura, y los anticipos a aplicar. */
async function invoicePayload(tenantId, project, cutId) {
  const cut = await loadCut(tenantId, project, cutId);
  if (!['approved', 'invoicing'].includes(cut.status)) throw httpError(409, 'Aprueba el corte antes de facturarlo');
  if (!project.customer_id) throw httpError(400, 'El proyecto no tiene cliente');
  const { ctx, advances, contract } = await cutContext(tenantId, project, { excludeCutId: cut.id });
  const items = cut.items.map((i) => ({ sale_item_id: i.sale_item_id, qty_cumulative: num(i.qty_cumulative) }));
  // Lo que no está en el corte queda en su acumulado anterior.
  const calc = computeCut({ items }, ctx);
  if (Math.abs(calc.direct_amount - num(cut.direct_amount)) > 0.5) {
    throw httpError(409, 'El contrato o los cortes anteriores cambiaron desde que se armó este corte: cancélalo y vuelve a hacerlo');
  }
  // Anticipos a aplicar, del más antiguo al más nuevo.
  let pending = calc.advance_amount;
  const applications = [];
  for (const a of advances.rows) {
    if (pending <= 0) break;
    const amount = round2(Math.min(a.balance, pending));
    if (amount > 0) applications.push({ advance_id: a.id, amount });
    pending = round2(pending - amount);
  }
  const fmtPct = (n) => `${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;
  const notes = [
    `Corte de obra N.° ${cut.cut_no} del proyecto ${project.code} — ${project.name}. Contrato ${contract.quote.quote_number || contract.quote.sale_number}. Avance acumulado ${fmtPct(calc.progress_pct)}.`,
    cut.period_from || cut.period_to ? `Periodo: ${cut.period_from || '—'} a ${cut.period_to || '—'}.` : null,
    calc.advance_amount > 0 ? `Amortización de anticipo: $ ${Math.round(calc.advance_amount).toLocaleString('es-CO')}.` : null,
    calc.retention_amount > 0 ? `Retención de garantía ${fmtPct(project.retention_pct)}: $ ${Math.round(calc.retention_amount).toLocaleString('es-CO')} (se paga a la entrega de la obra).` : null,
    `Neto a pagar por este corte: $ ${Math.round(calc.net_amount).toLocaleString('es-CO')}.`,
  ].filter(Boolean).join('\n');
  const fmtQty = (n) => Number(n).toLocaleString('es-CO', { maximumFractionDigits: 4 });
  const sale = {
    customer_id: project.customer_id,
    project_id: project.id,
    notes,
    items: calc.items.filter((i) => i.qty_this > 0).map((i) => ({
      item_type: 'free_line',
      product_name: `${i.description} — corte ${cut.cut_no} (acumulado ${fmtQty(i.qty_cumulative)} de ${fmtQty(i.qty_contract)})`.slice(0, 500),
      quantity: i.qty_this,
      unit_price: i.unit_price,
      tax_percentage: i.tax_pct,
    })),
    ...(contract.aiu ? {
      aiu_enabled: true,
      aiu_admin_pct: contract.aiu.admin_pct,
      aiu_unforeseen_pct: contract.aiu.unforeseen_pct,
      aiu_profit_pct: contract.aiu.profit_pct,
      aiu_object: contract.aiu.object || `Avance de obra ${project.code} — corte ${cut.cut_no}`,
    } : {}),
  };
  // A crédito: nada pagado al confirmar; los anticipos se aplican después.
  const confirm = { document_type: 'factura', payment_method: 'transfer', paid_amount: 0 };
  return { sale, confirm, applications, expected: calc, draft_sale_id: cut.status === 'invoicing' ? cut.sale_id : null };
}

async function linkDraft(tenantId, project, cutId, saleId) {
  return sequelize.transaction(async (t) => {
    const cut = await loadCut(tenantId, project, cutId, { transaction: t, lock: true });
    if (!['approved', 'invoicing'].includes(cut.status)) throw httpError(409, 'El corte no está listo para facturar');
    const sale = await Sale.findOne({ where: { id: saleId, tenant_id: tenantId, project_id: project.id }, transaction: t });
    if (!sale) throw httpError(400, 'Factura no encontrada en el proyecto');
    await sale.update({ project_cut_id: cut.id }, { transaction: t });
    await cut.update({ status: 'invoicing', sale_id: sale.id }, { transaction: t });
    return cut;
  });
}

async function postRetentionEntry(tenantId, sale, project, amount, userId, { release = false } = {}) {
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  if (!(amount > 0) || !(await getEffectiveModulesForTenantId(tenantId)).includes('accounting')) return null;
  const { createDraftEntry, getMappedAccountId, safeAutoGenerate } = require('../accounting/journalEntry.service');
  return safeAutoGenerate(() => sequelize.transaction(async (t) => {
    const retention = await getMappedAccountId(tenantId, 'sale_retention_guarantee', t);
    const receivable = await getMappedAccountId(tenantId, 'sale_receivable', t);
    const lines = [
      { account_id: release ? receivable : retention, debit: amount, credit: 0, third_party_id: sale.customer_id, description: release ? 'Retención de garantía liberada: por cobrar' : 'Retención de garantía por cobrar (no vencida)' },
      { account_id: release ? retention : receivable, debit: 0, credit: amount, third_party_id: sale.customer_id, description: `Factura ${sale.sale_number}` },
    ];
    return createDraftEntry(tenantId, {
      branchId: sale.branch_id, entryDate: todayLocal(), sourceType: 'project_retention', sourceId: sale.id, projectId: project.id,
      description: `${release ? 'Liberación de la retención' : 'Retención'} de garantía — ${sale.sale_number} (${project.code})`,
      lines, createdBy: userId,
    }, t);
  }), `retención de garantía ${sale.id}`);
}

// ── Ciclo de vida del contrato ───────────────────────────────────────
/** Avance del contrato (por valor directo, igual que la pestaña de cortes); null si no hay contrato vigente. */
async function contractProgress(tenantId, project) {
  if (!project.quote_id) return null;
  let contract;
  try { contract = await loadContract(tenantId, project); } catch { return null; }
  const [executed, invoicedCuts] = await Promise.all([
    executedByLine(tenantId, project.id),
    ProjectCut.count({ where: { tenant_id: tenantId, project_id: project.id, status: 'invoiced' } }),
  ]);
  const contractDirect = contract.lines.reduce((s, l) => s + l.qty_contract * l.unit_price, 0);
  const executedDirect = contract.lines.reduce((s, l) => s + num(executed.get(l.sale_item_id)) * l.unit_price, 0);
  return {
    quote_id: contract.quote.id,
    quote_status: contract.quote.quote_status,
    invoiced_cuts: invoicedCuts,
    progress_pct: contractDirect > 0 ? Math.round((executedDirect / contractDirect) * 10000) / 100 : 0,
    unexecuted_amount: contract.quote.contract_unexecuted_amount === null ? null : num(contract.quote.contract_unexecuted_amount),
  };
}

/**
 * Tras facturar un corte: la cotización pasa a 'contratada' y, si los cortes
 * ya cubren todo lo contratado, a 'facturada' (contrato terminado).
 */
async function contractComplete(tenantId, project, contract, transaction) {
  const executed = await executedByLine(tenantId, project.id, { transaction });
  return contract.lines.every((l) => num(executed.get(l.sale_item_id)) >= l.qty_contract - 0.0001);
}

async function markContractProgress(tenantId, project, transaction) {
  const contract = await loadContract(tenantId, project, transaction);
  const quote = contract.quote;
  if (CONTRACT_DONE.includes(quote.quote_status)) return quote;
  const complete = await contractComplete(tenantId, project, contract, transaction);
  await Sale.update(complete
    ? { quote_status: 'facturada', contract_closed_at: new Date(), contract_unexecuted_amount: 0 }
    : { quote_status: 'contratada' },
  { where: { id: quote.id, tenant_id: tenantId }, transaction });
  return quote;
}

/**
 * Cierra a mano el contrato con saldo sin ejecutar (obra terminada antes,
 * alcance reducido). No admite más cortes; lo ya facturado no cambia.
 */
async function closeContract(tenantId, userId, project, body) {
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (!reason) throw httpError(400, 'Indica el motivo del cierre del contrato');
  return sequelize.transaction(async (t) => {
    await Project.findByPk(project.id, { transaction: t, lock: t.LOCK.UPDATE });
    const contract = await loadContract(tenantId, project, t);
    const quote = contract.quote;
    const contractNo = quote.quote_number || quote.sale_number;
    if (CONTRACT_DONE.includes(quote.quote_status)) throw httpError(409, `El contrato ${contractNo} ya está ${quote.quote_status === 'facturada' ? 'facturado completo' : 'cerrado'}`);
    if (!CONTRACT_BILLABLE.includes(quote.quote_status)) throw httpError(409, `La cotización ${contractNo} no está aprobada: no es un contrato que cerrar`);
    const open = await ProjectCut.findOne({ where: { tenant_id: tenantId, project_id: project.id, status: OPEN }, transaction: t });
    if (open) throw httpError(409, `Termina o cancela primero el corte ${open.cut_no}`);
    if (await contractComplete(tenantId, project, contract, t)) {
      // Nada sin ejecutar: queda facturado completo, no "cerrado con saldo".
      await markContractProgress(tenantId, project, t);
      return { quote_id: quote.id, quote_status: 'facturada', unexecuted_amount: 0 };
    }
    const invoiced = await ProjectCut.sum('total_amount', { where: { tenant_id: tenantId, project_id: project.id, status: 'invoiced' }, transaction: t });
    const unexecuted = round2(Math.max(contract.total - num(invoiced), 0));
    await Sale.update({
      quote_status: 'cerrada',
      contract_closed_at: new Date(),
      contract_closed_by: userId,
      contract_close_reason: reason,
      contract_unexecuted_amount: unexecuted,
    }, { where: { id: quote.id, tenant_id: tenantId }, transaction: t });
    logger.info(`[project-cuts] Contrato ${contractNo} cerrado (${project.code}); sin ejecutar ${unexecuted}`);
    return { quote_id: quote.id, quote_status: 'cerrada', unexecuted_amount: unexecuted };
  });
}

/**
 * Motivo por el que una cotización no se puede editar, eliminar, responder ni
 * convertir: es el contrato de un proyecto que ya se factura por cortes
 * (editarla borraría sus líneas y con ellas las de los cortes). null si no aplica.
 */
async function contractLockReason(tenantId, sale, transaction) {
  if (sale.document_type !== 'cotizacion') return null;
  if (['contratada', ...CONTRACT_DONE].includes(sale.quote_status)) {
    return 'Esta cotización es el contrato de un proyecto que se factura por cortes de obra: se gestiona desde la pestaña "Cortes y facturación" del proyecto.';
  }
  const project = await Project.findOne({ where: { tenant_id: tenantId, quote_id: sale.id }, attributes: ['id'], transaction });
  if (!project) return null;
  const cuts = await ProjectCut.count({ where: { tenant_id: tenantId, project_id: project.id, status: { [Op.ne]: 'cancelled' } }, transaction });
  return cuts
    ? 'Esta cotización es el contrato de un proyecto que se factura por cortes de obra: factura desde los cortes del proyecto.'
    : null;
}

/** Cierra el corte cuando la factura ya quedó confirmada (y los anticipos aplicados). */
async function finalizeInvoice(tenantId, userId, project, cutId) {
  const result = await sequelize.transaction(async (t) => {
    const cut = await loadCut(tenantId, project, cutId, { transaction: t, lock: true });
    if (cut.status === 'invoiced') return { cut, sale: null, already: true };
    if (cut.status !== 'invoicing' || !cut.sale_id) throw httpError(409, 'El corte no tiene factura en proceso');
    const sale = await Sale.findOne({ where: { id: cut.sale_id, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!sale || sale.status === 'draft' || sale.document_type !== 'factura') {
      throw httpError(409, 'La factura del corte todavía está en borrador: confírmala y vuelve a intentar');
    }
    const appliedAdvance = round2((sale.payment_history || [])
      .filter((p) => p.source === 'advance' && !p.voided)
      .reduce((s, p) => s + num(p.amount), 0));
    const retention = round2(num(cut.retention_amount));
    await sale.update({ retention_guarantee_amount: retention }, { transaction: t });
    await cut.update({
      status: 'invoiced',
      // Lo realmente facturado y aplicado (la factura liquidó los impuestos exactos).
      total_amount: num(sale.total_amount),
      tax_amount: num(sale.tax_amount),
      advance_amount: appliedAdvance,
      net_amount: round2(num(sale.total_amount) - appliedAdvance - retention),
    }, { transaction: t });
    await markContractProgress(tenantId, project, t);
    return { cut, sale, retention };
  });
  if (!result.already && result.retention > 0) {
    await postRetentionEntry(tenantId, result.sale, project, result.retention, userId);
  }
  return result.cut;
}

/** Libera la retención de garantía de todas las facturas del proyecto (entrega de la obra). */
async function releaseRetention(tenantId, userId, project) {
  const sales = await Sale.findAll({
    where: { tenant_id: tenantId, project_id: project.id, retention_released_at: null, retention_guarantee_amount: { [Op.gt]: 0 }, status: { [Op.ne]: 'cancelled' } },
  });
  if (!sales.length) throw httpError(409, 'No hay retención de garantía pendiente en el proyecto');
  const now = new Date();
  let total = 0;
  for (const sale of sales) {
    // eslint-disable-next-line no-await-in-loop
    await sale.update({ retention_released_at: now });
    total = round2(total + num(sale.retention_guarantee_amount));
    // eslint-disable-next-line no-await-in-loop
    await postRetentionEntry(tenantId, sale, project, num(sale.retention_guarantee_amount), userId, { release: true });
  }
  await project.update({ retention_released_at: now });
  logger.info(`[project-cuts] Retención liberada ${project.code}: ${total} en ${sales.length} factura(s)`);
  return { invoices: sales.length, amount: total };
}

async function getCutForActa(tenantId, project, cutId) {
  const cut = await ProjectCut.findOne({
    where: { id: cutId, tenant_id: tenantId, project_id: project.id },
    include: [
      { model: ProjectCutItem, as: 'items' },
      { model: Sale, as: 'sale', attributes: ['id', 'sale_number', 'total_amount'] },
      { model: User, as: 'creator', attributes: ['first_name', 'last_name'] },
    ],
  });
  if (!cut) throw httpError(404, 'Corte no encontrado');
  const customer = project.customer_id ? await Customer.findByPk(project.customer_id, { attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id'] }) : null;
  const { contract, advances } = await cutContext(tenantId, project, { excludeCutId: cut.id });
  return { cut, customer, contract, advances };
}

module.exports = {
  computeCut, billingSummary, previewCut, saveCut, deleteCut, approveCut, invoicePayload, linkDraft, finalizeInvoice,
  releaseRetention, getCutForActa, loadContract, closeContract, contractLockReason, contractProgress,
};
