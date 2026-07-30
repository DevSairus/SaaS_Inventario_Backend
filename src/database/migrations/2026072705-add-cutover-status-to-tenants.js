'use strict';

// Fase 5 del plan de schema-per-tenant: visibilidad operativa. Hoy, si el
// cutover automático en el alta de un tenant (routes/superadmin.routes.js)
// falla, el único rastro es un console.error -- no hay forma de verlo desde
// la UI ni de saber qué tenants quedaron en modo legado por error vs. por
// decisión. Esta migración agrega el mismo tipo de columnas de bookkeeping
// que ya existen para NCF (ncf_last_status / ncf_last_error), pero para el
// cutover de schema.
//
// Igual que la migración de NCF: esta corre una vez por CADA schema de
// tenant que se aprovisiona (provisionTenantSchema.js aplica el set
// completo de migraciones dentro del search_path del tenant nuevo), así
// que hay que chequear existencia antes de cada ADD COLUMN o el segundo
// tenant que se provisione choca con "column already exists".

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('tenants', { schema: 'public' });
    const addIfMissing = (name, def) => existingColumns[name]
      ? Promise.resolve()
      : queryInterface.addColumn('tenants', name, def, { schema: 'public' });

    await addIfMissing('cutover_last_attempt_at', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: 'Cuándo se intentó por última vez el cutover a schema-per-tenant (automático o manual)',
    });
    await addIfMissing('cutover_last_status', {
      type: Sequelize.STRING(20),
      allowNull: true,
      comment: 'success | failed -- null significa que nunca se intentó',
    });
    await addIfMissing('cutover_last_error', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Mensaje de error del último intento fallido de cutover, para mostrar en el panel de superadmin',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenants', 'cutover_last_error', { schema: 'public' });
    await queryInterface.removeColumn('tenants', 'cutover_last_status', { schema: 'public' });
    await queryInterface.removeColumn('tenants', 'cutover_last_attempt_at', { schema: 'public' });
  },
};
