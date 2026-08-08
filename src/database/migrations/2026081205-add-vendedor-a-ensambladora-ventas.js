'use strict';

// "Quién hizo la venta" -- por defecto el usuario que inició sesión en
// Pitbox (ver useUsuarioTecnico.js), un admin puede elegir a otra persona.
// Mismo criterio que tecnico_documento en garantías/revisiones/cotizaciones:
// texto libre (cédula), no FK a ningún registro.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('ensambladora_ventas');
    if (!table.vendedor_documento) {
      await queryInterface.addColumn('ensambladora_ventas', 'vendedor_documento', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('ensambladora_ventas', 'vendedor_documento');
  },
};
