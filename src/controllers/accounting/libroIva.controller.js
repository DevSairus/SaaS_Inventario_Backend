// backend/src/controllers/accounting/libroIva.controller.js
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { AccountMapping } = require('../../models');
const {
  generateLibroIvaExcel,
} = require('../../services/accounting/reportsExcel.service');
const {
  generateLibroIvaPDF,
} = require('../../services/accounting/reportsPdf.service');

// Mismo límite que Libro Diario/Mayor/Auxiliar.
const MAX_RANGE_DAYS = 366;

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

async function fetchAccountMovements(tenantId, accountId, { from, to, branchId }) {
  if (!accountId) return [];
  return sequelize.query(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.description AS entry_description, e.source_type,
            l.debit, l.credit, l.description AS line_description
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = :accountId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date BETWEEN :from AND :to
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     ORDER BY e.entry_date ASC, e.entry_number ASC`,
    { replacements: { accountId, tenantId, from, to, branchId: branchId || null }, type: QueryTypes.SELECT }
  );
}

/**
 * Libro de IVA — agregación de IVA generado (ventas) vs IVA descontable
 * (compras) en el período, resuelto vía account_mappings (event_type
 * sale_tax_iva / purchase_iva_descontable), sin necesidad de tabla nueva.
 * Si el tenant no tiene alguno de los dos eventos mapeados todavía, esa
 * sección simplemente sale vacía (no bloquea el reporte).
 */
async function fetchLibroIva(req) {
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
    const err = new Error(`El rango máximo para el Libro de IVA es de ${MAX_RANGE_DAYS} días. Genera el reporte por partes (ej. por bimestre) para un rango mayor.`);
    err.statusCode = 400;
    throw err;
  }

  const [generadoMapping, descontableMapping] = await Promise.all([
    AccountMapping.findOne({ where: { tenant_id: req.tenant_id, event_type: 'sale_tax_iva' } }),
    AccountMapping.findOne({ where: { tenant_id: req.tenant_id, event_type: 'purchase_iva_descontable' } }),
  ]);

  const [generadoRows, descontableRows] = await Promise.all([
    fetchAccountMovements(req.tenant_id, generadoMapping?.account_id, { from, to, branchId: branch_id }),
    fetchAccountMovements(req.tenant_id, descontableMapping?.account_id, { from, to, branchId: branch_id }),
  ]);

  const generado = generadoRows.map((r) => ({
    entry_id: r.entry_id,
    entry_number: r.entry_number,
    entry_date: r.entry_date,
    description: r.line_description || r.entry_description || '',
    source_type: r.source_type,
    amount: Number(r.credit) - Number(r.debit),
  }));
  const descontable = descontableRows.map((r) => ({
    entry_id: r.entry_id,
    entry_number: r.entry_number,
    entry_date: r.entry_date,
    description: r.line_description || r.entry_description || '',
    source_type: r.source_type,
    amount: Number(r.debit) - Number(r.credit),
  }));

  const totalGenerado = generado.reduce((s, r) => s + r.amount, 0);
  const totalDescontable = descontable.reduce((s, r) => s + r.amount, 0);

  return {
    from,
    to,
    branch_id: branch_id || null,
    generado,
    descontable,
    totals: {
      generado: totalGenerado,
      descontable: totalDescontable,
      iva_a_pagar: totalGenerado - totalDescontable,
    },
  };
}

// GET /api/accounting/reports/libro-iva?from=&to=&branch_id=
exports.libroIva = async (req, res) => {
  try {
    const data = await fetchLibroIva(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar libro de IVA',
      error: error.message,
    });
  }
};

// GET /api/accounting/reports/libro-iva/export?format=excel|pdf&from=&to=&branch_id=
exports.libroIvaExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchLibroIva(req);
    const name = generatedByName(req);

    if (format === 'excel') {
      const buffer = await generateLibroIvaExcel(data, req.tenant, { from: data.from, to: data.to }, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Libro-IVA-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateLibroIvaPDF(res, data, req.tenant, { from: data.from, to: data.to }, name);
  } catch (error) {
    console.error('Error exportando libro de IVA:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar libro de IVA',
        error: error.message,
      });
    }
  }
};
