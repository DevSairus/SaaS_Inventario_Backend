// backend/src/services/accounting/projectAccounting.service.js
//
// Contabilidad con dimensión de proyecto (Fase 3 del módulo Proyectos).
//
// 1. Consumo de materiales en la obra. Misma regla que el estado de
//    resultados del proyecto (projectPnl.service.js): lo que ENTRA a la bodega
//    de la obra (traslado recibido, compra recibida allí, traslado anulado
//    que vuelve, reversión de devolución a proveedor) es costo de obra; lo que
//    SALE de vuelta (traslado de reintegro, devolución a proveedor) lo
//    reduce. Por cada documento y proyecto:
//       entra:  Db project_material_cost (con proyecto) / Cr purchase_inventory
//       sale:   al revés
//    Los movimientos ya contabilizados quedan en project_material_postings.
//    Se dispara al crear movimientos en bodegas de obra (hook en
//    InventoryMovement, ver registerProjectMaterialHook) y un job diario
//    recoge lo pendiente. La venta desde la bodega de la obra no registra
//    costo de venta (autoEntries.service.js → isProjectWarehouse).
//
// 2. Reclasificación de la nómina repartida por horas. Al repartir un periodo
//    (projectLabor.service.js → allocatePeriod), por cada empleado y proyecto
//    se acreditan las mismas cuentas de gasto que debitó el comprobante de
//    nómina, en el % de horas del proyecto, y se debita
//    project_labor_cost con el proyecto. Lo que no se reparte sigue como gasto.
//    Volver a repartir anula/reversa el asiento anterior.
//
// Todo en borrador, como el resto de asientos automáticos. Si el tenant no
// tiene Contabilidad o le faltan los mapeos, no se hace nada (se registra).

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const { getCurrentSchema, runWithTenantSchema } = require('../../config/tenantContext');
const { createDraftEntry, getMappedAccountId } = require('./journalEntry.service');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const table = (name) => `"${getCurrentSchema() || 'public'}"."${name}"`;

const IN_REASONS = ['transfer_receive', 'purchase_receipt', 'transfer_cancel', 'supplier_return_reversal'];
const OUT_REASONS = ['transfer_send', 'supplier_return'];
const REASON_LABEL = {
  transfer_receive: 'traslado recibido en la obra',
  purchase_receipt: 'compra recibida en la obra',
  transfer_cancel: 'traslado anulado que vuelve a la obra',
  supplier_return_reversal: 'reversión de devolución a proveedor',
  transfer_send: 'reintegro desde la obra',
  supplier_return: 'devolución a proveedor desde la obra',
};

async function accountingEnabled(tenantId) {
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  return (await getEffectiveModulesForTenantId(tenantId)).includes('accounting');
}

// ── 1. Materiales ─────────────────────────────────────────────────────

/** Movimientos de bodegas de obra que todavía no tienen asiento de consumo. */
async function pendingMaterialMovements(tenantId, { projectId } = {}) {
  return sequelize.query(`
    SELECT m.id, m.reference_id, m.movement_reason, m.direction, m.total_cost,
           to_char(timezone('America/Bogota', m.movement_date)::date, 'YYYY-MM-DD') AS local_date,
           w.project_id, w.branch_id, p.code AS project_code
      FROM ${table('inventory_movements')} m
      JOIN ${table('warehouses')} w ON w.id = m.warehouse_id AND w.project_id IS NOT NULL
      JOIN ${table('projects')} p ON p.id = w.project_id
      LEFT JOIN ${table('project_material_postings')} pmp ON pmp.movement_id = m.id
     WHERE m.tenant_id = :tenantId
       AND pmp.movement_id IS NULL
       AND ((m.direction = 'in' AND m.movement_reason IN (:inReasons))
         OR (m.direction = 'out' AND m.movement_reason IN (:outReasons)))
       ${projectId ? 'AND w.project_id = :projectId' : ''}
     ORDER BY m.movement_date ASC
     LIMIT 5000
  `, {
    replacements: { tenantId, inReasons: IN_REASONS, outReasons: OUT_REASONS, projectId },
    type: sequelize.QueryTypes.SELECT,
  });
}

