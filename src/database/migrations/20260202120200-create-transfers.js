'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('transfers', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      transfer_number: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true
      },
      from_warehouse_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'warehouses', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      to_warehouse_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'warehouses', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      transfer_date: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      sent_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      received_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'draft'
      },
      shipping_method: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      tracking_number: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      shipping_notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      receiving_notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      sent_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      received_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.createTable('transfer_items', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      transfer_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'transfers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      product_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      quantity_sent: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      quantity_received: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: true
      },
      unit_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      condition: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.addIndex('transfers', ['tenant_id']);
    await queryInterface.addIndex('transfers', ['from_warehouse_id']);
    await queryInterface.addIndex('transfers', ['to_warehouse_id']);
    await queryInterface.addIndex('transfers', ['transfer_number'], { unique: true });
    await queryInterface.addIndex('transfers', ['status']);
    await queryInterface.addIndex('transfer_items', ['transfer_id']);
    await queryInterface.addIndex('transfer_items', ['product_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('transfer_items');
    await queryInterface.dropTable('transfers');
  }
};