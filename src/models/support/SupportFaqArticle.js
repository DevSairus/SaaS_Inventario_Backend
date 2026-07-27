const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupportFaqArticle = sequelize.define('SupportFaqArticle', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  category_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'support_faq_categories',
      key: 'id'
    }
  },
  question: {
    type: DataTypes.STRING(500),
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  answer: {
    type: DataTypes.TEXT,
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
  },
  helpful_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  not_helpful_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  }
}, {
  tableName: 'support_faq_articles',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['category_id'] },
    { fields: ['is_active'] }
  ]
});

module.exports = SupportFaqArticle;
