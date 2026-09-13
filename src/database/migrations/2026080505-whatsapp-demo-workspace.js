'use strict';

// WhatsApp workspace demo: marcas CRM, prefs asesor, modo demo sin Meta.
const { describeTableSafe } = require('../../utils/describeTableSafe');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const convDesc = await describeTableSafe(queryInterface, 'wa_conversations');
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

    const metaDesc = await describeTableSafe(queryInterface, 'tenant_meta_configs');
    if (metaDesc && !metaDesc.wa_demo_mode) {
      await queryInterface.addColumn('tenant_meta_configs', 'wa_demo_mode', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Inbox simulable sin Meta Cloud API (demo comercial)',
      });
    }

    // users vive en public -- se consulta el schema explícito (no depende
    // del search_path/current_schema() de la conexión, a diferencia del
    // resto de describeTableSafe() en este archivo).
    const [userRows] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`
    );
    const userDesc = userRows.length ? Object.fromEntries(userRows.map((r) => [r.column_name, true])) : null;
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
