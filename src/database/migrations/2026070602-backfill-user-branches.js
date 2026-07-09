'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Asigna cada usuario existente (excepto super_admin, que no pertenece a un tenant)
      // a la "Sede Principal" (PPAL) de su tenant, como sede por defecto.
      // Usa ON CONFLICT por si el usuario ya tuviera alguna asignación previa (no debería,
      // pero evita fallar si esta migración se corre más de una vez).
      await queryInterface.sequelize.query(`
        INSERT INTO user_branches (id, user_id, branch_id, is_default, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          u.id,
          b.id,
          true,
          NOW(),
          NOW()
        FROM users u
        JOIN branches b ON b.tenant_id = u.tenant_id AND b.code = 'PPAL'
        WHERE u.role != 'super_admin'
          AND u.tenant_id IS NOT NULL
        ON CONFLICT (user_id, branch_id) DO NOTHING;
      `, { transaction });

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
