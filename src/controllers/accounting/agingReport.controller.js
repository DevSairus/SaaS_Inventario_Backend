// backend/src/controllers/accounting/agingReport.controller.js
//
// 4.2 del análisis contable: "Reporte de antigüedad de cartera y cuentas
// por pagar (aging)". Ya existía el Libro Auxiliar (saldo corrido por
// tercero), pero no un reporte de vencidos 30/60/90 días.
//
// Cómo se calcula: Pitbox no maneja "facturas" contables individuales con
// fecha de vencimiento propia — cada venta/compra a crédito genera una
// línea de cartera/proveedores contra el tercero, y los abonos posteriores
// generan líneas que reducen ese saldo, todo sobre la misma cuenta. Para
// dar antigüedad por tramos, este reporte aplica el mismo criterio que
// usaría un contador manualmente: FIFO — cada abono se aplica primero
// contra el cargo más antiguo todavía abierto de ese tercero, y lo que
// queda abierto se clasifica por edad (hoy - fecha del cargo).
//
// Es intencionalmente de solo lectura, igual que journalIntegrity.service.js.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { AccountMapping } = require('../../models');
const { getCurrentSchema } = require('../../config/tenantContext');
const { generateAgingExcel } = require('../../services/accounting/reportsExcel.service');
const { generateAgingPDF } = require('../../services/accounting/reportsPdf.service');

