'use strict';

// Pantalla de taller (mapa de ocupación por bahía) — ver
// services/workshop/workshopBoard.service.js.
//
//   - workshop_bays: bahías / elevadores / puestos de cada sede. Nombre único
//     por sede (sin distinguir mayúsculas). Se pueden borrar si están libres
//     (las OTs entregadas que la usaron quedan con bay_id NULL) o desactivar.
//   - work_orders.bay_id: bahía que ocupa la OT (NULL = sin bahía). Una bahía
//     tiene como máximo UNA OT activa (recibido/en_proceso/en_espera/listo);
//     lo garantiza el índice único parcial uq_work_orders_bay: al entregar o
//     cancelar la OT la bahía se libera sola (hook del modelo), así que un
//     bay_id no nulo siempre es de una OT activa.
//   - work_orders.status_changed_at: desde cuándo está en el estado actual
//     (para "lleva 2 h en espera"). Sin backfill: las OTs existentes muestran
//     el tiempo desde received_at hasta su próximo cambio de estado.
//   - branches.workshop_display_token: token del enlace sin login que se abre
//     en el TV de la sede (/pantalla-taller/:token). NULL = sin pantalla.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. to_regclass porque también corre en `public`.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      DO $$ BEGIN
        IF to_regclass('branches') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS workshop_bays (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
            branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE ON UPDATE CASCADE,
            name VARCHAR(60) NOT NULL,
            kind VARCHAR(20) NOT NULL DEFAULT 'bahia',
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS uq_workshop_bays_name ON workshop_bays (branch_id, LOWER(name));
          CREATE INDEX IF NOT EXISTS idx_workshop_bays_tenant ON workshop_bays (tenant_id);

          ALTER TABLE branches ADD COLUMN IF NOT EXISTS workshop_display_token UUID;
          CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_workshop_display_token ON branches (workshop_display_token) WHERE workshop_display_token IS NOT NULL;
        END IF;
      END $$;
    `);

    await q(`
      DO $$ BEGIN
        IF to_regclass('work_orders') IS NOT NULL AND to_regclass('workshop_bays') IS NOT NULL THEN
          ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS bay_id UUID REFERENCES workshop_bays(id) ON DELETE SET NULL ON UPDATE CASCADE;
          ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP WITH TIME ZONE;
          CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_bay ON work_orders (bay_id) WHERE bay_id IS NOT NULL;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS uq_work_orders_bay`);
    await q(`ALTER TABLE IF EXISTS work_orders DROP COLUMN IF EXISTS status_changed_at`);
    await q(`ALTER TABLE IF EXISTS work_orders DROP COLUMN IF EXISTS bay_id`);
    await q(`DROP INDEX IF EXISTS uq_branches_workshop_display_token`);
    await q(`ALTER TABLE IF EXISTS branches DROP COLUMN IF EXISTS workshop_display_token`);
    await q(`DROP TABLE IF EXISTS workshop_bays`);
  },
};
