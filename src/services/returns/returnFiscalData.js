// backend/src/services/returns/returnFiscalData.js
//
// Devoluciones APROBADAS en un rango de fechas (por fecha de aprobación, que
// es cuando se registra el hecho económico y su asiento), con lo que
// necesitan los reportes fiscales: exógena (1001, 1003, 1005, 1006, 1007) y
// los reportes/certificados de retenciones. Antes esos reportes leían solo
// ventas y compras: lo devuelto seguía declarado como ingreso, pago, IVA y
// retención.
//
// Una devolución reversada (status 'reversed') se deshizo: no se reporta.

'use strict';

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Base gravable neta de lo devuelto: subtotal menos su parte del descuento global. */
function netBase(r) {
  const subtotal = Number(r.subtotal || 0);
  const tax = Number(r.tax || 0);
  const discount = Number(r.discount_amount || 0);
  const gross = subtotal + tax;
  return round2(gross > 0 ? subtotal - discount * (subtotal / gross) : subtotal);
}
function netTax(r) {
  const subtotal = Number(r.subtotal || 0);
  const tax = Number(r.tax || 0);
  const discount = Number(r.discount_amount || 0);
  const gross = subtotal + tax;
  return round2(gross > 0 ? tax - discount * (tax / gross) : tax);
}

/**
 * Devoluciones de cliente aprobadas entre `from` y `to` (YYYY-MM-DD).
 * Incluye datos del cliente (de la venta) y las retenciones de la factura
 * para reversarlas en proporción a lo devuelto en los reportes que leen las
 * columnas de la venta.
 */
async function approvedCustomerReturns(tenantId, from, to, { customerId = null, branchId = null } = {}) {
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT cr.id, cr.return_number, cr.approved_at, cr.subtotal, cr.tax, cr.discount_amount, cr.total_amount,
            cr.retention_reversal,
            s.id AS sale_id, s.sale_number, s.sale_date, s.customer_id, s.customer_tax_id AS tax_id,
            s.customer_document_type AS document_type, s.customer_city_code AS city_code,
            s.customer_address AS address, s.subtotal AS sale_subtotal,
            s.retefuente_amount AS sale_retefuente, s.reteica_amount AS sale_reteica, s.reteiva_amount AS sale_reteiva,
            c.first_name, c.last_name, c.business_name, c.tax_id AS customer_tax_id
     FROM "${schema}"."customer_returns" cr
     JOIN "${schema}"."sales" s ON s.id = cr.sale_id
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE cr.tenant_id = :tenantId AND cr.status = 'approved'
       AND cr.approved_at >= :from::date AND cr.approved_at < (:to::date + INTERVAL '1 day')
       AND (:customerId::uuid IS NULL OR s.customer_id = :customerId::uuid)
       AND (:branchId::uuid IS NULL OR s.branch_id = :branchId::uuid)
     ORDER BY cr.approved_at ASC`,
    { replacements: { tenantId, from, to, customerId, branchId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => {
    const base = netBase(r);
    const saleSubtotal = Number(r.sale_subtotal || 0);
    const share = saleSubtotal > 0 ? Math.min(base / saleSubtotal, 1) : 0;
    return {
      ...r,
      base,
      tax_net: netTax(r),
      // Retenciones que la devolución realmente reversó (sobre lo que el
      // cliente retuvo y se registró -- returnSettlement.js), no la
      // estimación de la venta en proporción.
      retefuente_share: round2(Number(r.retention_reversal?.retefuente || 0)),
      reteica_share: round2(Number(r.retention_reversal?.reteica || 0)),
      reteiva_share: round2(Number(r.retention_reversal?.reteiva || 0)),
    };
  });
}

/** Devoluciones a proveedor aprobadas entre `from` y `to`, con el proveedor y su compra. */
async function approvedSupplierReturns(tenantId, from, to, { supplierId = null, branchId = null } = {}) {
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT sr.id, sr.return_number, sr.approved_at, sr.subtotal, sr.tax, sr.total_amount, sr.retention_reversal,
            sr.purchase_id, p.purchase_number, p.purchase_date, p.invoice_number, p.applied_retentions,
            p.retefuente_rate, p.reteiva_rate, p.reteica_rate, p.subtotal AS purchase_subtotal, p.tax_amount AS purchase_tax,
            s.id AS supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name,
            s.city_code, s.address, s.city AS supplier_city
     FROM "${schema}"."supplier_returns" sr
     JOIN "${schema}"."purchases" p ON p.id = sr.purchase_id
     JOIN "${schema}"."suppliers" s ON s.id = sr.supplier_id
     WHERE sr.tenant_id = :tenantId AND sr.status = 'approved'
       AND sr.approved_at >= :from::date AND sr.approved_at < (:to::date + INTERVAL '1 day')
       AND (:supplierId::uuid IS NULL OR sr.supplier_id = :supplierId::uuid)
       AND (:branchId::uuid IS NULL OR p.branch_id = :branchId::uuid)
     ORDER BY sr.approved_at ASC`,
    { replacements: { tenantId, from, to, supplierId, branchId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    ...r,
    base: round2(Number(r.subtotal || 0)),
    tax_net: round2(Number(r.tax || 0)),
    reversal: {
      retefuente: Number(r.retention_reversal?.retefuente || 0),
      reteiva: Number(r.retention_reversal?.reteiva || 0),
      reteica: Number(r.retention_reversal?.reteica || 0),
    },
  }));
}

/**
 * ¿La devolución es de un documento (venta/compra) de un año anterior al
 * reportado? Para la opción prior_year_returns de Exógena 1001/1003.
 */
function isPriorYearDocument(docDate, year) {
  if (!docDate) return false;
  const d = docDate instanceof Date ? docDate : new Date(`${String(docDate).slice(0, 10)}T12:00:00Z`);
  return d.getUTCFullYear() < Number(year);
}

module.exports = { approvedCustomerReturns, approvedSupplierReturns, netBase, netTax, isPriorYearDocument };