/**
 * Contabiliza el consumo de materiales pendiente del tenant. Idempotente.
 * @returns {{ entries: number, amount: number, skipped?: string, errors: string[] }}
 */
async function postProjectMaterials(tenantId, { userId = null, projectId = null } = {}) {
  if (!(await accountingEnabled(tenantId))) return { entries: 0, amount: 0, skipped: 'Sin módulo de contabilidad', errors: [] };
  const movements = await pendingMaterialMovements(tenantId, { projectId });
  if (!movements.length) return { entries: 0, amount: 0, errors: [] };

  // Un asiento por documento, proyecto, motivo y día.
  const groups = new Map();
  for (const m of movements) {
    const key = [m.reference_id || m.id, m.project_id, m.movement_reason, m.local_date].join('|');
    if (!groups.has(key)) groups.set(key, { ...m, ids: [], amount: 0, zeroIds: [] });
    const g = groups.get(key);
    const cost = Number(m.total_cost) || 0;
    g.ids.push(m.id);
    g.amount = round2(g.amount + cost);
  }

  let entries = 0;
  let amount = 0;
  const errors = [];
  for (const g of groups.values()) {
    const t = await sequelize.transaction();
    try {
      let entryId = null;
      if (g.amount > 0) {
        const costAccount = await getMappedAccountId(tenantId, 'project_material_cost', t);
        const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
        const isIn = g.direction === 'in';
        const label = REASON_LABEL[g.movement_reason] || g.movement_reason;
        const entry = await createDraftEntry(tenantId, {
          branchId: g.branch_id,
          entryDate: g.local_date,
          sourceType: 'project_material',
          sourceId: g.reference_id || null,
          description: `Materiales obra ${g.project_code}: ${label}`,
          createdBy: userId,
          lines: [
            { account_id: costAccount, debit: isIn ? g.amount : 0, credit: isIn ? 0 : g.amount, description: `Materiales de obra ${g.project_code} (${label})`, project_id: g.project_id },
            { account_id: inventoryAccount, debit: isIn ? 0 : g.amount, credit: isIn ? g.amount : 0, description: isIn ? 'Salida de inventario a la obra' : 'Reingreso a inventario desde la obra', project_id: null },
          ],
        }, t);
        entryId = entry.id;
        entries += 1;
        amount = round2(amount + g.amount);
      }
      // Costo cero también se marca, para no volver a evaluarlo.
      await sequelize.query(
        `INSERT INTO ${table('project_material_postings')} (movement_id, tenant_id, project_id, entry_id, created_at)
         SELECT unnest(ARRAY[:ids]::uuid[]), :tenantId, :projectId, :entryId, NOW()
         ON CONFLICT (movement_id) DO NOTHING`,
        { replacements: { ids: g.ids, tenantId, projectId: g.project_id, entryId }, transaction: t },
      );
      await t.commit();
    } catch (error) {
      await t.rollback();
      errors.push(`${g.project_code} ${g.local_date}: ${error.message}`);
    }
  }
  if (errors.length) logger.warn(`[project-accounting] Tenant ${tenantId}: ${errors.slice(0, 5).join(' | ')}`);
  return { entries, amount, errors };
}

// Disparo después de cada movimiento: se agrupa por tenant en el mismo tick.
const queued = new Map(); // tenantId -> schema
function queueMaterialPosting(tenantId) {
  if (!tenantId || queued.has(tenantId)) return;
  queued.set(tenantId, getCurrentSchema());
  setImmediate(() => {
    const schema = queued.get(tenantId);
    queued.delete(tenantId);
    runWithTenantSchema(schema || null, () => postProjectMaterials(tenantId))
      .catch((e) => logger.warn(`[project-accounting] Tenant ${tenantId}: ${e.message}`));
  });
}

// Solo nos interesan los movimientos que pueden afectar una obra.
const relevant = (m) => (m.direction === 'in' && IN_REASONS.includes(m.movement_reason))
  || (m.direction === 'out' && OUT_REASONS.includes(m.movement_reason));

