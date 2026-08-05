'use strict';

// Permite marcar una ronda de cotización respondida como "vista" por el
// personal del taller. El aviso en vivo (socket /quotes) se pierde si nadie
// tenía la pantalla abierta cuando el cliente respondió; esta columna es lo
// que permite reconstruir una bandeja de pendientes por consulta directa.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE work_order_quote_requests
        ADD COLUMN IF NOT EXISTS staff_seen_at TIMESTAMP WITH TIME ZONE;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('work_order_quote_requests', 'staff_seen_at');
  },
};
