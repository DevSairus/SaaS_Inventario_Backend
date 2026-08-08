'use strict';

// Los usuarios de Pitbox no tenían ningún campo de documento/cédula. Hace
// falta para poder seleccionarlos (en vez de escribir a mano) al vincular
// un técnico/asesor ante la Ensambladora -- ver
// ensambladora/tecnicos.controller.js, que exige `documento_identidad`
// para el registro local y el evento usuario.tecnico_asesor_vinculado
// hacia el Core. No es único a nivel de BD -- la unicidad que importa es
// la de ensambladora_tecnicos_asesores.documento_identidad, que ya existe.
// `users` vive SOLO en `public` (ver config/registerTenantSchemaHooks.js,
// PUBLIC_SCHEMA_MODELS) -- nunca se replica al schema dedicado de un
// tenant ya cortado. Sin calificar el schema acá, esta migración fallaba
// con "No description found for 'users' table" cada vez que
// migrateAllTenantSchemas.js la corría dentro de un schema tipo
// "tenant_pitbox_demo" (bloqueando además cualquier migración posterior en
// esa misma corrida, ya que se aplican en orden y se detienen en el primer
// error).
const USERS_TABLE = { tableName: 'users', schema: 'public' };

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable(USERS_TABLE);
    if (!table.cedula) {
      await queryInterface.addColumn(USERS_TABLE, 'cedula', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn(USERS_TABLE, 'cedula');
  },
};
