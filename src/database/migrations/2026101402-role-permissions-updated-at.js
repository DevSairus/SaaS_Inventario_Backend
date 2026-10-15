'use strict';

// models/auth/RolePermission.js usa timestamps (created_at + updated_at), pero
// la tabla nunca tuvo updated_at: toda consulta del modelo fallaba ("no existe
// la columna RolePermission.updated_at") y la pantalla de Permisos por rol del
// superadmin respondía 500.
//
// Calificado con public.: migrateAllTenantSchemas también corre las
// migraciones con el search_path de cada tenant.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE public.role_permissions DROP COLUMN IF EXISTS updated_at`);
  },
};
