'use strict';

// Los porcentajes de recargo de horas extra/dominicales/festivas NO son
// una constante fija: la Ley 2466 de 2025 los está subiendo por etapas
// (recargo dominical/festivo: 75% hasta jun-2025, 80% desde jul-2025, 90%
// desde jul-2026, 100% desde jul-2027). Antes el usuario tenía que escribir
// el porcentaje a mano en cada novedad de horas extra — ahora el
// administrador lo configura UNA vez aquí y se usa como valor por defecto
// (editable) al crear una novedad de esa categoría. Una fila por tenant.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      CREATE TABLE IF NOT EXISTS payroll_settings (
        tenant_id UUID PRIMARY KEY REFERENCES "public"."tenants"(id) ON DELETE CASCADE,
        -- Porcentajes "adicionales" (no el factor total) — vigentes desde
        -- jul-2026 según Ley 2466 de 2025 (ver comentario en el modelo).
        heds_percentage NUMERIC(6,2) NOT NULL DEFAULT 25,
        hens_percentage NUMERIC(6,2) NOT NULL DEFAULT 75,
        hrns_percentage NUMERIC(6,2) NOT NULL DEFAULT 35,
        heddfs_percentage NUMERIC(6,2) NOT NULL DEFAULT 115,
        hrddfs_percentage NUMERIC(6,2) NOT NULL DEFAULT 90,
        hendfs_percentage NUMERIC(6,2) NOT NULL DEFAULT 165,
        hrndfs_percentage NUMERIC(6,2) NOT NULL DEFAULT 125,
        updated_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    console.log('[Migration] +payroll_settings (porcentajes de recargo configurables por tenant)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DROP TABLE IF EXISTS payroll_settings`);
  },
};
