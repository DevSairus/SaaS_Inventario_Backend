// backend/src/models/crm/WaConversation.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaConversation = sequelize.define('WaConversation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },  // id de la conversación
  tenant_id: { type: DataTypes.UUID, allowNull: false }, // id del tenant
  customer_id: { type: DataTypes.UUID, allowNull: true }, // id del cliente
  wa_contact_phone: { type: DataTypes.STRING(32), allowNull: false }, // teléfono del contacto
  wa_contact_name: { type: DataTypes.STRING(255), allowNull: true }, // nombre del contacto
  assigned_user_id: { type: DataTypes.UUID, allowNull: true }, // id del usuario asignado
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' }, // estado de la conversación
  last_message_at: { type: DataTypes.DATE, allowNull: true }, // fecha del último mensaje
  last_inbound_at: { type: DataTypes.DATE, allowNull: true }, // fecha del último mensaje entrante
  unread_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // cantidad de mensajes no leídos
  ai_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // si la conversación tiene IA habilitada para responder preguntas
  is_pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  priority: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'normal' }, // normal | high | urgent
  follow_up_at: { type: DataTypes.DATE, allowNull: true },
  marks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // ej. waiting_customer, quote_sent, hot_lead
  internal_note: { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName: 'wa_conversations', // nombre de la tabla  
  timestamps: true, //  la tabla tiene timestamps
  underscored: true, // si las columnas tienen underscored
  createdAt: 'created_at', // nombre de la columna de created_at
  updatedAt: 'updated_at', // nombre de la columna de updated_at
});

module.exports = WaConversation;

