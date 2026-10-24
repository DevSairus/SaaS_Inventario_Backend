// backend/src/services/tax/ivaProrrateo.service.js
//
// Prorrateo del IVA descontable (art. 490 E.T.).
//
// Cuando el negocio vende a la vez bienes/servicios gravados (o exentos) y
// excluidos, el IVA pagado se trata en dos niveles:
//   1. Asignación directa, al registrar la compra: el IVA de productos que se
//      venden excluidos va al costo (autoEntries.purchaseExcludedIvaShare).
//   2. IVA común (gastos generales: arriendo, servicios, honorarios...): no se
//      puede atribuir a un tipo de ingreso, así que al cierre del período de
//      IVA solo es descontable en la proporción de ingresos gravados + exentos
//      sobre el total. Este servicio calcula esa proporción y genera, en
//      BORRADOR para que el contador lo revise, el ajuste:
//        D iva_prorrateo_expense (511595)  /  C purchase_iva_descontable (135515)
//      por el IVA común no descontable.
//
// Período: tax_config.fiscal_profile.iva_period 'bimestral' (por defecto) o
// 'cuatrimestral' (art. 600 E.T., según ingresos del año anterior).
//
// Ingresos del período: líneas de facturas/remisiones/ventas POS no anuladas
// (sin cotizaciones), menos notas crédito, más notas débito y menos las
// devoluciones de clientes aprobadas en el período que no generaron nota
// crédito (las que sí, ya restan como nota), por el estado de IVA de la línea
// (NULL = líneas anteriores: tarifa > 0 gravado, si no exento).
// IVA común:
//   - IVA de los gastos del período (tax_amount de expenses);
//   - IVA de las compras de insumos de uso común (tax_config.iva_common, o
//     product_type 'raw_material') que no se venden excluidos: se consumen en ventas de cualquier tipo, menos el
//     IVA de sus devoluciones al proveedor aprobadas en el período.
// No entra el IVA de activos fijos productivos: desde 2019 se descuenta en
// renta (art. 258-1 E.T.), no en IVA.
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { createDraftEntry, getMappedAccountId } = require('../accounting/journalEntry.service');

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

const PRORRATEO_MAPPING = { event: 'iva_prorrateo_expense', code: '511595', name: 'IVA no descontable (prorrateo)', type: 'gasto', parent: '5115' };

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const PERIODS = {
  bimestral: { months: 2, count: 6 },
  cuatrimestral: { months: 4, count: 3 },
};

function periodRange(periodicity, year, number) {
  const cfg = PERIODS[periodicity] || PERIODS.bimestral;
  const n = Number(number);
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || !Number.isInteger(n) || n < 1 || n > cfg.count) {
    throw badRequest('Período de IVA inválido');
  }
  const startMonth = (n - 1) * cfg.months; // 0-based
  const pad = (v) => String(v).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, startMonth + cfg.months, 0)).getUTCDate();
  return {
    dateFrom: `${y}-${pad(startMonth + 1)}-01`,
    dateTo: `${y}-${pad(startMonth + cfg.months)}-${pad(lastDay)}`,
  };
}

