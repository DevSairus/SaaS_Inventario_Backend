'use strict';

// 3.5 / 4.2 — Bitácora de estados de las devoluciones de venta y de compra.
// return_status_events: una fila por cambio de estado (quién, cuándo, nota).
// Las devoluciones que ya existen se rellenan desde sus columnas actuales
// (creación, aprobación, rechazo, reversión) para que su historial no
// arranque vacío. Idempotente: no duplica si ya hay eventos de esa devolución.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. to_regclass porque también corre en `public`.

const SOURCES = [
  { type: 'customer', table: 'customer_returns' },
  { type: 'supplier', table: 'supplier_returns' },
];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      CREATE TABLE IF NOT EXISTS return_status_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        return_type VARCHAR(10) NOT NULL CHECK (return_type IN ('customer', 'supplier')),
        return_id UUID NOT NULL,
        from_status VARCHAR(20),
        to_status VARCHAR(20) NOT NULL,
        user_id UUID,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_return_status_events_return ON return_status_events (return_type, return_id);
      CREATE INDEX IF NOT EXISTS idx_return_status_events_tenant ON return_status_events (tenant_id);
    `);

    for (const { type, table } of SOURCES) {
      // Creación: toda devolución nació 'pending' salvo las de anulación de venta
      // (creadas ya aprobadas; su evento de creación queda como 'approved').
      await q(`
        DO $$ BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            INSERT INTO return_status_events (tenant_id, return_type, return_id, from_status, to_status, user_id, note, created_at)
            SELECT r.tenant_id, '${type}', r.id, NULL,
                   CASE WHEN r.approved_at IS NOT NULL AND ABS(EXTRACT(EPOCH FROM (r.approved_at - r.created_at))) < 2 THEN 'approved' ELSE 'pending' END,
                   r.created_by, NULL, r.created_at
            FROM ${table} r
            WHERE NOT EXISTS (SELECT 1 FROM return_status_events e WHERE e.return_type = '${type}' AND e.return_id = r.id);
          END IF;
        END $$;
      `);
      // Aprobación (si no fue el evento de creación).
      await q(`
        DO $$ BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            INSERT INTO return_status_events (tenant_id, return_type, return_id, from_status, to_status, user_id, note, created_at)
            SELECT r.tenant_id, '${type}', r.id, 'pending', 'approved', r.approved_by, NULL, r.approved_at
            FROM ${table} r
            WHERE r.approved_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM return_status_events e WHERE e.return_type = '${type}' AND e.return_id = r.id AND e.to_status = 'approved');
          END IF;
        END $$;
      `);
      // Rechazo.
      await q(`
        DO $$ BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            INSERT INTO return_status_events (tenant_id, return_type, return_id, from_status, to_status, user_id, note, created_at)
            SELECT r.tenant_id, '${type}', r.id, 'pending', 'rejected', r.rejected_by, r.rejection_reason, COALESCE(r.rejected_at, r.updated_at)
            FROM ${table} r
            WHERE r.status = 'rejected'
              AND NOT EXISTS (SELECT 1 FROM return_status_events e WHERE e.return_type = '${type}' AND e.return_id = r.id AND e.to_status = 'rejected');
          END IF;
        END $$;
      `);
      // Reversión.
      await q(`
        DO $$ BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            INSERT INTO return_status_events (tenant_id, return_type, return_id, from_status, to_status, user_id, note, created_at)
            SELECT r.tenant_id, '${type}', r.id, 'approved', 'reversed', r.reversed_by, r.reversal_reason, COALESCE(r.reversed_at, r.updated_at)
            FROM ${table} r
            WHERE r.status = 'reversed'
              AND NOT EXISTS (SELECT 1 FROM return_status_events e WHERE e.return_type = '${type}' AND e.return_id = r.id AND e.to_status = 'reversed');
          END IF;
        END $$;
      `);
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS return_status_events`);
  },
};
