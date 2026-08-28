'use strict';

// Copia a `support_documents` cualquier dato real que ya exista en las
// columnas dian_* de `purchases` antes de darlas de baja (migración
// 2026082813). Solo migra filas que de verdad tuvieron un intento de
// emisión (dian_status distinto de 'not_applicable' o con número/CUDS ya
// asignado) — no crea una fila "vacía" por cada compra, a propósito: en
// support_documents la fila solo existe si el documento se generó.
//
// A la fecha de este plan no debería haber emisiones reales en producción
// (solo pruebas de habilitación, que no tocan `purchases`), así que este
// backfill es defensivo/idempotente más que necesario — pero se deja
// explícito para no perder nada si algo sí se alcanzó a generar.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;

    await q.query(`
      INSERT INTO support_documents (
        id, tenant_id, branch_id, source_type, purchase_id,
        support_document_number, cuds, dian_status, dian_response,
        dian_sent_at, dian_accepted_at, dian_error_message,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(), p.tenant_id, p.branch_id, 'purchase', p.id,
        p.support_document_number, p.cuds, p.dian_status, p.dian_response,
        p.dian_sent_at, p.dian_accepted_at, p.dian_error_message,
        COALESCE(p.dian_sent_at, p.created_at), NOW()
      FROM purchases p
      WHERE p.dian_status IS NOT NULL
        AND p.dian_status <> 'not_applicable'
        AND p.branch_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);

    console.log('[Migration] backfill de purchases.dian_* -> support_documents completado');
  },

  async down() {
    // No se revierte: es un backfill aditivo, borrar filas de
    // support_documents por origen implicaría adivinar cuáles eran
    // migradas vs. generadas después de correr esta migración.
  },
};
