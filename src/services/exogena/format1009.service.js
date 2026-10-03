// backend/src/services/exogena/format1009.service.js
//
// Formato 1009 — Saldo de cuentas por pagar (pasivos) al 31 de diciembre.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo B.
// Anexo técnico: T3.23 (F1009 v7, Resolución 000227/2025).
//
// Concepto 2201 "El valor del saldo de los pasivos con proveedores"
// (Artículo 1.3.5.6.1, tabla de conceptos ítem 1) -- único concepto
// relevante al perfil de tenants de Pitbox (no manejan pasivos con
// vinculados/accionistas, cálculo actuarial, depósitos judiciales, etc.
// vía este módulo). Igual que en 1008, no se pide mapeo de concepto: no hay
// ambigüedad real para este perfil de negocio.
//
// Fuente: Purchase (compras a proveedores) con saldo pendiente. Expense con
// proveedor y saldo pendiente también aplica (es un pasivo con proveedor
// igual que una compra), se incluye en la misma consulta.
//
// Atributos según XSD: cpt, tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, dir,
// dpto, mun, pais, sal.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapSupplierToExogena } = require('./thirdPartyMapper');

const CONCEPT_ACCOUNTS_PAYABLE = '2201';

async function buildRecords(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const cutoff = `${year}-12-31`;

  const purchaseRows = await sequelize.query(
    `SELECT p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address,
            -- Saldo con el proveedor: neto de retenciones (lo retenido es un
            -- pasivo con la DIAN, no con el proveedor).
            SUM(p.total_amount - COALESCE(p.total_retentions, 0) - p.paid_amount) AS sal
     FROM "${schema}"."purchases" p
     JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
     WHERE p.tenant_id = :tenantId
       -- Obligación real: recibida (total/parcial) o confirmada con factura.
       AND (p.status IN ('partially_received', 'received')
            OR (p.status = 'confirmed' AND COALESCE(p.invoice_number, '') <> ''))
       AND p.payment_status IN ('pending', 'partial')
       AND p.purchase_date <= :cutoff
     GROUP BY p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );

  const expenseRows = await sequelize.query(
    `SELECT e.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address,
            SUM(e.total_amount - COALESCE(e.total_retentions, 0) - e.paid_amount) AS sal
     FROM "${schema}"."expenses" e
     JOIN "${schema}"."suppliers" s ON s.id = e.supplier_id
     WHERE e.tenant_id = :tenantId AND e.supplier_id IS NOT NULL
       AND e.payment_status IN ('pending', 'partial')
       AND e.expense_date <= :cutoff
     GROUP BY e.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );

  const bySupplier = new Map();
  for (const row of [...purchaseRows, ...expenseRows]) {
    const balance = Number(row.sal || 0);
    if (balance <= 0) continue;
    if (!bySupplier.has(row.supplier_id)) {
      bySupplier.set(row.supplier_id, { ...row, sal: 0 });
    }
    bySupplier.get(row.supplier_id).sal += balance;
  }

  const skipped = [];
  const records = [];
  for (const row of bySupplier.values()) {
    if (!row.tax_id) {
      skipped.push({ reason: 'proveedor_sin_nit', supplier_id: row.supplier_id });
      continue;
    }
    const thirdParty = mapSupplierToExogena(row);
    records.push({
      cpt: CONCEPT_ACCOUNTS_PAYABLE,
      ...thirdParty,
      sal: Math.round(row.sal),
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1009',
  version: 7,
  recordElementName: 'saldoscp',
  totalValueField: 'sal',
  buildRecords,
};
