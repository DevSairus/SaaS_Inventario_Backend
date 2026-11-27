'use strict';

// Tempario y productividad de técnicos.
//
//  - products.standard_hours / labor_pricing_mode: el tempario son los mismos
//    servicios de mano de obra (is_labor). 'hourly' = precio = horas × valor
//    hora de la empresa (business_config.labor_hour_rate), se recalcula solo;
//    'fixed' (o NULL) = precio propio, como hasta hoy.
//  - work_order_items.standard_hours: copia de las horas tempario por unidad
//    al agregar la línea (cambiar el tempario no altera OT anteriores).
//  - technician_schedules: jornada por técnico (horas por día de la semana),
//    para las horas disponibles sin depender de nómina.
//  - technician_absences: ausencias (vacaciones, incapacidad, permiso) que
//    descuentan horas disponibles.
//
// Solo agrega columnas y tablas; ningún dato existente cambia.
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS standard_hours DECIMAL(8, 2)`);
    await q(`ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS labor_pricing_mode VARCHAR(10)`);
    await q(`ALTER TABLE IF EXISTS work_order_items ADD COLUMN IF NOT EXISTS standard_hours DECIMAL(8, 2)`);

    await q(`
      CREATE TABLE IF NOT EXISTS technician_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id UUID NOT NULL,
        hours_by_weekday JSONB NOT NULL DEFAULT '{"1":8,"2":8,"3":8,"4":8,"5":8,"6":4,"0":0}'::jsonb,
        skip_holidays BOOLEAN NOT NULL DEFAULT true,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS technician_schedules_user_uq ON technician_schedules (tenant_id, user_id)`);

    await q(`
      CREATE TABLE IF NOT EXISTS technician_absences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id UUID NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason VARCHAR(30) NOT NULL DEFAULT 'otro',
        notes TEXT,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (end_date >= start_date)
      )`);
    await q(`CREATE INDEX IF NOT EXISTS technician_absences_user_idx ON technician_absences (tenant_id, user_id, start_date)`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS technician_absences');
    await q('DROP TABLE IF EXISTS technician_schedules');
    await q('ALTER TABLE IF EXISTS work_order_items DROP COLUMN IF EXISTS standard_hours');
    await q('ALTER TABLE IF EXISTS products DROP COLUMN IF EXISTS labor_pricing_mode');
    await q('ALTER TABLE IF EXISTS products DROP COLUMN IF EXISTS standard_hours');
  },
};
