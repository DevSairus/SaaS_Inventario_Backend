'use strict';

// 'totalmente_depreciado' tiene 21 caracteres y fixed_assets.status era
// VARCHAR(20): el mes en que un activo terminaba de depreciarse fallaba (el
// UPDATE del estado revertía la transacción con la entrada de ese mes), así
// que ningún activo llegaba a quedar totalmente depreciado.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE fixed_assets ALTER COLUMN status TYPE VARCHAR(30)`);
  },
  down: async () => {},
};
