'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('internal_consumptions', {
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
      consumption_number: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true
      },
      warehouse_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'warehouses', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      department: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      consumption_date: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      purpose: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      total_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'pending'
      },
      requested_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      approved_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      approved_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      rejected_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      rejected_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      rejection_reason: {
        type: Sequelize.TEXT,
        allowNull: true
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

    await queryInterface.createTable('internal_consumption_items', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      consumption_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'internal_consumptions', key: 'id' },
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
      quantity: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      unit_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      total_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
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

    await queryInterface.addIndex('internal_consumptions', ['tenant_id']);
    await queryInterface.addIndex('internal_consumptions', ['warehouse_id']);
    await queryInterface.addIndex('internal_consumptions', ['consumption_number'], { unique: true });
    await queryInterface.addIndex('internal_consumptions', ['status']);
    await queryInterface.addIndex('internal_consumptions', ['department']);
    await queryInterface.addIndex('internal_consumption_items', ['consumption_id']);
    await queryInterface.addIndex('internal_consumption_items', ['product_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('internal_consumption_items');
    await queryInterface.dropTable('internal_consumptions');
  }
};