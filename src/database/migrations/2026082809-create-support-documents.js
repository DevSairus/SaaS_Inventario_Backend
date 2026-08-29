'use strict';

// Fase 1 del plan de reorganización del Documento Soporte DIAN
// (Documento-Soporte-Plan-v2.md). Tabla dedicada en vez de duplicar
// columnas dian_* en `purchases` y `expenses` por separado — mismo
// principio de nullable-FK por origen que ya usa `DianEvent` con
// sale_id/purchase_id.
//
// `branch_id` se guarda directo aquí (no solo derivable via purchase/expense)
// porque la emisión queda vinculada a la sede de la resolución DIAN usada
// (decisión del usuario) y se necesita para filtrar/reportar sin JOIN.
module.exports = {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;

    await queryInterface.createTable('support_documents', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
      },
      branch_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'branches', key: 'id' },
        comment: 'Sede de la resolución DIAN con la que se emitió este documento.',
      },
      source_type: {
        type: Sequelize.STRING(20),
        allowNull: false,
        comment: "'purchase' | 'expense'",
      },
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'purchases', key: 'id' },
      },
      expense_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'expenses', key: 'id' },
      },
      support_document_number: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Prefijo + consecutivo — equivalente a Sale.dian_invoice_number',
      },
      cuds: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Código Único del Documento Soporte — equivalente a cufe',
      },
      dian_status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending | sending | accepted | rejected',
      },
      dian_response: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      dian_sent_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      dian_accepted_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      dian_error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    // Origen coherente: exactamente uno de purchase_id/expense_id no-nulo,
    // y que coincida con source_type.
    await q.query(`
      ALTER TABLE support_documents
        ADD CONSTRAINT support_documents_source_check
        CHECK (
          source_type IN ('purchase', 'expense')
          AND (
            (source_type = 'purchase' AND purchase_id IS NOT NULL AND expense_id IS NULL)
            OR
            (source_type = 'expense' AND expense_id IS NOT NULL AND purchase_id IS NULL)
          )
        );
    `);

    // 1 Purchase ↔ máximo 1 Documento Soporte activo, igual para Expense.
    await q.query(`
      CREATE UNIQUE INDEX support_documents_purchase_id_unique
        ON support_documents (purchase_id) WHERE purchase_id IS NOT NULL;
    `);
    await q.query(`
      CREATE UNIQUE INDEX support_documents_expense_id_unique
        ON support_documents (expense_id) WHERE expense_id IS NOT NULL;
    `);

    await queryInterface.addIndex('support_documents', ['tenant_id']);
    await queryInterface.addIndex('support_documents', ['tenant_id', 'branch_id']);
    await queryInterface.addIndex('support_documents', ['tenant_id', 'dian_status']);

    console.log('[Migration] tabla support_documents creada');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('support_documents');
  },
};
