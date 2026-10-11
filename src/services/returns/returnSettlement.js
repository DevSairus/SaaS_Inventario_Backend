// backend/src/services/returns/returnSettlement.js
//
// Cómo se liquida el valor de una devolución (de cliente o a proveedor).
// Funciones puras: las usan el controlador al aprobar (con la venta/compra
// bloqueada), la vista previa del modal y los tests.
//
// Regla (la de una nota crédito): lo devuelto reduce PRIMERO lo que se debe
// -- la cartera del cliente o la cuenta por pagar al proveedor --; solo el
// excedente es dinero a devolver o saldo a favor. Antes se repartía en la
// proporción pagada del documento, que fallaba con devoluciones sucesivas y
// pagos intermedios (al cliente se le devolvía menos de lo que había pagado).
//
// Retenciones, en proporción a lo devuelto:
//  - Cliente: lo que el cliente retuvo (payment_history source 'retention')
//    nunca entró a caja: esa parte del excedente reversa la retención a
//    favor (1355) en vez de devolverse en dinero.
//  - Proveedor: lo que se le retuvo y se le debe a la DIAN (2365/2367/2368)
//    se reversa; el resto es lo que realmente baja la deuda con él.

'use strict';

const { saleBalance } = require('../../utils/saleAmounts');
const { purchaseBalance } = require('../../utils/purchaseAmounts');

const RETENTION_KEYS = ['retefuente', 'reteiva', 'reteica'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const zeroRetentions = () => ({ retefuente: 0, reteiva: 0, reteica: 0 });
const sumRetentions = (r) => round2(RETENTION_KEYS.reduce((s, k) => s + Number(r?.[k] || 0), 0));

/** Suma una lista de desgloses { retefuente, reteiva, reteica }. */
function addRetentions(list) {
  const total = zeroRetentions();
  for (const r of list || []) for (const k of RETENTION_KEYS) total[k] = round2(total[k] + Number(r?.[k] || 0));
  return total;
}

/**
 * Reversa proporcional: por tipo, `share` del total retenido, sin pasar de
 * lo que queda por reversar; y en conjunto, sin pasar de `cap`.
 */
function proportionalReversal(retained, alreadyReversed, share, cap = Infinity) {
  const out = zeroRetentions();
  for (const k of RETENTION_KEYS) {
    const available = Math.max(round2(Number(retained[k] || 0) - Number(alreadyReversed?.[k] || 0)), 0);
    out[k] = Math.min(round2(Number(retained[k] || 0) * share), available);
  }
  const total = sumRetentions(out);
  if (total > cap) {
    const factor = cap > 0 ? cap / total : 0;
    let assigned = 0;
    RETENTION_KEYS.forEach((k, i) => {
      out[k] = i === RETENTION_KEYS.length - 1 ? round2(Math.max(cap, 0) - assigned) : round2(out[k] * factor);
      assigned = round2(assigned + out[k]);
    });
  }
  return out;
}

/** Retenciones que el cliente practicó sobre la venta (registradas como pago). */
function saleRetentionsRetained(sale) {
  return addRetentions((sale?.payment_history || [])
    .filter((p) => p.source === 'retention')
    .map((p) => p.retentions || {}));
}

/**
 * @param {object} sale - con total_amount, paid_amount, returned_amount, payment_history
 * @param {number} returnTotal - total de la devolución (neto de descuento global)
 * @param {object} [priorReversal] - retenciones ya reversadas por devoluciones anteriores
 * @returns {{ reduction, retention_reversal, money_back }}
 */
function customerReturnSettlement(sale, returnTotal, priorReversal = {}) {
  const total = round2(returnTotal);
  const reduction = round2(Math.min(total, saleBalance(sale)));
  const excess = round2(total - reduction);
  const saleTotal = Number(sale?.total_amount || 0);
  const share = saleTotal > 0 ? Math.min(total / saleTotal, 1) : 0;
  const retention_reversal = proportionalReversal(saleRetentionsRetained(sale), priorReversal, share, excess);
  return {
    reduction,
    retention_reversal,
    money_back: round2(excess - sumRetentions(retention_reversal)),
  };
}

/** Retenciones practicadas al proveedor en la compra. */
function purchaseRetentionsRetained(purchase) {
  return {
    retefuente: Number(purchase?.retefuente_amount || 0),
    reteiva: Number(purchase?.reteiva_amount || 0),
    reteica: Number(purchase?.reteica_amount || 0),
  };
}

/**
 * @param {object} purchase - con total_amount, total_retentions, paid_amount, returned_amount, rete*_amount
 * @param {number} returnTotal
 * @param {object} [priorReversal]
 * @returns {{ reduction, retention_reversal, money_back }}
 */
function supplierReturnSettlement(purchase, returnTotal, priorReversal = {}) {
  const total = round2(returnTotal);
  const purchaseTotal = Number(purchase?.total_amount || 0);
  const share = purchaseTotal > 0 ? Math.min(total / purchaseTotal, 1) : 0;
  const retention_reversal = proportionalReversal(purchaseRetentionsRetained(purchase), priorReversal, share, total);
  const net = round2(total - sumRetentions(retention_reversal));
  const reduction = round2(Math.min(net, purchaseBalance(purchase)));
  return { reduction, retention_reversal, money_back: round2(net - reduction) };
}

module.exports = {
  RETENTION_KEYS,
  addRetentions,
  sumRetentions,
  customerReturnSettlement,
  supplierReturnSettlement,
  saleRetentionsRetained,
};
