'use strict';

// El listado del Kanban (controllers/crm/opportunities.controller.js, `list`)
// ordena por stage_changed_at pero no había índice que lo cubriera -- el
// ORDER BY caía a sort en memoria a medida que crecía el histórico por
// tenant. Ver models/crm/Opportunity.js, que ya declara este índice.
module.exports = {
  up: async (queryInterface) => {
    const indexes = await queryInterface.showIndex('opportunities');
    const alreadyExists = indexes.some((idx) => idx.name === 'opportunities_tenant_id_stage_changed_at');
    if (alreadyExists) return;

    await queryInterface.addIndex('opportunities', ['tenant_id', 'stage_changed_at'], {
      name: 'opportunities_tenant_id_stage_changed_at',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('opportunities', 'opportunities_tenant_id_stage_changed_at');
  },
};
