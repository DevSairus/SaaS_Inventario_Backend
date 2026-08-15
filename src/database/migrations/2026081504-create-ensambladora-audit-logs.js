'use strict';

// Mismo patrón que ensambladora_ordenes_garantia/_ventas/etc: vive en el
// schema del tenant. Log de solo-append (sin updated_at) para trazabilidad
// de acciones sobre garantía/alistamiento/etc -- ver
// registrarAuditoria en services/ensambladora/auditLog.js.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('ensambladora_audit_logs')) return;

    await queryInterface.createTable('ensambladora_audit_logs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      entidad_tipo: { type: Sequelize.STRING, allowNull: false },
      entidad_id: { type: Sequelize.UUID, allowNull: true },
      vin: { type: Sequelize.STRING, allowNull: true },
      accion: { type: Sequelize.STRING, allowNull: false },
      usuario_id: { type: Sequelize.UUID, allowNull: true },
      usuario_nombre: { type: Sequelize.STRING, allowNull: true },
      detalle: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ensambladora_audit_logs');
  },
};
