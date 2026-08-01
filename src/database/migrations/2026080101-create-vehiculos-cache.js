'use strict';

// Copia local de solo lectura, SOLO de los vehículos con los que este CSA ha
// interactuado (no el catálogo completo del Core) — se llena "lazy": la
// primera vez que se consulta un VIN, se guarda aquí; de ahí en adelante se
// mantiene actualizada por eventos push (`vehiculo.actualizado`, Fase 2+).
// Ver modelo-datos-ensambladora.md, sección 6.
//
// Vive en el schema propio del tenant (no en public, a diferencia de las
// tablas de sync de Fase 0) porque ya se consulta con el tenant resuelto
// -- no hace falta identificarlo por api_key antes de saber el search_path.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('vehiculos_cache')) return; // guard: ya existe

    await queryInterface.createTable('vehiculos_cache', {
      vin: {
        type: Sequelize.STRING,
        primaryKey: true,
      },
      datos: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
        comment: 'Espejo de la respuesta de GET /vehiculos/{vin} del Core',
      },
      ultima_sincronizacion: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      verificado_en_linea: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'false si el dato viene solo del cache y no se ha confirmado en línea recientemente',
      },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('vehiculos_cache');
  },
};
