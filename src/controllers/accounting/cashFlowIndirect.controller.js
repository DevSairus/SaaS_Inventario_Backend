// backend/src/controllers/accounting/cashFlowIndirect.controller.js
//
// 4.2 del análisis contable: "Estado de Flujo de Efectivo (método
// indirecto, desde asientos)". El "Flujo de Caja" que ya existe
// (finance/cashflow.controller.js) es caja operativa real (payment_history),
// útil para tesorería del día a día, pero no es un estado financiero
// formal derivado de la contabilidad con actividades de operación /
// inversión / financiación. Este reporte sí parte de journal_entries.
//
// Método: utilidad neta del período (ya calculada por
// fetchIncomeStatement) + variación de las cuentas de balance que no son
// caja, clasificadas por su rubro NIIF (data/niifRubros.js, ver classify):
//   - efectivo                                  -> es la caja misma, cifra de control
//   - PPE, intangibles, inversiones, activos no
//     corrientes                                -> inversión
//   - depreciación/deterioro acumulados (1592,
//     1599...)                                  -> operación (no son caja)
//   - obligaciones financieras, capital, prima  -> financiación
//   - todo lo demás de activo/pasivo            -> operación
//   - el resto del patrimonio (resultados, ORI) se excluye: el resultado ya
//     está en la utilidad neta; incluirlo de nuevo sería doble conteo.
//
// Se documenta la metodología también en el JSON de respuesta.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { fetchIncomeStatementForRange } = require('./financialReports.controller');
const { loadAccounts } = require('../../services/accounting/niifStatements.service');
const { generateCashFlowIndirectExcel } = require('../../services/accounting/reportsExcel.service');
const { generateCashFlowIndirectPDF } = require('../../services/accounting/reportsPdf.service');

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

// Clasificación por rubro NIIF (data/niifRubros.js), no por prefijo: así
// una cuenta que el contador marcó como obligación financiera no corriente
// o inversión cae donde debe aunque su código no sea el estándar.
const INVESTING_RUBROS = new Set(['ppe', 'intangibles', 'propiedades_inversion', 'inversiones_no_corrientes', 'deudores_no_corrientes', 'otros_activos_no_corrientes']);
const FINANCING_RUBROS = new Set(['obligaciones_financieras_corrientes', 'obligaciones_financieras_no_corrientes', 'capital', 'prima_superavit']);
// Depreciación, amortización y deterioro acumulados de PPE/intangibles: son
// gastos que no mueven caja; su variación se suma en operación (sección 7.18).
const NON_CASH_CONTRA = /^(1592|1597|1598|1599|1698|1699)/;

function classify(account) {
  const { rubro, account_type: accountType, code } = account;
  if (rubro === 'efectivo') return 'cash';
  if (accountType === 'patrimonio') return FINANCING_RUBROS.has(rubro) ? 'financing' : 'excluded';
  if ((rubro === 'ppe' || rubro === 'intangibles') && NON_CASH_CONTRA.test(String(code))) return 'operating';
  if (INVESTING_RUBROS.has(rubro)) return 'investing';
  if (FINANCING_RUBROS.has(rubro)) return 'financing';
  if (accountType === 'activo' || accountType === 'pasivo') return 'operating';
  return 'excluded';
}

