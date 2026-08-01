'use strict';

// CRM Fase 2 — segmentación libre de clientes (VIP, flota, taller recurrente,
// etc.). Many-to-many simple, tenant-scoped.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('customer_tags')) {
      await queryInterface.createTable('customer_tags', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING(100),
          allowNull: false,
        },
        color: {
          type: Sequelize.STRING(20),
          allowNull: true,
          comment: 'hex, para el badge en el frontend',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('customer_tags', ['tenant_id', 'name'], {
        name: 'customer_tags_tenant_name_unique_idx',
        unique: true,
      });
    }

    if (!tables.includes('customer_tag_assignments')) {
      await queryInterface.createTable('customer_tag_assignments', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        customer_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'customers', key: 'id' },
          onDelete: 'CASCADE',
        },
        customer_tag_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'customer_tags', key: 'id' },
          onDelete: 'CASCADE',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('customer_tag_assignments', ['customer_id', 'customer_tag_id'], {
        name: 'customer_tag_assignments_unique_idx',
        unique: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_tag_assignments');
    await queryInterface.dropTable('customer_tags');
  },
};