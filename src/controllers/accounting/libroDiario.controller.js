// backend/src/controllers/accounting/libroDiario.controller.js
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const {
  generateLibroDiarioExcel,
} = require('../../services/accounting/reportsExcel.service');
const {
  generateLibroDiarioPDF,
} = require('../../services/accounting/reportsPdf.service');

// Límite de rango de fechas: el Libro Diario devuelve una fila por línea de
// asiento (no agregada, a diferencia de trial-balance/balance-general/income
// -statement) — un tenant con mucho movimiento y un rango amplio puede
// producir decenas de miles de filas y reventar memoria generando el Excel.
// 366 días cubre "un año contable completo" de un solo golpe; para rangos
// mayores el contador debe partir la consulta (ej. por trimestre).
const MAX_RANGE_DAYS = 366;

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

async function fetchLibroDiario(req) {
  const { from, to, branch_id } = req.query;
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
    const err = new Error(`El rango máximo para el Libro Diario es de ${MAX_RANGE_DAYS} días. Genera el reporte por partes (ej. por trimestre) para un rango mayor.`);
    err.statusCode = 400;
    throw err;
  }

  // Sin calificar schema, esto siempre leía "public" -- para un tenant ya
  // cortado a su propio schema (schema-per-tenant) la query no encontraba
  // nada y el Libro Diario salía vacío sin ningún error visible.
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.description AS entry_description,
            e.source_type, e.branch_id,
            l.id AS line_id, l.account_id, a.code AS account_code, a.name AS account_name,
            l.debit, l.credit, l.description AS line_description, l.third_party_id, l.line_order
     FROM "${schema}"."journal_entries" e
     JOIN "${schema}"."journal_entry_lines" l ON l.entry_id = e.id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date BETWEEN :from AND :to
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     ORDER BY e.entry_date ASC, e.entry_number ASC, l.line_order ASC`,
    { replacements: { tenantId: req.tenant_id, from, to, branchId: branch_id || null }, type: QueryTypes.SELECT }
  );

  // Agrupar filas planas en asientos con sus líneas, preservando el orden.
  const entriesMap = new Map();
  for (const r of rows) {
    if (!entriesMap.has(r.entry_id)) {
      entriesMap.set(r.entry_id, {
        id: r.entry_id,
        entry_number: r.entry_number,
        entry_date: r.entry_date,
        description: r.entry_description,
        source_type: r.source_type,
        branch_id: r.branch_id,
        lines: [],
        total_debit: 0,
        total_credit: 0,
      });
    }
    const entry = entriesMap.get(r.entry_id);
    entry.lines.push({
      id: r.line_id,
      account_id: r.account_id,
      account_code: r.account_code,
      account_name: r.account_name,
      debit: Number(r.debit),
      credit: Number(r.credit),
      description: r.line_description,
      third_party_id: r.third_party_id,
    });
    entry.total_debit += Number(r.debit);
    entry.total_credit += Number(r.credit);
  }

  const entries = Array.from(entriesMap.values());
  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + Number(r.debit), credit: acc.credit + Number(r.credit) }),
    { debit: 0, credit: 0 }
  );

  return {
    from,
    to,
    branch_id: branch_id || null,
    entries,
    rows, // filas planas (una por línea) — lo que consumen los exports Excel/PDF
    totals,
    entry_count: entries.length,
    line_count: rows.length,
  };
}

// GET /api/accounting/reports/libro-diario?from=&to=&branch_id=
exports.libroDiario = async (req, res) => {
  try {
    const data = await fetchLibroDiario(req);
    // No se manda `rows` (formato plano) en la respuesta JSON de pantalla,
    // solo `entries` agrupados — rows es un detalle interno para exports.
    const { rows, ...payload } = data;
    res.json({ success: true, data: payload });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar libro diario',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/accounting/reports/libro-diario/export?format=excel|pdf&from=&to=&branch_id=
exports.libroDiarioExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchLibroDiario(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateLibroDiarioExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Libro-Diario-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateLibroDiarioPDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando libro diario:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar libro diario',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};
