const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const BlogPost = sequelize.define('BlogPost', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  slug: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
    validate: {
      notEmpty: true,
      is: /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    }
  },
  excerpt: {
    type: DataTypes.STRING(300),
    allowNull: true
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  cover_image_url: {
    type: DataTypes.STRING,
    allowNull: true
  },
  category: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  tags: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  meta_title: {
    type: DataTypes.STRING(70),
    allowNull: true
  },
  meta_description: {
    type: DataTypes.STRING(160),
    allowNull: true
  },
  focus_keyword: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('draft', 'scheduled', 'published'),
    defaultValue: 'draft'
  },
  published_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  author_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  reading_time_minutes: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  }
}, {
  tableName: 'blog_posts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['status'] },
    { fields: ['published_at'] },
    { fields: ['category'] }
  ]
});

module.exports = BlogPost;
