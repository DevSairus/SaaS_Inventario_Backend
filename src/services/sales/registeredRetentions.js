// backend/src/services/sales/registeredRetentions.js
//
// Retenciones que el cliente REALMENTE practicó sobre una venta: las que se
// registran con "Retenciones" (sales.controller.js#registerRetentions) y
// quedan en payment_history como { source: 'retention', retentions: {
// retefuente, reteiva, reteica } } -- lo mismo que va a contabilidad
// (135520/135517/135518) y lo que dicen los certificados del cliente.
// Los campos sale.retefuente_amount/... son solo la ESTIMACIÓN al crear la
// venta; reportes y exógena deben leer de aquí.

// LATERAL que expone r.retefuente / r.reteiva / r.reteica por venta.
// Uso: `FROM sales s CROSS JOIN LATERAL ${registeredRetentionsLateral('s')} r`
function registeredRetentionsLateral(alias = 's') {
  return `(
    SELECT COALESCE(SUM((e->'retentions'->>'retefuente')::numeric), 0) AS retefuente,
           COALESCE(SUM((e->'retentions'->>'reteiva')::numeric), 0)    AS reteiva,
           COALESCE(SUM((e->'retentions'->>'reteica')::numeric), 0)    AS reteica
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${alias}.payment_history) = 'array' THEN ${alias}.payment_history ELSE '[]'::jsonb END
    ) e
    WHERE e->>'source' = 'retention'
  )`;
}

module.exports = { registeredRetentionsLateral };
