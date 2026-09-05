'use strict';

// El job/botón de sincronización NCF no debe tocar un tenant hasta que se
// le haya cargado ciudad/tarifa/fecha de cobro a propósito -- un interruptor
// global (ENABLE_NCF_AUTOSYNC) protege contra correr el job por accidente,
// pero una vez activado igual barrería con TODOS los tenants elegibles,
// configurados o no. Este campo es el control fino: por tenant, "Listo a
// sincronizar" -- sincronizarTodosLosTenants() solo considera los que lo
// tengan en true.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('tenants', { schema: 'public' });
    if (!existingColumns.ncf_sync_enabled) {
      await queryInterface.addColumn('tenants', 'ncf_sync_enabled', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'true = el tenant ya tiene ciudad/tarifa/fecha de cobro revisados y puede incluirse en la sincronización NCF (cron o botón manual)',
      }, { schema: 'public' });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenants', 'ncf_sync_enabled', { schema: 'public' });
  },
};