function registerProjectMaterialHook(InventoryMovement) {
  const onCreated = (rows, options) => {
    const tenants = new Set(rows.filter(relevant).map((m) => m.tenant_id));
    if (!tenants.size) return;
    const fire = () => tenants.forEach(queueMaterialPosting);
    if (options?.transaction?.afterCommit) options.transaction.afterCommit(fire);
    else fire();
  };
  InventoryMovement.addHook('afterCreate', 'projectMaterialPosting', (m, options) => onCreated([m], options));
  InventoryMovement.addHook('afterBulkCreate', 'projectMaterialPosting', (rows, options) => onCreated(rows, options));
}

/** Job diario: lo que haya quedado pendiente en todos los tenants con proyectos. */
async function postAllTenantsProjectMaterials() {
  const { Tenant } = require('../../models');
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  const results = [];
  for (const t of tenants) {
    try {
      const mods = await getEffectiveModulesForTenantId(t.id);
      if (!mods.includes('projects') || !mods.includes('accounting')) continue;
      const r = await runWithTenantSchema(t.schema_name || null, () => postProjectMaterials(t.id));
      if (r.entries || r.errors.length) results.push({ tenant: t.id, ...r, errors: r.errors.length });
    } catch (err) {
      logger.warn(`[project-accounting] Tenant ${t.id}: ${err.message}`);
    }
  }
  return results;
}

// ── 2. Reclasificación de nómina ──────────────────────────────────────

async function payrollEntriesOfPeriod(tenantId, periodId, t) {
  const { JournalEntry, JournalEntryLine, ChartOfAccount } = require('../../models');
  return JournalEntry.findAll({
    where: {
      tenant_id: tenantId,
      source_type: ['payroll', 'payroll_provisions'],
      source_id: periodId,
      status: { [Op.ne]: 'voided' },
      reversed_by_entry_id: null,
    },
    include: [{
      model: JournalEntryLine,
      as: 'lines',
      include: [{ model: ChartOfAccount, as: 'account', attributes: ['id', 'account_type'] }],
    }],
    transaction: t,
  });
}

/**
 * Cuentas de gasto de nómina de cada empleado en el periodo, desde el
 * comprobante contable: devengados (líneas con el empleado como tercero) y su
 * parte de aportes y provisiones (líneas consolidadas por concepto).
 * Pura sobre los datos, para probarla aparte.
 * @returns {Map<employeeId, Map<accountId, amount>>}
 */
function expenseAccountsByEmployee({ lines, employeeCosts, mappedAccount }) {
  const isExpense = (l) => ['gasto', 'costo'].includes(l.account?.account_type) && Number(l.debit) > 0;
  const consolidated = new Set(lines.filter((l) => isExpense(l) && !l.third_party_id).map((l) => l.account_id));
  const out = new Map();
  for (const [employeeId, cost] of employeeCosts) {
    const accounts = new Map();
    const add = (accountId, amount) => {
      if (!accountId || !(amount > 0)) return;
      accounts.set(accountId, round2((accounts.get(accountId) || 0) + amount));
    };
    for (const l of lines) {
      if (isExpense(l) && l.third_party_id === employeeId) add(l.account_id, Number(l.debit) - Number(l.credit || 0));
    }
    for (const [concept, amount] of Object.entries(cost.by_concept?.aportes || {})) {
      const acc = mappedAccount(`payroll_employer:${concept}`);
      if (consolidated.has(acc)) add(acc, Number(amount) || 0);
    }
    for (const [concept, amount] of Object.entries(cost.by_concept?.provisiones || {})) {
      const acc = mappedAccount(`payroll_expense:${concept}`);
      if (consolidated.has(acc)) add(acc, Number(amount) || 0);
    }
    out.set(employeeId, accounts);
  }
  return out;
}

/**
 * Líneas del asiento de reclasificación. Pura, para probarla aparte.
 * allocations: [{ employee_id, project_id, percentage }]
 */
