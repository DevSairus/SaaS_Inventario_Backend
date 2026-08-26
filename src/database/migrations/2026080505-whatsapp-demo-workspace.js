'use strict';

// WhatsApp workspace demo: marcas CRM, prefs asesor, modo demo sin Meta.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const convDesc = await queryInterface.describeTable('wa_conversations').catch(() => null);
    if (convDesc) {
      if (!convDesc.is_pinned) {
        await queryInterface.addColumn('wa_conversations', 'is_pinned', {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
      }
      if (!convDesc.priority) {
        await queryInterface.addColumn('wa_conversations', 'priority', {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'normal',
        });
      }
      if (!convDesc.follow_up_at) {
        await queryInterface.addColumn('wa_conversations', 'follow_up_at', {
          type: Sequelize.DATE,
          allowNull: true,
        });
      }
      if (!convDesc.marks) {
        await queryInterface.addColumn('wa_conversations', 'marks', {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        });
      }
      if (!convDesc.internal_note) {
        await queryInterface.addColumn('wa_conversations', 'internal_note', {
          type: Sequelize.TEXT,
          allowNull: true,
        });
      }
    }

    const metaDesc = await queryInterface.describeTable('tenant_meta_configs').catch(() => null);
    if (metaDesc && !metaDesc.wa_demo_mode) {
      await queryInterface.addColumn('tenant_meta_configs', 'wa_demo_mode', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Inbox simulable sin Meta Cloud API (demo comercial)',
      });
    }

    // users vive en public
    const userDesc = await queryInterface.describeTable({ tableName: 'users', schema: 'public' }).catch(() =>
      queryInterface.describeTable('users').catch(() => null)
    );
    if (userDesc && !userDesc.wa_workspace_prefs) {
      await queryInterface.addColumn('users', 'wa_workspace_prefs', {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Toggles visuales del workspace WhatsApp del asesor',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('wa_conversations', 'is_pinned').catch(() => {});
    await queryInterface.removeColumn('wa_conversations', 'priority').catch(() => {});
    await queryInterface.removeColumn('wa_conversations', 'follow_up_at').catch(() => {});
    await queryInterface.removeColumn('wa_conversations', 'marks').catch(() => {});
    await queryInterface.removeColumn('wa_conversations', 'internal_note').catch(() => {});
    await queryInterface.removeColumn('tenant_meta_configs', 'wa_demo_mode').catch(() => {});
    await queryInterface.removeColumn('users', 'wa_workspace_prefs').catch(() => {});
  },
};
