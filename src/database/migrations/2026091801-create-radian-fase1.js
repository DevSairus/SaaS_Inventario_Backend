'use strict';

// RADIAN Fase 1 (ver 00 - Documentación/RADIAN-Analisis-y-Plan.md §5.1 y §6):
// prerrequisitos de datos para poder emitir el evento 030 (Acuse de recibo)
// sobre una Purchase importada desde factura electrónica del proveedor.
//
// cufe/dian_issue_date/dian_issue_time/supplier_xml viven en `purchases`
// porque son atributos DEL DOCUMENTO importado (la factura del proveedor),
// mismo criterio que `cufe` ya existe en `sales` para la factura propia.
// radian_status/radian_deadline_at son el estado comercial derivado de la
// secuencia de eventos — se recalculan en la misma transacción que inserta
// cada fila en radian_events (ver services/radian/radianService.js).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const q = queryInterface.sequelize;

    await q.query(`
      ALTER TABLE purchases
        ADD COLUMN IF NOT EXISTS cufe VARCHAR(255),
        ADD COLUMN IF NOT EXISTS dian_issue_date DATE,
        ADD COLUMN IF NOT EXISTS dian_issue_time VARCHAR(20),
        ADD COLUMN IF NOT EXISTS supplier_xml TEXT,
        ADD COLUMN IF NOT EXISTS radian_status VARCHAR(20) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS radian_deadline_at TIMESTAMPTZ
    `);

    // Índice único parcial: además de habilitar los eventos, evita importar
    // dos veces la misma factura electrónica por su CUFE (invoice_number ya
    // tiene su propio índice único, pero dos proveedores distintos podrían
    // coincidir en número de factura -- el CUFE no).
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS purchases_tenant_cufe_unique
        ON purchases (tenant_id, cufe) WHERE cufe IS NOT NULL
    `);

    await queryInterface.createTable('radian_events', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      direction: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: "'emitted' | 'received'",
      },
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'purchases', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      sale_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sales', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      document_cufe: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'CUFE de la factura que el evento referencia',
      },
      document_number: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      counterparty_nit: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      event_code: {
        type: Sequelize.STRING(5),
        allowNull: false,
        comment: "'030' | '031' | '032' | '033' | '034'",
      },
      cude: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'CUDE del propio ApplicationResponse (una vez calculado)',
      },
      issued_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      issuer_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      issuer_snapshot: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Copia de nombre/cédula de quien ejecutó el evento (030/032)',
      },
      claim_reason_code: {
        type: Sequelize.STRING(10),
        allowNull: true,
        comment: 'Solo evento 031 (reclamo)',
      },
      request_xml: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'ApplicationResponse sin firmar, para auditoría',
      },
      signed_xml: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      track_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      dian_status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending | sending | accepted | rejected | error',
      },
      dian_response_raw: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      attempt: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      is_test: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('radian_events', ['tenant_id']);
    await queryInterface.addIndex('radian_events', ['purchase_id']);
    await queryInterface.addIndex('radian_events', ['sale_id']);
    // Un evento aceptado por código es único por documento — reenviar un
    // 030 ya aceptado debe ser un no-op, no un duplicado (ver §5.1 del plan).
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS radian_events_purchase_code_accepted_unique
        ON radian_events (tenant_id, purchase_id, event_code)
        WHERE dian_status = 'accepted' AND purchase_id IS NOT NULL
    `);

    console.log('[Migration] RADIAN Fase 1: columnas en purchases + tabla radian_events creadas');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('radian_events');
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS purchases_tenant_cufe_unique`);
    await queryInterface.sequelize.query(`
      ALTER TABLE purchases
        DROP COLUMN IF EXISTS cufe,
        DROP COLUMN IF EXISTS dian_issue_date,
        DROP COLUMN IF EXISTS dian_issue_time,
        DROP COLUMN IF EXISTS supplier_xml,
        DROP COLUMN IF EXISTS radian_status,
        DROP COLUMN IF EXISTS radian_deadline_at
    `);
  },
};
