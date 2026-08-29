'use strict';

// Rename conceptual de purchase_support_document_adjustments ->
// support_document_adjustments: mismo contenido, pero la FK pasa de
// purchase_id a support_document_id (agnóstica al origen). La FK real al
// documento original se mantiene — sigue siendo la mejora sobre el patrón
// de nota crédito de factura (que solo enlaza por texto libre en
// Sale.notes).
module.exports = {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;

    await queryInterface.createTable('support_document_adjustments', {
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
      support_document_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'support_documents', key: 'id' },
        comment: 'FK real al Documento Soporte original.',
      },
      adjustment_type: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: "DIAN los llama 'concepto de ajuste': 'credit' | 'debit'",
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      items: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      subtotal: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      tax_amount: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      total_amount: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      adjustment_number: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      cuds: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      dian_status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'pending',
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

    await queryInterface.addIndex('support_document_adjustments', ['tenant_id']);
    await queryInterface.addIndex('support_document_adjustments', ['support_document_id']);

    // Migra lo que exista en la tabla vieja, uniendo por purchase_id contra
    // el support_documents ya poblado en la migración anterior. Si por
    // alguna razón un ajuste viejo no encuentra su documento (no debería
    // pasar: todo ajuste implica que el documento original sí se generó),
    // se deja fuera y queda logueado — no se inventa un support_document.
    const [orphans] = await q.query(`
      SELECT psda.id
      FROM purchase_support_document_adjustments psda
      LEFT JOIN support_documents sd ON sd.purchase_id = psda.purchase_id
      WHERE sd.id IS NULL;
    `);
    if (orphans.length > 0) {
      console.warn(
        `[Migration] ${orphans.length} ajuste(s) en purchase_support_document_adjustments ` +
        `sin support_document correspondiente — no se migran, revisar manualmente: ` +
        orphans.map(r => r.id).join(', ')
      );
    }

    await q.query(`
      INSERT INTO support_document_adjustments (
        id, tenant_id, support_document_id, adjustment_type, reason, items,
        subtotal, tax_amount, total_amount, adjustment_number, cuds,
        dian_status, dian_response, dian_sent_at, dian_accepted_at,
        dian_error_message, created_by, created_at, updated_at
      )
      SELECT
        psda.id, psda.tenant_id, sd.id, psda.adjustment_type, psda.reason,
        psda.items, psda.subtotal, psda.tax_amount, psda.total_amount,
        psda.adjustment_number, psda.cuds, psda.dian_status,
        psda.dian_response, psda.dian_sent_at, psda.dian_accepted_at,
        psda.dian_error_message, psda.created_by, psda.created_at, psda.updated_at
      FROM purchase_support_document_adjustments psda
      INNER JOIN support_documents sd ON sd.purchase_id = psda.purchase_id;
    `);

    console.log('[Migration] tabla support_document_adjustments creada y poblada');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('support_document_adjustments');
  },
};
