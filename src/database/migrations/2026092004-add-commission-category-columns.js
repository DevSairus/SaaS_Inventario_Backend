'use strict';

// Columnas que hacen viajar la categoría de comisión línea por línea desde
// el catálogo/diagrama hasta la liquidación -- ver
// plan-comisiones-tecnicos-por-sistema.md sección 3.
//
// - categories.commission_category_id: mapeo directo categoría de catálogo -> categoría de comisión.
// - work_order_items.commission_category_id: resuelta al agregar el ítem (producto o marca de diagrama).
// - commission_settlement_items.{commission_category_id,commission_percentage,commission_amount}:
//   snapshot congelado AL LIQUIDAR (no al agregar el ítem -- ver sección 5, punto 2).
// - commission_settlements.commission_percentage pasa a ser NULLABLE: para
//   liquidaciones nuevas es el % efectivo promedio (informativo); para
//   liquidaciones legadas sigue siendo la fuente de verdad.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('categories', 'commission_category_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'commission_categories', key: 'id' }, onDelete: 'SET NULL',
    });

    await queryInterface.addColumn('work_order_items', 'commission_category_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'commission_categories', key: 'id' }, onDelete: 'SET NULL',
    });

    await queryInterface.addColumn('commission_settlement_items', 'commission_category_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'commission_categories', key: 'id' }, onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('commission_settlement_items', 'commission_percentage', {
      type: Sequelize.DECIMAL(5, 2), allowNull: true,
    });
    await queryInterface.addColumn('commission_settlement_items', 'commission_amount', {
      type: Sequelize.DECIMAL(15, 2), allowNull: true,
    });

    await queryInterface.changeColumn('commission_settlements', 'commission_percentage', {
      type: Sequelize.DECIMAL(5, 2), allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('commission_settlements', 'commission_percentage', {
      type: Sequelize.DECIMAL(5, 2), allowNull: false,
    });
    await queryInterface.removeColumn('commission_settlement_items', 'commission_amount');
    await queryInterface.removeColumn('commission_settlement_items', 'commission_percentage');
    await queryInterface.removeColumn('commission_settlement_items', 'commission_category_id');
    await queryInterface.removeColumn('work_order_items', 'commission_category_id');
    await queryInterface.removeColumn('categories', 'commission_category_id');
  },
};