const BUCKETS = [
  { key: 'current', label: 'Sin vencer', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1-30 días', min: 1, max: 30 },
  { key: 'd31_60', label: '31-60 días', min: 31, max: 60 },
  { key: 'd61_90', label: '61-90 días', min: 61, max: 90 },
  { key: 'd90_plus', label: 'Más de 90 días', min: 91, max: Infinity },
];

function bucketFor(days) {
  return BUCKETS.find((b) => days >= b.min && days <= b.max)?.key || 'd90_plus';
}

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

// FIFO de cargos vs abonos, sobre una lista de movimientos ya ordenados
// cronológicamente para UN tercero. Devuelve los cargos que quedan
// abiertos (total u parcialmente) con su monto pendiente.
function applyFifo(movements) {
  // Los "cargos" son los que aumentan el saldo (nueva cartera/cuenta por
  // pagar); los "abonos" son los que lo reducen (pagos, notas crédito,
  // devoluciones). El signo ya viene normalizado por naturaleza de cuenta
  // desde la consulta SQL (net > 0 = cargo, net < 0 = abono).
  const charges = [];
  let creditPool = 0; // abonos que llegaron antes de tener contra qué aplicarlos (caso raro, ej. anticipos)

  for (const m of movements) {
    if (m.net > 0) {
      let remaining = m.net;
      if (creditPool > 0) {
        const applied = Math.min(creditPool, remaining);
        creditPool -= applied;
        remaining -= applied;
      }
      if (remaining > 0.005) {
        charges.push({ date: m.date, amount: remaining, entry_number: m.entry_number, description: m.description });
      }
    } else if (m.net < 0) {
      let toApply = -m.net;
      for (const charge of charges) {
        if (toApply <= 0.005) break;
        if (charge.amount <= 0.005) continue;
        const applied = Math.min(charge.amount, toApply);
        charge.amount -= applied;
        toApply -= applied;
      }
      if (toApply > 0.005) creditPool += toApply; // abono sin cargo previo que cubrir
    }
  }

  return charges.filter((c) => c.amount > 0.005);
}

async function fetchAging(req) {
  const type = req.query.type === 'supplier' ? 'supplier' : 'customer';
  const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
  const branchId = req.query.branch_id || null;

  const mappingEvent = type === 'customer' ? 'sale_receivable' : 'purchase_payable';
  const mapping = await AccountMapping.findOne({ where: { tenant_id: req.tenant_id, event_type: mappingEvent } });

  if (!mapping) {
    return {
      type, as_of: asOf, branch_id: branchId,
      buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, total: 0 })),
      third_parties: [], grand_total: 0,
      warning: `No hay una cuenta mapeada para "${mappingEvent}" — configúrala en Mapeo de Cuentas para poder generar este reporte.`,
    };
  }

  // Naturaleza débito para cartera (activo): net = debit - credit.
  // Naturaleza crédito para proveedores (pasivo): net = credit - debit.
  const netExpr = type === 'customer' ? '(l.debit - l.credit)' : '(l.credit - l.debit)';

  // Sin calificar schema, esto siempre leía "public" -- para un tenant ya
  // cortado a su propio schema el reporte de cartera/CxP salía vacío sin
  // error visible.
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT l.third_party_id, e.entry_date AS date, e.entry_number, e.description AS entry_description,
            l.description AS line_description, ${netExpr} AS net
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE l.account_id = :accountId
       AND e.tenant_id = :tenantId
       AND e.status = 'posted'
       AND e.entry_date <= :asOf
       AND l.third_party_id IS NOT NULL
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
     ORDER BY l.third_party_id ASC, e.entry_date ASC, e.entry_number ASC`,
    { replacements: { accountId: mapping.account_id, tenantId: req.tenant_id, asOf, branchId }, type: QueryTypes.SELECT }
  );

  const { Customer, Supplier } = require('../../models');
  const Model = type === 'customer' ? Customer : Supplier;
  const thirdPartyIds = [...new Set(rows.map((r) => r.third_party_id))];
  const thirdParties = thirdPartyIds.length
    ? await Model.findAll({ where: { id: thirdPartyIds, tenant_id: req.tenant_id } })
    : [];
  const nameOf = (tp) => (type === 'customer'
    ? (tp.business_name || tp.full_name || [tp.first_name, tp.last_name].filter(Boolean).join(' '))
    : (tp.business_name || tp.name));
  const thirdPartyById = new Map(thirdParties.map((tp) => [tp.id, { name: nameOf(tp), tax_id: tp.tax_id }]));

  const byThirdParty = new Map();
  for (const r of rows) {
    if (!byThirdParty.has(r.third_party_id)) byThirdParty.set(r.third_party_id, []);
    byThirdParty.get(r.third_party_id).push({
      date: r.date,
      net: Number(r.net),
      entry_number: r.entry_number,
      description: r.line_description || r.entry_description || '',
    });
  }

  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  const bucketTotals = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  const thirdPartyResults = [];

  for (const [thirdPartyId, movements] of byThirdParty.entries()) {
    const openCharges = applyFifo(movements);
    if (openCharges.length === 0) continue;

    const bucketAmounts = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
    let total = 0;
    const detail = [];
    for (const charge of openCharges) {
      const days = Math.floor((asOfDate - new Date(`${charge.date}T00:00:00Z`)) / 86400000);
      const key = bucketFor(days);
      bucketAmounts[key] += charge.amount;
      bucketTotals[key] += charge.amount;
      total += charge.amount;
      detail.push({ ...charge, days_open: days, bucket: key });
    }

    const info = thirdPartyById.get(thirdPartyId) || { name: 'Desconocido', tax_id: null };
    thirdPartyResults.push({
      third_party_id: thirdPartyId,
      name: info.name,
      tax_id: info.tax_id,
      total,
      buckets: bucketAmounts,
      detail: detail.sort((a, b) => new Date(a.date) - new Date(b.date)),
    });
  }

  thirdPartyResults.sort((a, b) => b.total - a.total);
  const grandTotal = thirdPartyResults.reduce((s, t) => s + t.total, 0);

  return {
    type,
    as_of: asOf,
    branch_id: branchId,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, total: bucketTotals[b.key] })),
    third_parties: thirdPartyResults,
    grand_total: grandTotal,
  };
}

// GET /api/accounting/reports/aging?type=customer|supplier&as_of=&branch_id=
exports.aging = async (req, res) => {
  try {
    const data = await fetchAging(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar reporte de antigüedad de saldos',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/accounting/reports/aging/export?format=excel|pdf&type=&as_of=&branch_id=
exports.agingExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchAging(req);
    const name = generatedByName(req);
    const label = data.type === 'customer' ? 'Cartera' : 'Proveedores';

    if (format === 'excel') {
      const buffer = await generateAgingExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Antiguedad-${label}-${data.as_of}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateAgingPDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando reporte de antigüedad:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar reporte de antigüedad',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};
