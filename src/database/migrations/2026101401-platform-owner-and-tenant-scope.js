'use strict';

// Rol "owner" de plataforma + visibilidad de empresas por usuario de plataforma.
//
// El owner NO es un valor nuevo de users.role: es un super_admin con
// is_owner = true (hereda todo lo que el código ya le permite a super_admin)
// y además administra a los demás usuarios de plataforma (super_admin /
// support): quiénes son y qué empresas ven.
//
//   users.is_owner            -> solo aplica a role = 'super_admin'.
//   users.all_tenants_access  -> true (por defecto, comportamiento previo):
//                                ve todas las empresas y las funciones globales.
//                                false: solo las empresas de platform_user_tenants
//                                y nada global (planes, migraciones, config global...).
//   platform_user_tenants     -> empresas visibles para un usuario restringido.
//
// Se promueve a owner al super_admin activo más antiguo si todavía no hay
// ninguno: hoy todos los super_admin ya ven todo, así que no amplía accesos.

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS all_tenants_access BOOLEAN NOT NULL DEFAULT true`);

    await q(`
      CREATE TABLE IF NOT EXISTS platform_user_tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, tenant_id)
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_platform_user_tenants_user ON platform_user_tenants(user_id)`);

    await q(`
      UPDATE users SET is_owner = true
      WHERE id = (
        SELECT id FROM users
        WHERE role = 'super_admin' AND tenant_id IS NULL AND is_active = true
        ORDER BY created_at ASC
        LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = true)
    `);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS platform_user_tenants`);
    await q(`ALTER TABLE users DROP COLUMN IF EXISTS all_tenants_access`);
    await q(`ALTER TABLE users DROP COLUMN IF EXISTS is_owner`);
  },
};
