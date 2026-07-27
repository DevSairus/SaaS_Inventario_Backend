const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupportTicketAttachment = sequelize.define('SupportTicketAttachment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ticket_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'support_tickets',
      key: 'id'
    }
  },
  message_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'support_ticket_messages',
      key: 'id'
    }
  },
  file_url: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  file_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  mime_type: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'support_ticket_attachments',
  timestamps: false,
  underscored: true,
  indexes: [
    { fields: ['ticket_id'] },
    { fields: ['message_id'] }
  ]
});

module.exports = SupportTicketAttachment;
