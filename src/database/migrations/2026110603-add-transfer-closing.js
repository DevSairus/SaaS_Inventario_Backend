'use strict';

// Cierre de traslados/remisiones (Fase 2 del módulo Proyectos): un traslado
// recibido pasa a 'closed' cuando alguien con el permiso
// 'inventory.transfers.close' lo da por conciliado. Cerrado = no se edita, no
// se anula ni se le cambian los adjuntos. closing_notes explica las
// diferencias entre lo enviado y lo recibido, si las hubo.
// Sin calificar con esquema: corre por tenant con su search_path.
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS transfers ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE`);
    await q(`ALTER TABLE IF EXISTS transfers ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE IF EXISTS transfers ADD COLUMN IF NOT EXISTS closing_notes TEXT`);
  },
  down: async (queryInterface) => {
    for (const c of ['closed_at', 'closed_by', 'closing_notes']) {
      await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS transfers DROP COLUMN IF EXISTS ${c}`);
    }
  },
};
