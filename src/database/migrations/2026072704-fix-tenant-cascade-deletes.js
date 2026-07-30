'use strict';

// ============================================================================
// FIX: borrar un tenant dejaba basura irrecuperable
//
// Casi todas las tablas con tenant_id tienen "ON DELETE CASCADE" hacia
// tenants(id) -- excepto un puñado que quedaron en "NO ACTION" (RESTRICT)
// o, en el caso de users, "SET NULL". Efecto real, confirmado en
// producción:
//
//   1. users.tenant_id ON DELETE SET NULL -- al borrar un tenant, sus
//      usuarios NO se borran: quedan huérfanos con tenant_id = NULL,
//      pero su fila (y su email, columna UNIQUE) sigue viva para
//      siempre. Por eso reusar el mismo email de un admin de una
//      empresa ya "eliminada" fallaba con "el email ya está registrado".
//   2. audit_logs, customer_returns, internal_consumptions,
//      inventory_adjustments, inventory_movements, stock_alerts,
//      supplier_returns, transfers, vehicles, work_orders en NO ACTION --
//      cualquier tenant con datos reales en esas tablas (que es
//      cualquier tenant que haya usado la app) hacía que
//      Tenant.destroy() fallara con SequelizeForeignKeyConstraintError
//      apenas se intentaba borrar, sin dar ninguna pista de cuál era la
//      tabla real culpable.
//
// Se corrige llevando todo a CASCADE, que es el patrón que ya siguen el
// resto de las ~30 tablas de tenant. users pasa de SET NULL a CASCADE
// porque el endpoint de borrado (superadmin.routes.js) ya asume que
// borrar un tenant borra a sus usuarios (por eso hace User.destroy()
// a mano primero) -- esto solo lo hace consistente también a nivel DB.
// ============================================================================

const TABLES_NO_ACTION_TO_CASCADE = [
  'audit_logs',
  'customer_returns',
  'internal_consumptions',
  'inventory_adjustments',
  'inventory_movements',
  'stock_alerts',
  'supplier_returns',
  'transfers',
  'vehicles',
  'work_orders',
];

function fkBlock(D, table, constraint, action) {
  return `
DO ${D}fk${D} BEGIN
  ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${constraint}";
  ALTER TABLE ${table}
    ADD CONSTRAINT "${constraint}" FOREIGN KEY (tenant_id)
    REFERENCES "public"."tenants"(id) ON DELETE ${action};
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END ${D}fk${D};`;
}

function buildSql(action, usersAction) {
  const D = String.fromCharCode(36);
  const statements = TABLES_NO_ACTION_TO_CASCADE.map((table) =>
    fkBlock(D, table, `${table}_tenant_id_fkey`, action)
  );
  statements.push(fkBlock(D, 'users', 'users_tenant_id_fkey', usersAction));
  return statements.join('\n');
}

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(buildSql('CASCADE', 'CASCADE'));
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(buildSql('NO ACTION', 'SET NULL'));
  },
};
