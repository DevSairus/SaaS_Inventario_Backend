// backend/src/models/legal/LegalDocumentVersion.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Texto EXACTO (ya renderizado con los datos del tenant) que se le presentó
// al cliente en una solicitud de autorización. Se crea solo, por hash del
// contenido -- ver ensureDocumentVersion en services/legal/consent.service.js.
const LegalDocumentVersion = sequelize.define('LegalDocumentVersion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  kind: {
    type: DataTypes.STRING(30),
    allowNull: false,
    validate: { isIn: [['habeas_data', 'vehicle_intake']] },
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'standard',
    validate: { isIn: [['standard', 'custom']] },
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  content_hash: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
}, {
  tableName: 'legal_document_versions',
  timestamps: true,
  underscored: true,
});

module.exports = LegalDocumentVersion;
