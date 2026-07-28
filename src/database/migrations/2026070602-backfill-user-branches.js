'use strict';

module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Asigna cada usuario existente (excepto super_admin, que no pertenece a un tenant)
      // a la "Sede Principal" (PPAL) de su tenant, como sede por defecto.
      // Usa ON CONFLICT por si el usuario ya tuviera alguna asignación previa (no debería,
      // pero evita fallar si esta migración se corre más de una vez).
      //
      // Bajo aprovisionamiento por-schema (context.tenantId presente), filtrar
      // por ese tenant -- si no, `branches` de este schema solo tiene la sede
      // de ESTE tenant, pero `users` es compartida entre todos, y el JOIN
      // igual traería usuarios de otros tenants si alguno compartiera
      // tenant_id por coincidencia de datos legacy.
      await queryInterface.sequelize.query(`
        INSERT INTO user_branches (id, user_id, branch_id, is_default, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          u.id,
          b.id,
          true,
          NOW(),
          NOW()
        FROM "public"."users" u
        JOIN branches b ON b.tenant_id = u.tenant_id AND b.code = 'PPAL'
        WHERE u.role != 'super_admin'
          AND u.tenant_id IS NOT NULL
          ${context?.tenantId ? 'AND u.tenant_id = :tenantId' : ''}
        ON CONFLICT (user_id, branch_id) DO NOTHING;
      `, { transaction, replacements: context?.tenantId ? { tenantId: context.tenantId } : {} });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No revertimos: borrar estas asignaciones dejaría usuarios sin sede.
    // Si de verdad se necesita revertir, hacerlo manualmente por tenant.
  },
};
