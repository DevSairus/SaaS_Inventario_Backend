'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Tabla customer_returns
    await queryInterface.createTable('customer_returns', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'tenants',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      return_number: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true
      },
      sale_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'sales',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      customer_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'customers',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      return_date: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      reason: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      subtotal: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
      },
      tax: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
      },
      total_amount: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'pending'
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        }
      },
      approved_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        }
      },
      approved_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      rejected_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        }
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

    // Tabla customer_return_items
    await queryInterface.createTable('customer_return_items', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      return_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'customer_returns',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      sale_item_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'sale_items',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      product_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'products',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      quantity: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      unit_price: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      unit_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      condition: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'used'
      },
      destination: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'inventory'
      },
      subtotal: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      tax: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
      },
      total: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Índices
    await queryInterface.addIndex('customer_returns', ['tenant_id']);
    await queryInterface.addIndex('customer_returns', ['sale_id']);
    await queryInterface.addIndex('customer_returns', ['customer_id']);
    await queryInterface.addIndex('customer_returns', ['return_number'], { unique: true });
    await queryInterface.addIndex('customer_returns', ['status']);
    await queryInterface.addIndex('customer_returns', ['return_date']);
    
    await queryInterface.addIndex('customer_return_items', ['return_id']);
    await queryInterface.addIndex('customer_return_items', ['product_id']);
    await queryInterface.addIndex('customer_return_items', ['sale_item_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('customer_return_items');
    await queryInterface.dropTable('customer_returns');
  }
};