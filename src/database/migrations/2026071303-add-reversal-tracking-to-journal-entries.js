'use strict';

// Soporta la reversión de asientos posteados (ej. cuando se cancela una venta
// o se registra una devolución después de que el asiento original ya afectó
// reportes). En vez de editar o borrar el asiento original — lo cual rompe
// inmutabilidad y trazabilidad — se crea un asiento nuevo que lo contrarresta
// (débito/crédito invertidos) y se enlazan entre sí con estas dos columnas.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('journal_entries', 'reversal_of_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'journal_entries', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'Si este asiento ES una reversión, apunta al asiento original que contrarresta.',
    });
    await queryInterface.addColumn('journal_entries', 'reversed_by_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'journal_entries', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'Si este asiento YA FUE reversado, apunta al asiento de reversión que lo contrarresta.',
    });
    await queryInterface.addIndex('journal_entries', ['reversal_of_entry_id'], { name: 'journal_entries_reversal_of_idx' });
    await queryInterface.addIndex('journal_entries', ['reversed_by_entry_id'], { name: 'journal_entries_reversed_by_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('journal_entries', 'journal_entries_reversal_of_idx');
    await queryInterface.removeIndex('journal_entries', 'journal_entries_reversed_by_idx');
    await queryInterface.removeColumn('journal_entries', 'reversal_of_entry_id');
    await queryInterface.removeColumn('journal_entries', 'reversed_by_entry_id');
  },
};