// source_id determinístico por tenant + período: evita dos ajustes vigentes
// para el mismo período.
function periodSourceId(tenantId, dateFrom, dateTo) {
  const h = crypto.createHash('sha1').update(`iva_prorrateo:${tenantId}:${dateFrom}:${dateTo}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function ensureProrrateoMapping(tenantId, transaction) {
  const { ChartOfAccount, AccountMapping } = require('../../models');
  const m = PRORRATEO_MAPPING;
  const existing = await AccountMapping.findOne({ where: { tenant_id: tenantId, event_type: m.event }, transaction });
  if (existing) return existing.account_id;
  let account = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: m.code }, transaction });
  if (!account) {
    const parent = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: m.parent }, transaction })
      || await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '51' }, transaction });
    account = await ChartOfAccount.create(
      { tenant_id: tenantId, code: m.code, name: m.name, account_type: m.type, parent_id: parent?.id || null, level: 4, accepts_entries: true, is_active: true },
      { transaction }
    );
  }
  await AccountMapping.create({ tenant_id: tenantId, event_type: m.event, account_id: account.id }, { transaction });
  return account.id;
}

async function loadFiscal(tenantId, transaction) {
  const { Tenant } = require('../../models');
  const { isIvaDeductible } = require('../accounting/autoEntries.service');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_config'], transaction });
  const periodicity = tenant?.tax_config?.fiscal_profile?.iva_period === 'cuatrimestral' ? 'cuatrimestral' : 'bimestral';
  return { periodicity, ivaResponsible: await isIvaDeductible(tenantId, transaction) };
}

async function findActiveEntry(tenantId, sourceId, transaction) {
  const { JournalEntry } = require('../../models');
  return JournalEntry.findOne({
    where: { tenant_id: tenantId, source_type: 'iva_prorrateo', source_id: sourceId, reversed_by_entry_id: null },
    order: [['created_at', 'DESC']],
    transaction,
  }).then((e) => (e && e.status !== 'voided' ? e : null));
}

/**
 * Calcula el prorrateo del período. No escribe nada.
 * params: { year, period }
 */
async function computeIvaProrrateo(tenantId, { year, period }, transaction) {
  const { periodicity, ivaResponsible } = await loadFiscal(tenantId, transaction);
  // Sin período: el período en curso según la periodicidad del tenant.
  const today = new Date();
  if (!year) year = today.getFullYear();
  if (!period) period = Math.ceil((today.getMonth() + 1) / PERIODS[periodicity].months);
  const { dateFrom, dateTo } = periodRange(periodicity, year, period);

  const schema = getCurrentSchema() || 'public';
  const [income] = await sequelize.query(
    `SELECT
       COALESCE(SUM(sign * subtotal) FILTER (WHERE status = 'gravado'), 0)  AS gravado,
       COALESCE(SUM(sign * subtotal) FILTER (WHERE status = 'exento'), 0)   AS exento,
       COALESCE(SUM(sign * subtotal) FILTER (WHERE status = 'excluido'), 0) AS excluido
     FROM (
       SELECT CASE WHEN s.document_type = 'nota_credito' THEN -1 ELSE 1 END AS sign,
              COALESCE(si.subtotal, 0) AS subtotal,
              COALESCE(si.iva_status, CASE WHEN COALESCE(si.tax_percentage, 0) > 0 THEN 'gravado' ELSE 'exento' END) AS status
         FROM "${schema}"."sale_items" si
         JOIN "${schema}"."sales" s ON s.id = si.sale_id
        WHERE s.tenant_id = :tenantId
          AND s.status NOT IN ('cancelled', 'draft')
          AND (s.document_type IS NULL OR s.document_type IN ('factura', 'remision', 'nota_credito', 'nota_debito'))
          AND COALESCE(si.approval_status, '') <> 'rechazado'
          AND s.sale_date::date BETWEEN :dateFrom AND :dateTo
       UNION ALL
       -- Devoluciones de clientes sin nota crédito (p.ej. sobre remisiones o
       -- ventas POS): restan con el estado de IVA de la línea original.
       SELECT -1 AS sign,
              COALESCE(cri.subtotal, 0) AS subtotal,
              COALESCE(si.iva_status, CASE WHEN COALESCE(si.tax_percentage, 0) > 0 THEN 'gravado' ELSE 'exento' END) AS status
         FROM "${schema}"."customer_return_items" cri
         JOIN "${schema}"."customer_returns" cr ON cr.id = cri.return_id
         LEFT JOIN "${schema}"."sale_items" si ON si.id = cri.sale_item_id
        WHERE cr.tenant_id = :tenantId
          AND cr.status = 'approved'
          AND cr.credit_note_sale_id IS NULL
          AND COALESCE(cr.approved_at, cr.return_date)::date BETWEEN :dateFrom AND :dateTo
     ) x`,
    { replacements: { tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT, transaction }
  );
  const [exp] = await sequelize.query(
    `SELECT COALESCE(SUM(tax_amount), 0) AS iva, COUNT(*) FILTER (WHERE tax_amount > 0) AS n
       FROM "${schema}"."expenses"
      WHERE tenant_id = :tenantId AND expense_date::date BETWEEN :dateFrom AND :dateTo`,
    { replacements: { tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT, transaction }
  );

  const [pur] = await sequelize.query(
    `SELECT
       (SELECT COALESCE(SUM(pi.tax_amount), 0)
          FROM "${schema}"."purchase_items" pi
          JOIN "${schema}"."purchases" pu ON pu.id = pi.purchase_id
          JOIN "${schema}"."products" p ON p.id = pi.product_id
         WHERE pu.tenant_id = :tenantId
           AND pu.status IN ('received', 'partially_received')
           AND (p.product_type = 'raw_material' OR p.tax_config->>'iva_common' = 'true')
           AND COALESCE(p.tax_config->>'iva_status', '') <> 'excluido'
           AND pu.purchase_date::date BETWEEN :dateFrom AND :dateTo) AS bought,
       (SELECT COALESCE(SUM(sri.tax), 0)
          FROM "${schema}"."supplier_return_items" sri
          JOIN "${schema}"."supplier_returns" sr ON sr.id = sri.return_id
          JOIN "${schema}"."products" p ON p.id = sri.product_id
         WHERE sr.tenant_id = :tenantId
           AND sr.status = 'approved'
           AND (p.product_type = 'raw_material' OR p.tax_config->>'iva_common' = 'true')
           AND COALESCE(p.tax_config->>'iva_status', '') <> 'excluido'
           AND COALESCE(sr.approved_at, sr.return_date)::date BETWEEN :dateFrom AND :dateTo) AS returned`,
    { replacements: { tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT, transaction }
  );

  const gravado = round2(income.gravado);
  const exento = round2(income.exento);
  const excluido = round2(income.excluido);
  const withRight = Math.max(0, gravado + exento);
  const total = withRight + Math.max(0, excluido);
  // Sin ingresos en el período no hay base para prorratear: todo descontable.
  const deductiblePct = total > 0 ? withRight / total : 1;
  const commonIvaExpenses = ivaResponsible ? round2(exp.iva) : 0;
  const commonIvaPurchases = ivaResponsible ? round2(Number(pur.bought) - Number(pur.returned)) : 0;
  const commonIva = round2(commonIvaExpenses + commonIvaPurchases);
  const nonDeductible = round2(commonIva * (1 - deductiblePct));

  const existing = await findActiveEntry(tenantId, periodSourceId(tenantId, dateFrom, dateTo), transaction);

  return {
    periodicity,
    year: Number(year),
    period: Number(period),
    date_from: dateFrom,
    date_to: dateTo,
    iva_responsible: ivaResponsible,
    income: { gravado, exento, excluido, total: round2(total) },
    deductible_pct: Math.round(deductiblePct * 10000) / 100,
    common_iva: commonIva,
    common_iva_expenses: Number(exp.n || 0),
    common_iva_breakdown: {
      expenses: commonIvaExpenses,
      raw_material_purchases: round2(ivaResponsible ? pur.bought : 0),
      raw_material_returns: round2(ivaResponsible ? pur.returned : 0),
    },
    deductible_iva: round2(commonIva - nonDeductible),
    non_deductible_iva: nonDeductible,
    entry: existing ? { id: existing.id, entry_number: existing.entry_number, status: existing.status } : null,
  };
}

/**
 * Crea el asiento de ajuste en BORRADOR. body: { year, period, amount? }
 * amount permite al contador ajustar el valor calculado (p.ej. IVA común de
 * compras que no pasan por gastos).
 */
async function createProrrateoEntry(tenantId, { year, period, amount }, userId) {
  const t = await sequelize.transaction();
  try {
    const report = await computeIvaProrrateo(tenantId, { year, period }, t);
    if (!report.iva_responsible) throw badRequest('El negocio no es responsable de IVA: no hay IVA descontable que prorratear');
    if (report.entry) throw badRequest(`Ya existe el ajuste ${report.entry.entry_number} para este período. Anúlelo o revérselo si necesita rehacerlo.`);
    const value = amount !== undefined && amount !== null && amount !== '' ? round2(amount) : report.non_deductible_iva;
    if (!(value > 0)) throw badRequest('No hay IVA no descontable que ajustar en el período');

    const expenseAccount = await ensureProrrateoMapping(tenantId, t);
    const label = `${report.periodicity === 'cuatrimestral' ? 'cuatrimestre' : 'bimestre'} ${report.period} de ${report.year}`;
    const entry = await createDraftEntry(tenantId, {
      branchId: null,
      entryDate: report.date_to,
      sourceType: 'iva_prorrateo',
      sourceId: periodSourceId(tenantId, report.date_from, report.date_to),
      description: `Prorrateo IVA (art. 490 E.T.) ${label} — ${report.deductible_pct}% descontable`,
      lines: [
        { account_id: expenseAccount, debit: value, credit: 0, description: 'IVA común no descontable (ingresos excluidos)' },
        { account_id: await getMappedAccountId(tenantId, 'purchase_iva_descontable', t), debit: 0, credit: value, description: 'Ajuste IVA descontable por prorrateo' },
      ],
      createdBy: userId,
    }, t);

    await t.commit();
    return { ...report, entry: { id: entry.id, entry_number: entry.entry_number, status: entry.status }, amount: value };
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

module.exports = { computeIvaProrrateo, createProrrateoEntry, periodRange, PERIODS };
