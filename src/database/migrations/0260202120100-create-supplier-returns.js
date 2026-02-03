'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Tabla supplier_returns
    await queryInterface.createTable('supplier_returns', {
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
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'purchases',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      supplier_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'suppliers',
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
      credit_note_number: {
        type: Sequelize.STRING(50),
        allowNull: true
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

    // Tabla supplier_return_items
    await queryInterface.createTable('supplier_return_items', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      return_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'supplier_returns',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      purchase_item_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'purchase_items',
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
      unit_cost: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false
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
    await queryInterface.addIndex('supplier_returns', ['tenant_id']);
    await queryInterface.addIndex('supplier_returns', ['purchase_id']);
    await queryInterface.addIndex('supplier_returns', ['supplier_id']);
    await queryInterface.addIndex('supplier_returns', ['return_number'], { unique: true });
    await queryInterface.addIndex('supplier_returns', ['status']);
    await queryInterface.addIndex('supplier_returns', ['return_date']);
    
    await queryInterface.addIndex('supplier_return_items', ['return_id']);
    await queryInterface.addIndex('supplier_return_items', ['product_id']);
    await queryInterface.addIndex('supplier_return_items', ['purchase_item_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('supplier_return_items');
    await queryInterface.dropTable('supplier_returns');
  }
};