function buildLaborReclassLines({ allocations, accountsByEmployee, laborAccount, projectCodes = new Map() }) {
  const credits = new Map();
  const debits = [];
  for (const a of allocations) {
    const accounts = accountsByEmployee.get(a.employee_id);
    if (!accounts) continue;
    const pct = Number(a.percentage) / 100;
    let total = 0;
    for (const [accountId, amount] of accounts) {
      const part = round2(amount * pct);
      if (!part) continue;
      credits.set(accountId, round2((credits.get(accountId) || 0) + part));
      total = round2(total + part);
    }
    if (total > 0) debits.push({ project_id: a.project_id, amount: total });
  }
  // Débito agrupado por proyecto.
  const byProject = new Map();
  for (const d of debits) byProject.set(d.project_id, round2((byProject.get(d.project_id) || 0) + d.amount));
  const lines = [
    ...[...byProject].map(([projectId, amount]) => ({
      account_id: laborAccount, debit: amount, credit: 0,
      description: `Mano de obra de la obra ${projectCodes.get(projectId) || ''}`.trim(), project_id: projectId,
    })),
    ...[...credits].map(([accountId, amount]) => ({
      account_id: accountId, debit: 0, credit: amount, description: 'Reclasificación de nómina a obras', project_id: null,
    })),
  ];
  const total = round2([...byProject.values()].reduce((s, v) => s + v, 0));
  return { lines, total };
}

/**
 * Reclasifica a las obras la nómina repartida de un periodo. Se llama después
 * de allocatePeriod. No lanza: devuelve el resultado para mostrarlo.
 */
async function postLaborReclass(tenantId, period, userId) {
  try {
    if (!(await accountingEnabled(tenantId))) return { status: 'skipped', message: 'Sin módulo de contabilidad: el reparto queda solo en los proyectos' };
    const { ProjectLaborAllocation, Project } = require('../../models');
    const { reverseSourceEntries } = require('./autoEntries.service');
    const { employeeCostsForPeriod } = require('../projects/projectLabor.service');

    // El asiento anterior del periodo se anula (borrador) o se reversa.
    await reverseSourceEntries('project_labor', period.id, tenantId, userId, 'Nuevo reparto de nómina por proyecto');

    const allocations = await ProjectLaborAllocation.findAll({ where: { tenant_id: tenantId, payroll_period_id: period.id }, raw: true });
    if (!allocations.length) return { status: 'skipped', message: 'Sin horas repartidas en el periodo' };

    const entries = await payrollEntriesOfPeriod(tenantId, period.id);
    if (!entries.length) {
      return { status: 'skipped', message: 'El periodo no tiene comprobante contable de nómina: genéralo y vuelve a repartir para llevar la mano de obra a contabilidad' };
    }
    const lines = entries.flatMap((e) => e.lines.map((l) => l.toJSON()));
    const employeeIds = [...new Set(allocations.map((a) => a.employee_id))];
    const employeeCosts = await employeeCostsForPeriod(tenantId, period, employeeIds);
    const { AccountMapping } = require('../../models');
    const maps = await AccountMapping.findAll({ where: { tenant_id: tenantId, event_type: { [Op.like]: 'payroll%' } }, raw: true });
    const mapIndex = new Map(maps.map((m) => [m.event_type, m.account_id]));
    const accountsByEmployee = expenseAccountsByEmployee({ lines, employeeCosts, mappedAccount: (k) => mapIndex.get(k) });

    const projects = await Project.findAll({ where: { id: [...new Set(allocations.map((a) => a.project_id))] }, attributes: ['id', 'code'], raw: true });
    const laborAccount = await getMappedAccountId(tenantId, 'project_labor_cost');
    const { lines: entryLines, total } = buildLaborReclassLines({
      allocations, accountsByEmployee, laborAccount, projectCodes: new Map(projects.map((p) => [p.id, p.code])),
    });
    if (!(total > 0) || entryLines.length < 2) return { status: 'skipped', message: 'No hay gasto de nómina para reclasificar' };

    const allocated = round2(allocations.reduce((s, a) => s + Number(a.amount), 0));
    const entry = await sequelize.transaction((t) => createDraftEntry(tenantId, {
      branchId: period.branch_id || null,
      entryDate: period.end_date,
      sourceType: 'project_labor',
      sourceId: period.id,
      description: `Reclasificación de nómina a obras ${period.start_date} — ${period.end_date}`,
      createdBy: userId,
      lines: entryLines,
    }, t));
    return {
      status: 'posted',
      entry_number: entry.entry_number,
      amount: total,
      // Diferencia esperada: centavos de redondeo, o conceptos de la liquidación
      // que no tienen línea de gasto en el comprobante contable.
      difference: round2(allocated - total),
      message: `Asiento ${entry.entry_number} en borrador: ${total.toLocaleString('es-CO')} a costo de obra`,
    };
  } catch (error) {
    logger.warn(`[project-accounting] Reclasificación de nómina ${period.id}: ${error.message}`);
    return { status: 'error', message: error.message };
  }
}

