'use strict';

// RADIAN Fase 3 (ver 00 - Documentación/RADIAN-Analisis-y-Plan.md §5.1/§5.5/§6):
// el 034 (Aceptación tácita) lo emite el EMISOR (nosotros) sobre una Sale a
// crédito, cuando el cliente recibió la factura, hubo 032 (recibo del bien/
// servicio) y vencieron 3 días hábiles sin que el cliente enviara 033 ni 031.
// Mismo espejo de columnas que ya tiene `purchases` desde Fase 1/2.
//
// radian_alerts es la base del job "radian-deadlines" (§5.5): NO emite nada
// solo, solo avisa -- 033/034 siempre requieren acción explícita del usuario
// (decisión de producto §5.7 del plan). Sirve tanto para compras (plazo de
// 031/033 por vencer/vencido) como para ventas (034 ya disponible).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const q = queryInterface.sequelize;

    await q.query(`
      ALTER TABLE sales
        ADD COLUMN IF NOT EXISTS radian_status VARCHAR(20) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS radian_deadline_at TIMESTAMPTZ
    `);

    await queryInterface.createTable('radian_alerts', {
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
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'purchases', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sale_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sales', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      alert_type: {
        type: Sequelize.STRING(40),
        allowNull: false,
        comment: 'purchase_deadline_due_soon | purchase_deadline_overdue | sale_tacit_acceptance_ready',
      },
      severity: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'warning',
        comment: 'info | warning | critical',
      },
      deadline_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: 'active | resolved',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      resolved_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('radian_alerts', ['tenant_id', 'status']);
    // Un solo aviso activo por documento+tipo — el job no debe duplicar el
    // mismo aviso en cada corrida diaria mientras siga sin resolverse.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS radian_alerts_purchase_type_active_unique
        ON radian_alerts (tenant_id, purchase_id, alert_type)
        WHERE status = 'active' AND purchase_id IS NOT NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS radian_alerts_sale_type_active_unique
        ON radian_alerts (tenant_id, sale_id, alert_type)
        WHERE status = 'active' AND sale_id IS NOT NULL
    `);

    console.log('[Migration] RADIAN Fase 3: sales.radian_status/radian_deadline_at + tabla radian_alerts creadas');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('radian_alerts');
    await queryInterface.sequelize.query(`
      ALTER TABLE sales
        DROP COLUMN IF EXISTS radian_status,
        DROP COLUMN IF EXISTS radian_deadline_at
    `);
  },
};
