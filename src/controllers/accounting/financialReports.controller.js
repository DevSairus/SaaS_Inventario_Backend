const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const {
  generateTrialBalanceExcel,
  generateBalanceGeneralExcel,
  generateIncomeStatementExcel,
} = require('../../services/accounting/reportsExcel.service');
const {
  generateTrialBalancePDF,
  generateBalanceGeneralPDF,
  generateIncomeStatementPDF,
} = require('../../services/accounting/reportsPdf.service');

/**
 * Todas las consultas parten SOLO de asientos con status = 'posted'.
 * Los draft y voided no afectan ningún reporte — coherente con la decisión
 * de que los asientos automáticos nacen en borrador para revisión.
 */

// Nombre del usuario autenticado, para el pie "Generado por" de Excel/PDF.
function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

// ── Lógica de datos compartida entre el endpoint JSON y los exports ──

async function fetchTrialBalance(req) {
  const { from, to, branch_id } = req.query;
  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  const rows = await sequelize.query(
    `SELECT a.id, a.code, a.name, a.account_type,
            COALESCE(SUM(l.debit), 0)  AS total_debit,
            COALESCE(SUM(l.credit), 0) AS total_credit
     FROM chart_of_accounts a
     JOIN journal_entry_lines l ON l.account_id = a.id
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE a.tenant_id = :tenantId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date BETWEEN :from AND :to
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     GROUP BY a.id, a.code, a.name, a.account_type
     ORDER BY a.code ASC`,
    { replacements: { tenantId: req.tenant_id, from, to, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + Number(r.total_debit), credit: acc.credit + Number(r.total_credit) }),
    { debit: 0, credit: 0 }
  );

  return { accounts: rows, totals, branch_id: branch_id || null, from, to };
}

// GET /api/accounting/reports/trial-balance?from=&to=&branch_id=
// Balance de comprobación: movimientos débito/crédito por cuenta en el rango.
// branch_id es opcional: sin él, consolida todas las sedes del tenant (el
// plan de cuentas es único por tenant, branch_id solo filtra los asientos).
exports.trialBalance = async (req, res) => {
  try {
    const data = await fetchTrialBalance(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar balance de comprobación',
      error: error.message,
    });
  }
};

