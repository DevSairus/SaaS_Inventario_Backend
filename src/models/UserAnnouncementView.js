const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserAnnouncementView = sequelize.define('UserAnnouncementView', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  announcement_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'announcements',
      key: 'id'
    }
  },
  viewed_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  dismissed_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'user_announcement_views',
  timestamps: false,
  underscored: true,
  indexes: [
    { 
      unique: true, 
      fields: ['user_id', 'announcement_id'],
      name: 'unique_user_announcement'
    },
    { fields: ['user_id'] },
    { fields: ['announcement_id'] }
  ]
});

module.exports = UserAnnouncementView;