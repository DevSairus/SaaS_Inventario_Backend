'use strict';

// Permisos por empresa (Fase 2 del módulo Proyectos, ver
// config/permissions.catalog.js y services/tenantPermissions.service.js).
//
//   - Rol nuevo 'inventory_lead' (Líder de inventarios) en el CHECK de
//     public.users.
//   - tenant_role_permissions: lo que cada empresa cambió frente a los
//     permisos por defecto del catálogo (allowed true/false por rol y
//     permiso). Sin filas = comportamiento por defecto, igual al de antes.
//
// users vive en public; tenant_role_permissions va en el schema de cada
// tenant (migrateAllTenantSchemas corre esto con su search_path).

const ROLES = ['super_admin', 'admin', 'manager', 'seller', 'warehouse_keeper', 'inventory_lead', 'accountant', 'user', 'viewer', 'technician', 'support'];

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS users_role_check`);
      await q(`ALTER TABLE "public"."users" ADD CONSTRAINT users_role_check CHECK (role IN (${ROLES.map((r) => `'${r}'`).join(', ')}))`);

      await q(`
        CREATE TABLE IF NOT EXISTS tenant_role_permissions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          role VARCHAR(30) NOT NULL,
          permission_key VARCHAR(80) NOT NULL,
          allowed BOOLEAN NOT NULL,
          updated_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, role, permission_key)
        )
      `);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS tenant_role_permissions`);
  },
};
