'use strict';

// El modelo FiscalPeriod ya tenía status open/closed, closed_at, closed_by,
// pero no existía ningún endpoint para pasar de open -> closed: la
// validación en createDraftEntry ("no se puede crear asiento en período
// cerrado") nunca se podía activar. Esta migración solo agrega lo que falta
// para soportar también la REAPERTURA de un período cerrado (acción
// excepcional que debe quedar registrada aparte del cierre original).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('fiscal_periods', 'reopened_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('fiscal_periods', 'reopened_by', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
    });
    await queryInterface.addColumn('fiscal_periods', 'reopen_reason', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('fiscal_periods', 'reopened_at');
    await queryInterface.removeColumn('fiscal_periods', 'reopened_by');
    await queryInterface.removeColumn('fiscal_periods', 'reopen_reason');
  },
};
