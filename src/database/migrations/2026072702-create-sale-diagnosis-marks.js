'use strict';

// Espejo de work_order_diagnosis_marks (ver 2026072501), pero para
// cotizaciones (sales.document_type = 'cotizacion'). Se mantiene como tabla
// separada — en vez de hacer polimórfica la tabla de OT — para no tocar una
// tabla ya en producción y porque generated_item_id apunta a un modelo
// distinto en cada caso (work_order_items vs sale_items).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('sale_diagnosis_marks', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: { type: Sequelize.UUID, allowNull: false },
        sale_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'sales', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        diagram_template_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'diagram_templates', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        point_number: { type: Sequelize.INTEGER, allowNull: false },
        severity: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'revisar',
          comment: 'revisar | cambiar_pronto | urgente',
        },
        side: { type: Sequelize.STRING(20), allowNull: true },
        observation: { type: Sequelize.TEXT, allowNull: true },
        suggested_product_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'products', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        generated_item_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'sale_items', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
          comment: 'SaleItem generado a partir de esta marca (si se confirmó)',
        },
        marked_by: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        marked_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('sale_diagnosis_marks', ['tenant_id'], { transaction });
      await queryInterface.addIndex('sale_diagnosis_marks', ['sale_id'], { transaction });
      await queryInterface.addIndex('sale_diagnosis_marks', ['diagram_template_id'], { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('sale_diagnosis_marks');
  },
};
