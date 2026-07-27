const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupportTicketMessage = sequelize.define('SupportTicketMessage', {
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
  author_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  is_internal_note: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'support_ticket_messages',
  timestamps: false,
  underscored: true,
  indexes: [
    { fields: ['ticket_id'] }
  ]
});

module.exports = SupportTicketMessage;
