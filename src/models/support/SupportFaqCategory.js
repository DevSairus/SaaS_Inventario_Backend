const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupportFaqCategory = sequelize.define('SupportFaqCategory', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'support_faq_categories',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['is_active'] }
  ]
});

module.exports = SupportFaqCategory;