// ── 3. Reportes ───────────────────────────────────────────────────────

/**
 * Resultado contable por proyecto (líneas con proyecto en cuentas de
 * ingreso, costo y gasto). Solo asientos contabilizados, salvo includeDrafts.
 */
async function projectLedgerSummary(tenantId, { from, to, projectId, includeDrafts = false } = {}) {
  const replacements = { tenantId, from: from || '1900-01-01', to: to || '2999-12-31', projectId: projectId || null };
  const rows = await sequelize.query(`
    SELECT l.project_id, p.code AS project_code, p.name AS project_name,
           a.account_type, a.code AS account_code, a.name AS account_name,
           SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM ${table('journal_entry_lines')} l
      JOIN ${table('journal_entries')} e ON e.id = l.entry_id
      JOIN ${table('chart_of_accounts')} a ON a.id = l.account_id
      JOIN ${table('projects')} p ON p.id = l.project_id
     WHERE e.tenant_id = :tenantId
       AND e.status ${includeDrafts ? "IN ('posted', 'draft')" : "= 'posted'"}
       AND e.entry_date BETWEEN :from AND :to
       AND a.account_type IN ('ingreso', 'costo', 'gasto')
       AND (CAST(:projectId AS uuid) IS NULL OR l.project_id = CAST(:projectId AS uuid))
     GROUP BY l.project_id, p.code, p.name, a.account_type, a.code, a.name
     ORDER BY p.code, a.code
  `, { replacements, type: sequelize.QueryTypes.SELECT });

  const projects = new Map();
  for (const r of rows) {
    if (!projects.has(r.project_id)) {
      projects.set(r.project_id, { project_id: r.project_id, code: r.project_code, name: r.project_name, ingresos: 0, costos: 0, gastos: 0, accounts: [] });
    }
    const p = projects.get(r.project_id);
    const net = r.account_type === 'ingreso' ? round2(Number(r.credit) - Number(r.debit)) : round2(Number(r.debit) - Number(r.credit));
    if (r.account_type === 'ingreso') p.ingresos = round2(p.ingresos + net);
    else if (r.account_type === 'costo') p.costos = round2(p.costos + net);
    else p.gastos = round2(p.gastos + net);
    p.accounts.push({ code: r.account_code, name: r.account_name, type: r.account_type, amount: net });
  }
  const list = [...projects.values()].map((p) => ({ ...p, utilidad: round2(p.ingresos - p.costos - p.gastos) }));
  return {
    from: from || null, to: to || null, include_drafts: Boolean(includeDrafts),
    projects: list,
    totals: {
      ingresos: round2(list.reduce((s, p) => s + p.ingresos, 0)),
      costos: round2(list.reduce((s, p) => s + p.costos, 0)),
      gastos: round2(list.reduce((s, p) => s + p.gastos, 0)),
      utilidad: round2(list.reduce((s, p) => s + p.utilidad, 0)),
    },
  };
}

module.exports = {
  postProjectMaterials, postAllTenantsProjectMaterials, registerProjectMaterialHook, queueMaterialPosting,
  postLaborReclass, projectLedgerSummary,
  // Para pruebas
  expenseAccountsByEmployee, buildLaborReclassLines, IN_REASONS, OUT_REASONS,
};
