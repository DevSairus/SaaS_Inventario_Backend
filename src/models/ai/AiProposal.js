const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Fase 2 del Asistente de IA: NEXA puede PROPONER acciones de escritura
// (ej. registrar un gasto), pero nunca las ejecuta directamente. Cada
// propuesta queda "pending" hasta que un humano con el rol adecuado la
// aprueba o la rechaza desde la pantalla de Aprobaciones NEXA.
const AiProposal = sequelize.define(
  'AiProposal',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    conversation_id: { type: DataTypes.UUID, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },

    // Identifica qué controller/servicio real se debe invocar al aprobar
    // (ver services/ai/proposalExecutor.js para el mapa completo).
    action_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      // Fase 3: se agrega 'regenerate_journal_entry' — genera el asiento en
      // borrador de un movimiento (venta/compra/gasto/caja) que
      // find_missing_journal_entries detectó sin asiento contable.
      validate: { isIn: [['create_expense', 'register_expense_payment', 'regenerate_journal_entry']] },
    },

    // Descripción humana lista para mostrar en la pantalla de Aprobaciones,
    // generada por el executor de la tool en el momento de crear la propuesta.
    summary: { type: DataTypes.STRING(300), allowNull: false },

    // Argumentos exactos con los que se llamará al controller real si se aprueba.
    payload: { type: DataTypes.JSONB, allowNull: false },

    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [['pending', 'approved', 'rejected', 'executed', 'failed']] },
    },

    reviewed_by: { type: DataTypes.UUID, allowNull: true },
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    executed_at: { type: DataTypes.DATE, allowNull: true },

    // Respuesta del controller real una vez ejecutada (o null si falló/rechazada).
    result: { type: DataTypes.JSONB, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: 'ai_proposals',
    timestamps: true,
    underscored: true,
  }
);

module.exports = AiProposal;