// Saldo acumulado (débito-crédito crudo) de cada cuenta activo/pasivo/patrimonio
// hasta una fecha de corte (inclusive), en una sola pasada.
async function accountBalancesAsOf(tenantId, asOf, branchId) {
  // Sin calificar schema, esto siempre leía "public" -- ídem el resto de
  // los reportes financieros.
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT a.id, a.code, a.name, a.account_type,
            COALESCE(SUM(l.debit), 0) AS total_debit,
            COALESCE(SUM(l.credit), 0) AS total_credit
     FROM "${schema}"."chart_of_accounts" a
     JOIN "${schema}"."journal_entry_lines" l ON l.account_id = a.id
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE a.tenant_id = :tenantId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date <= :asOf
       AND a.account_type IN ('activo', 'pasivo', 'patrimonio')
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     GROUP BY a.id, a.code, a.name, a.account_type`,
    { replacements: { tenantId, asOf, branchId: branchId || null }, type: QueryTypes.SELECT }
  );
  const byId = new Map();
  for (const r of rows) {
    // Balance "crudo" débito-crédito; el signo se interpreta según
    // naturaleza al calcular la variación más abajo.
    byId.set(r.id, { code: r.code, name: r.name, account_type: r.account_type, balance: Number(r.total_debit) - Number(r.total_credit) });
  }
  return byId;
}

async function fetchCashFlowIndirect(req) {
  const { from, to, branch_id } = req.query;
  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  const openingAsOf = new Date(`${from}T00:00:00Z`);
  openingAsOf.setUTCDate(openingAsOf.getUTCDate() - 1);
  const openingDate = openingAsOf.toISOString().slice(0, 10);

  const [accounts, opening, closing, incomeStatement] = await Promise.all([
    loadAccounts(req.tenant_id),
    accountBalancesAsOf(req.tenant_id, openingDate, branch_id),
    accountBalancesAsOf(req.tenant_id, to, branch_id),
    fetchIncomeStatementForRange(req.tenant_id, { from, to, branchId: branch_id }),
  ]);

  const allIds = new Set([...opening.keys(), ...closing.keys()]);
  const operating = [];
  const investing = [];
  const financing = [];
  let cashOpening = 0;
  let cashClosing = 0;

  for (const id of allIds) {
    const o = opening.get(id);
    const c = closing.get(id);
    const ref = c || o;
    const bucket = classify({ ...ref, rubro: accounts.get(id)?.rubro });
    const openingBalance = o ? o.balance : 0;
    const closingBalance = c ? c.balance : 0;
    const delta = closingBalance - openingBalance;

    if (bucket === 'cash') {
      cashOpening += openingBalance;
      cashClosing += closingBalance;
      continue;
    }
    if (bucket === 'excluded' || Math.abs(delta) < 0.01) continue;

    // delta es la variación del saldo CRUDO (débito - crédito) para toda
    // cuenta. Un saldo más deudor es uso de caja (más activo o menos pasivo)
    // y uno más acreedor es fuente (más pasivo/patrimonio o menos activo):
    // el impacto es siempre -delta. Antes los pasivos usaban +delta y un
    // aumento de proveedores o anticipos restaba caja: el flujo no cuadraba.
    const cashImpact = -delta;
    const row = { id, code: ref.code, name: ref.name, opening_balance: openingBalance, closing_balance: closingBalance, variation: delta, cash_impact: cashImpact };

    if (bucket === 'operating') operating.push(row);
    else if (bucket === 'investing') investing.push(row);
    else if (bucket === 'financing') financing.push(row);
  }

  const sortByCode = (a, b) => a.code.localeCompare(b.code);
  operating.sort(sortByCode); investing.sort(sortByCode); financing.sort(sortByCode);

  const netIncome = incomeStatement.utilidad_neta;
  const operatingChangesTotal = operating.reduce((s, r) => s + r.cash_impact, 0);
  const investingTotal = investing.reduce((s, r) => s + r.cash_impact, 0);
  const financingTotal = financing.reduce((s, r) => s + r.cash_impact, 0);

  const operatingTotal = netIncome + operatingChangesTotal;
  const netCashFlow = operatingTotal + investingTotal + financingTotal;
  const cashVariationReal = cashClosing - cashOpening;

  return {
    from, to, branch_id: branch_id || null,
    net_income: netIncome,
    operating: { changes: operating, changes_total: operatingChangesTotal, total: operatingTotal },
    investing: { changes: investing, total: investingTotal },
    financing: { changes: financing, total: financingTotal },
    net_cash_flow: netCashFlow,
    cash: {
      opening: cashOpening, closing: cashClosing, real_variation: cashVariationReal,
      // Si el flujo calculado no coincide con la variación real de caja,
      // hay una cuenta sin clasificar o un movimiento fuera de las cuentas
      // de balance consideradas — se expone para que no pase inadvertido,
      // no se oculta el descuadre.
      matches: Math.abs(netCashFlow - cashVariationReal) < 1,
      difference: netCashFlow - cashVariationReal,
    },
    methodology_note: 'Método indirecto (NIIF para Pymes, sección 7): resultado del período + variación de las cuentas de balance distintas al efectivo, clasificadas por su rubro NIIF: inversión (propiedades, planta y equipo, intangibles, inversiones y activos no corrientes), financiación (obligaciones financieras y aportes de capital) y operación (lo demás, incluida la depreciación y el deterioro acumulados, que no son caja).',
  };
}

// GET /api/accounting/reports/cashflow-indirecto?from=&to=&branch_id=
exports.cashFlowIndirect = async (req, res) => {
  try {
    const data = await fetchCashFlowIndirect(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar el estado de flujo de efectivo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/accounting/reports/cashflow-indirecto/export?format=excel|pdf&from=&to=&branch_id=
exports.cashFlowIndirectExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchCashFlowIndirect(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateCashFlowIndirectExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Flujo-Efectivo-Indirecto-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateCashFlowIndirectPDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando flujo de efectivo indirecto:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar flujo de efectivo indirecto',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};
exports.fetchCashFlowIndirect = fetchCashFlowIndirect;
