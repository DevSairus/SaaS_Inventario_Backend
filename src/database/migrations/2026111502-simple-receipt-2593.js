'use strict';

// Formulario 2593 — Recibo electrónico del SIMPLE (Resolución DIAN 000081
// de 2024). Ver services/tax/simple2593.service.js.
//
//   ica_activities.simple_group  grupo de actividades del art. 908 E.T. de
//                                cada actividad ICA: '1', '2', '3', '3p'
//                                (el "Grupo 3 (sic)": servicios profesionales)
//                                o '6' (CIIU 4665, 3830, 3811).
//   ica_activities.simple_rate   tarifa ICA consolidada (por mil) que el
//                                municipio adoptó para el SIMPLE; vacía = la
//                                del ICA más avisos y tableros y bomberil.
//   simple_receipts              un recibo por año y bimestre: valores que se
//                                digitan a mano (inputs) y, al marcarlo
//                                presentado, la foto de las casillas (result)
//                                de donde sale el excedente del bimestre
//                                siguiente.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q('ALTER TABLE ica_activities ADD COLUMN IF NOT EXISTS simple_group VARCHAR(4)');
      await q('ALTER TABLE ica_activities ADD COLUMN IF NOT EXISTS simple_rate DECIMAL(7, 4)');
      await q(`
        CREATE TABLE IF NOT EXISTS simple_receipts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          year INTEGER NOT NULL,
          period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 6),
          status VARCHAR(12) NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'presentado')),
          inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
          result JSONB,
          form_number VARCHAR(40),
          presented_at TIMESTAMP WITH TIME ZONE,
          presented_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, year, period)
        )
      `);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS simple_receipts');
    await queryInterface.sequelize.query('ALTER TABLE ica_activities DROP COLUMN IF EXISTS simple_rate');
    await queryInterface.sequelize.query('ALTER TABLE ica_activities DROP COLUMN IF EXISTS simple_group');
  },
};
