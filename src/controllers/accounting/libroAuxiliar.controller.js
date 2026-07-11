// backend/src/controllers/accounting/libroAuxiliar.controller.js
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { Customer, Supplier } = require('../../models');
const {
  generateLibroAuxiliarExcel,
} = require('../../services/accounting/reportsExcel.service');
const {
  generateLibroAuxiliarPDF,
} = require('../../services/accounting/reportsPdf.service');

// Mismo límite que Libro Diario/Mayor: devuelve una fila por línea de
// movimiento del tercero (no agregada).
const MAX_RANGE_DAYS = 366;

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

// Mismo criterio que Libro Mayor: cuentas de naturaleza débito (activo, ej.
// cartera) aumentan su saldo con el débito; las de naturaleza crédito
// (pasivo, ej. cuentas por pagar) aumentan su saldo con el crédito.
const DEBIT_NATURE = new Set(['activo', 'gasto', 'costo']);

async function fetchLibroAuxiliar(req) {
  const { from, to, branch_id, third_party_id, third_party_type } = req.query;

  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }
  if (!third_party_id || !['customer', 'supplier'].includes(third_party_type)) {
    const err = new Error('third_party_id y third_party_type (customer|supplier) son obligatorios');
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
    const err = new Error(`El rango máximo para el Libro Auxiliar es de ${MAX_RANGE_DAYS} días. Genera el reporte por partes (ej. por trimestre) para un rango mayor.`);
    err.statusCode = 400;
    throw err;
  }

  const Model = third_party_type === 'customer' ? Customer : Supplier;
  const thirdParty = await Model.findOne({ where: { id: third_party_id, tenant_id: req.tenant_id } });
  if (!thirdParty) {
    const err = new Error(third_party_type === 'customer' ? 'Cliente no encontrado' : 'Proveedor no encontrado');
    err.statusCode = 404;
    throw err;
  }
  const thirdPartyName = third_party_type === 'customer'
    ? (thirdParty.business_name || thirdParty.full_name || [thirdParty.first_name, thirdParty.last_name].filter(Boolean).join(' '))
    : (thirdParty.business_name || thirdParty.name);

  // Saldo inicial: todo lo contabilizado (posted) ANTES de `from` para este
  // tercero, con el mismo signo por naturaleza de cuenta que Libro Mayor.
  const [openingRow] = await sequelize.query(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type IN ('activo','gasto','costo') THEN l.debit - l.credit ELSE l.credit - l.debit END), 0) AS balance
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE l.third_party_id = :thirdPartyId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date < :from
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)`,
    { replacements: { thirdPartyId: third_party_id, tenantId: req.tenant_id, from, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );
  const openingBalance = Number(openingRow.balance);

  // Movimientos del rango, en orden cronológico.
  const rows = await sequelize.query(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.description AS entry_description,
            e.source_type, e.branch_id,
            l.id AS line_id, l.account_id, a.code AS account_code, a.name AS account_name, a.account_type,
            l.debit, l.credit, l.description AS line_description
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE l.third_party_id = :thirdPartyId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date BETWEEN :from AND :to
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     ORDER BY e.entry_date ASC, e.entry_number ASC, l.line_order ASC`,
    { replacements: { thirdPartyId: third_party_id, tenantId: req.tenant_id, from, to, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );

  let running = openingBalance;
  const movements = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    const isDebitNature = DEBIT_NATURE.has(r.account_type);
    running += isDebitNature ? debit - credit : credit - debit;
    return {
      entry_id: r.entry_id,
      entry_number: r.entry_number,
      entry_date: r.entry_date,
      entry_description: r.entry_description,
      source_type: r.source_type,
      branch_id: r.branch_id,
      line_id: r.line_id,
      account_code: r.account_code,
      account_name: r.account_name,
      debit,
      credit,
      description: r.line_description || r.entry_description || '',
      running_balance: running,
    };
  });

  const periodDebit = movements.reduce((s, m) => s + m.debit, 0);
  const periodCredit = movements.reduce((s, m) => s + m.credit, 0);

  return {
    from,
    to,
    branch_id: branch_id || null,
    third_party: {
      id: thirdParty.id,
      type: third_party_type,
      name: thirdPartyName,
      tax_id: thirdParty.tax_id,
    },
    opening_balance: openingBalance,
    closing_balance: running,
    movements,
    totals: { debit: periodDebit, credit: periodCredit },
    movement_count: movements.length,
  };
}

// GET /api/accounting/reports/libro-auxiliar?third_party_id=&third_party_type=customer|supplier&from=&to=&branch_id=
exports.libroAuxiliar = async (req, res) => {
  try {
    const data = await fetchLibroAuxiliar(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar libro auxiliar',
      error: error.message,
    });
  }
};

// GET /api/accounting/reports/libro-auxiliar/export?format=excel|pdf&third_party_id=&third_party_type=&from=&to=&branch_id=
exports.libroAuxiliarExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchLibroAuxiliar(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateLibroAuxiliarExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Libro-Auxiliar-${data.third_party.name}-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateLibroAuxiliarPDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando libro auxiliar:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar libro auxiliar',
        error: error.message,
      });
    }
  }
};
