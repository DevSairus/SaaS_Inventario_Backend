'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const desc = await queryInterface.describeTable('crm_message_templates').catch(() => null);
    if (!desc) return;
    if (!desc.meta_template_name) {
      await queryInterface.addColumn('crm_message_templates', 'meta_template_name', {
        type: Sequelize.STRING(128),
        allowNull: true,
      });
    }
    if (!desc.meta_language) {
      await queryInterface.addColumn('crm_message_templates', 'meta_language', {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'es',
      });
    }
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('crm_message_templates', 'meta_language').catch(() => {});
    await queryInterface.removeColumn('crm_message_templates', 'meta_template_name').catch(() => {});
  },
};
