// backend/src/controllers/accounting/libroMayor.controller.js
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { ChartOfAccount } = require('../../models');
const {
  generateLibroMayorExcel,
} = require('../../services/accounting/reportsExcel.service');
const {
  generateLibroMayorPDF,
} = require('../../services/accounting/reportsPdf.service');

// Mismo límite que Libro Diario: el Libro Mayor devuelve una fila por línea
// de movimiento de la cuenta (no agregada) — un rango amplio en una cuenta
// muy transaccional (ej. Caja o Bancos) puede producir miles de filas.
const MAX_RANGE_DAYS = 366;

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

// Cuentas de naturaleza débito (activo/gasto/costo) aumentan su saldo con el
// débito; las de naturaleza crédito (pasivo/patrimonio/ingreso) aumentan su
// saldo con el crédito. Determina el signo del saldo corrido (running balance).
const DEBIT_NATURE = new Set(['activo', 'gasto', 'costo']);

async function fetchLibroMayor(req) {
  const { from, to, branch_id } = req.query;
  const { account_id } = req.params;

  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  const rangeDays = daysBetween(from, to);
  if (rangeDays < 0) {
    const err = new Error('El rango de fechas es inválido (from debe ser anterior a to)');
    err.statusCode = 400;
    throw err;
  }
  if (rangeDays > MAX_RANGE_DAYS) {
    const err = new Error(`El rango máximo para el Libro Mayor es de ${MAX_RANGE_DAYS} días. Genera el reporte por partes (ej. por trimestre) para un rango mayor.`);
    err.statusCode = 400;
    throw err;
  }

  const account = await ChartOfAccount.findOne({ where: { id: account_id, tenant_id: req.tenant_id } });
  if (!account) {
    const err = new Error('Cuenta no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const isDebitNature = DEBIT_NATURE.has(account.account_type);

  // Saldo inicial: todo lo contabilizado (posted) ANTES de `from`, con el
  // mismo filtro de sede que el resto del rango, para que el saldo inicial
  // sea consistente con lo que se está mostrando/exportando.
  const [openingRow] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = :accountId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date < :from
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)`,
    { replacements: { accountId: account_id, tenantId: req.tenant_id, from, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );

  const openingDebit = Number(openingRow.debit);
  const openingCredit = Number(openingRow.credit);
  const openingBalance = isDebitNature ? openingDebit - openingCredit : openingCredit - openingDebit;

  // Movimientos del rango, en orden cronológico (mismo orden que Libro Diario).
  const rows = await sequelize.query(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.description AS entry_description,
            e.source_type, e.branch_id,
            l.id AS line_id, l.debit, l.credit, l.description AS line_description, l.third_party_id
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = :accountId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date BETWEEN :from AND :to
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     ORDER BY e.entry_date ASC, e.entry_number ASC, l.line_order ASC`,
    { replacements: { accountId: account_id, tenantId: req.tenant_id, from, to, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );

  let running = openingBalance;
  const movements = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    running += isDebitNature ? debit - credit : credit - debit;
    return {
      entry_id: r.entry_id,
      entry_number: r.entry_number,
      entry_date: r.entry_date,
      entry_description: r.entry_description,
      source_type: r.source_type,
      branch_id: r.branch_id,
      line_id: r.line_id,
      debit,
      credit,
      description: r.line_description || r.entry_description || '',
      third_party_id: r.third_party_id,
      running_balance: running,
    };
  });

  const periodDebit = movements.reduce((s, m) => s + m.debit, 0);
  const periodCredit = movements.reduce((s, m) => s + m.credit, 0);

  return {
    from,
    to,
    branch_id: branch_id || null,
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      account_type: account.account_type,
    },
    opening_balance: openingBalance,
    closing_balance: running,
    movements,
    totals: { debit: periodDebit, credit: periodCredit },
    movement_count: movements.length,
  };
}

// GET /api/accounting/reports/libro-mayor/:account_id?from=&to=&branch_id=
exports.libroMayor = async (req, res) => {
  try {
    const data = await fetchLibroMayor(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar libro mayor',
      error: error.message,
    });
  }
};

// GET /api/accounting/reports/libro-mayor/:account_id/export?format=excel|pdf&from=&to=&branch_id=
exports.libroMayorExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchLibroMayor(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateLibroMayorExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Libro-Mayor-${data.account.code}-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateLibroMayorPDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando libro mayor:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar libro mayor',
        error: error.message,
      });
    }
  }
};
