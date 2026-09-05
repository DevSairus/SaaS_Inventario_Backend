'use strict';

// `ncf_ciudad` (texto libre) nunca tuvo forma de cargarse desde el panel --
// no había ni selector ni endpoint para escribirlo, así que la sincronización
// con el Núcleo siempre mandaba ciudad vacía. Se agrega `ncf_city_code`
// (código DIVIPOLA, misma fuente de verdad que ya usa el emisor/clientes en
// el módulo DIAN, ver data/divipola-colombia.js) como la columna real, y
// `ncf_ciudad` pasa a ser el nombre derivado de ese código (mismo patrón que
// Customer.city/city_code).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('tenants', { schema: 'public' });
    if (!existingColumns.ncf_city_code) {
      await queryInterface.addColumn('tenants', 'ncf_city_code', {
        type: Sequelize.STRING(5),
        allowNull: true,
        comment: 'Código DIVIPOLA (DANE) de la ciudad del tenant para efectos de facturación NCF -- fuente de verdad, ncf_ciudad es el nombre derivado',
      }, { schema: 'public' });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenants', 'ncf_city_code', { schema: 'public' });
  },
};