async function fetchBalanceGeneral(req) {
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    const branch_id = req.query.branch_id || null;

    const rows = await sequelize.query(
      `SELECT a.id, a.code, a.name, a.account_type,
              COALESCE(SUM(l.debit), 0)  AS total_debit,
              COALESCE(SUM(l.credit), 0) AS total_credit
       FROM chart_of_accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.tenant_id = :tenantId
         AND e.status = 'posted'
         AND e.entry_date <= :asOf
         AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
         AND a.account_type IN ('activo', 'pasivo', 'patrimonio')
       GROUP BY a.id, a.code, a.name, a.account_type
       ORDER BY a.code ASC`,
      { replacements: { tenantId: req.tenant_id, asOf, branchId: branch_id }, type: QueryTypes.SELECT }
    );

    // Utilidad/pérdida acumulada del período corriente (ingresos-costos-gastos
    // que aún no se han cerrado formalmente a patrimonio) se suma como una
    // línea informativa de "Resultado del ejercicio (no cerrado)".
    const [pnl] = await sequelize.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_type = 'ingreso' THEN l.credit - l.debit ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN a.account_type IN ('gasto','costo') THEN l.debit - l.credit ELSE 0 END), 0) AS expenses
       FROM chart_of_accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date <= :asOf
         AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)`,
      { replacements: { tenantId: req.tenant_id, asOf, branchId: branch_id }, type: QueryTypes.SELECT }
    );

    const netIncome = Number(pnl.revenue) - Number(pnl.expenses);

    const balance = (r) =>
      r.account_type === 'activo' ? Number(r.total_debit) - Number(r.total_credit) : Number(r.total_credit) - Number(r.total_debit);

    const activo = rows.filter((r) => r.account_type === 'activo').map((r) => ({ ...r, balance: balance(r) }));
    const pasivo = rows.filter((r) => r.account_type === 'pasivo').map((r) => ({ ...r, balance: balance(r) }));
    const patrimonio = rows.filter((r) => r.account_type === 'patrimonio').map((r) => ({ ...r, balance: balance(r) }));

    const totalActivo = activo.reduce((s, r) => s + r.balance, 0);
    const totalPasivo = pasivo.reduce((s, r) => s + r.balance, 0);
    const totalPatrimonio = patrimonio.reduce((s, r) => s + r.balance, 0) + netIncome;

    return {
      as_of: asOf,
      branch_id,
      activo,
      pasivo,
      patrimonio,
      resultado_no_cerrado: netIncome,
      totales: {
        total_activo: totalActivo,
        total_pasivo: totalPasivo,
        total_patrimonio: totalPatrimonio,
        cuadra: Math.abs(totalActivo - (totalPasivo + totalPatrimonio)) < 0.01,
      },
    };
}

// GET /api/accounting/reports/balance-general?as_of=&branch_id=
// Balance General: saldos acumulados de activo/pasivo/patrimonio hasta una fecha.
// branch_id es opcional: sin él, consolida todas las sedes del tenant.
exports.balanceGeneral = async (req, res) => {
  try {
    const data = await fetchBalanceGeneral(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al generar balance general', error: error.message });
  }
};

// Núcleo reutilizable de fetchIncomeStatement, sin depender de `req` — lo
// usa también cashFlowIndirect.controller.js para obtener la utilidad neta
// del período sin duplicar la consulta SQL.
async function fetchIncomeStatementForRange(tenantId, { from, to, branchId } = {}) {
    if (!from || !to) {
      const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
      err.statusCode = 400;
      throw err;
    }

    const rows = await sequelize.query(
      `SELECT a.id, a.code, a.name, a.account_type,
              COALESCE(SUM(l.credit - l.debit), 0) AS net_credit,
              COALESCE(SUM(l.debit - l.credit), 0) AS net_debit
       FROM chart_of_accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.tenant_id = :tenantId
         AND e.status = 'posted'
         AND e.entry_date BETWEEN :from AND :to
         AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
         AND a.account_type IN ('ingreso', 'gasto', 'costo')
       GROUP BY a.id, a.code, a.name, a.account_type
       ORDER BY a.code ASC`,
      { replacements: { tenantId, from, to, branchId: branchId || null }, type: QueryTypes.SELECT }
    );

    const ingresos = rows.filter((r) => r.account_type === 'ingreso').map((r) => ({ ...r, total: Number(r.net_credit) }));
    const costos = rows.filter((r) => r.account_type === 'costo').map((r) => ({ ...r, total: Number(r.net_debit) }));
    const gastos = rows.filter((r) => r.account_type === 'gasto').map((r) => ({ ...r, total: Number(r.net_debit) }));

    const totalIngresos = ingresos.reduce((s, r) => s + r.total, 0);
    const totalCostos = costos.reduce((s, r) => s + r.total, 0);
    const totalGastos = gastos.reduce((s, r) => s + r.total, 0);
    const utilidadBruta = totalIngresos - totalCostos;
    const utilidadNeta = utilidadBruta - totalGastos;

    return {
      from, to, branch_id: branchId || null,
      ingresos, costos, gastos,
      totales: { total_ingresos: totalIngresos, total_costos: totalCostos, utilidad_bruta: utilidadBruta, total_gastos: totalGastos, utilidad_neta: utilidadNeta },
      utilidad_neta: utilidadNeta,
    };
}
exports.fetchIncomeStatementForRange = fetchIncomeStatementForRange;

async function fetchIncomeStatement(req) {
    const { from, to, branch_id } = req.query;
    return fetchIncomeStatementForRange(req.tenant_id, { from, to, branchId: branch_id });
}

// GET /api/accounting/reports/income-statement?from=&to=&branch_id=
// Estado de Resultados (P&G) del rango de fechas.
// branch_id es opcional: sin él, consolida todas las sedes del tenant.
exports.incomeStatement = async (req, res) => {
  try {
    const data = await fetchIncomeStatement(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar estado de resultados',
      error: error.message,
    });
  }
};

/* ══════════════════════════════════════════════════════════════════
   BALANCE DE COMPROBACIÓN COMPARATIVO — 4.2 del análisis contable.
   Los reportes existentes son "de un período"; este junta dos rangos
   (el pedido + uno anterior, explícito o auto-calculado como el rango
   inmediatamente anterior de igual duración) y calcula la variación
   cuenta por cuenta. Reutiliza fetchTrialBalance para no duplicar la
   consulta base.
   ══════════════════════════════════════════════════════════════════ */

function previousPeriod(from, to) {
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  const spanDays = Math.round((toDate - fromDate) / 86400000) + 1; // inclusivo
  const prevTo = new Date(fromDate.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

async function fetchTrialBalanceComparative(req) {
  const { from, to, branch_id } = req.query;
  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  const compareFrom = req.query.compare_from;
  const compareTo = req.query.compare_to;
  const previous = compareFrom && compareTo ? { from: compareFrom, to: compareTo } : previousPeriod(from, to);

  const [current, prior] = await Promise.all([
    fetchTrialBalance({ tenant_id: req.tenant_id, query: { from, to, branch_id } }),
    fetchTrialBalance({ tenant_id: req.tenant_id, query: { from: previous.from, to: previous.to, branch_id } }),
  ]);

  const priorByAccount = new Map(prior.accounts.map((a) => [a.id, a]));
  const currentIds = new Set(current.accounts.map((a) => a.id));

  const balanceOf = (r) => Number(r.total_debit) - Number(r.total_credit); // signo crudo débito-crédito, igual para todas las cuentas (no se ajusta por naturaleza aquí: es un balance de comprobación, no un balance general)

  const accounts = current.accounts.map((a) => {
    const p = priorByAccount.get(a.id);
    const currentBalance = balanceOf(a);
    const priorBalance = p ? balanceOf(p) : 0;
    const variance = currentBalance - priorBalance;
    return {
      id: a.id, code: a.code, name: a.name, account_type: a.account_type,
      current_debit: Number(a.total_debit), current_credit: Number(a.total_credit),
      prior_debit: p ? Number(p.total_debit) : 0, prior_credit: p ? Number(p.total_credit) : 0,
      current_balance: currentBalance, prior_balance: priorBalance,
      variance, variance_pct: priorBalance !== 0 ? (variance / Math.abs(priorBalance)) * 100 : null,
    };
  });

  // Cuentas que sí tuvieron movimiento en el período anterior pero no en el actual —
  // deben aparecer igual (con current en cero) para no esconder que el saldo desapareció.
  for (const p of prior.accounts) {
    if (!currentIds.has(p.id)) {
      const priorBalance = balanceOf(p);
      accounts.push({
        id: p.id, code: p.code, name: p.name, account_type: p.account_type,
        current_debit: 0, current_credit: 0,
        prior_debit: Number(p.total_debit), prior_credit: Number(p.total_credit),
        current_balance: 0, prior_balance: priorBalance,
        variance: -priorBalance, variance_pct: priorBalance !== 0 ? -100 : null,
      });
    }
  }

  accounts.sort((a, b) => a.code.localeCompare(b.code));

  return {
    from, to, branch_id: branch_id || null,
    compare_from: previous.from, compare_to: previous.to,
    accounts,
    totals: {
      current: current.totals,
      prior: prior.totals,
    },
  };
}

// GET /api/accounting/reports/trial-balance-comparativo?from=&to=&compare_from=&compare_to=&branch_id=
exports.trialBalanceComparative = async (req, res) => {
  try {
    const data = await fetchTrialBalanceComparative(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar balance comparativo',
      error: error.message,
    });
  }
};

// GET /api/accounting/reports/trial-balance-comparativo/export?format=excel|pdf
exports.trialBalanceComparativeExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchTrialBalanceComparative(req);
    const name = generatedByName(req);

    const { generateTrialBalanceComparativeExcel } = require('../../services/accounting/reportsExcel.service');
    const { generateTrialBalanceComparativePDF } = require('../../services/accounting/reportsPdf.service');

    if (format === 'excel') {
      const buffer = await generateTrialBalanceComparativeExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Balance-Comparativo-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateTrialBalanceComparativePDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando balance comparativo:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar balance comparativo',
        error: error.message,
      });
    }
  }
};

/* ══════════════════════════════════════════════════════════════════
   EXPORTACIÓN EXCEL / PDF — Fase 1 del plan de informes contables.
   Un solo endpoint por reporte con ?format=excel|pdf, misma fuente de
   datos que el endpoint JSON (fetchTrialBalance / fetchBalanceGeneral /
   fetchIncomeStatement) para no duplicar la lógica de negocio.
   ══════════════════════════════════════════════════════════════════ */

// GET /api/accounting/reports/trial-balance/export?format=excel|pdf&from=&to=&branch_id=
exports.trialBalanceExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchTrialBalance(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateTrialBalanceExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Balance-Comprobacion-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateTrialBalancePDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando balance de comprobación:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar balance de comprobación',
        error: error.message,
      });
    }
  }
};

// GET /api/accounting/reports/balance-general/export?format=excel|pdf&as_of=&branch_id=
exports.balanceGeneralExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchBalanceGeneral(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateBalanceGeneralExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Balance-General-${data.as_of}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateBalanceGeneralPDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando balance general:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al exportar balance general', error: error.message });
    }
  }
};

// GET /api/accounting/reports/income-statement/export?format=excel|pdf&from=&to=&branch_id=
exports.incomeStatementExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchIncomeStatement(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateIncomeStatementExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Estado-Resultados-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateIncomeStatementPDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando estado de resultados:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar estado de resultados',
        error: error.message,
      });
    }
  }
};
