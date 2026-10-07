// Borrador de formulario sincronizado entre equipos -- ver la migración
// 2026100602-create-form-drafts.js y controllers/formDrafts.controller.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const FormDraft = sequelize.define(
  'FormDraft',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    // 'sale:new', 'sale:edit:<id>', 'crmquote:new', 'wo:new', ...
    scope: { type: DataTypes.STRING(150), allowNull: false },
    data: { type: DataTypes.JSONB, allowNull: false },
    meta: { type: DataTypes.JSONB, allowNull: true },
    // Momento en que el equipo guardó el borrador (no el de llegada al
    // servidor): decide cuál versión es la más reciente.
    saved_at: { type: DataTypes.DATE, allowNull: false },
    device_id: { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    tableName: 'form_drafts',
    timestamps: true,
    underscored: true,
  }
);

module.exports = FormDraft;
