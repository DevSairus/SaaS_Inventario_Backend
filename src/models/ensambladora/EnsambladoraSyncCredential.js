// backend/src/models/ensambladora/EnsambladoraSyncCredential.js
//
// Credencial de sincronización de ESTE tenant frente al Core Ensambladora.
// OJO -- vive en `public`, no en el schema del tenant: un evento entrante
// (Core -> este Pitbox) todavía no sabe a qué tenant pertenece hasta resolver
// el X-Api-Key. Mismo patrón que TenantMetaConfig. Ver
// registerTenantSchemaHooks.js (PUBLIC_SCHEMA_MODELS).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraSyncCredential = sequelize.define(
  'EnsambladoraSyncCredential',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'tenants', key: 'id' },
      onDelete: 'CASCADE',
    },
    csa_pdv_id_externo: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'id del csa_pdv correspondiente en el Core Ensambladora',
    },
    api_key: {
      type: DataTypes.STRING(150),
      allowNull: false,
      unique: true,
    },
    hmac_secret: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    estado: {
      type: DataTypes.ENUM('activo', 'suspendido', 'revocado'),
      allowNull: false,
      defaultValue: 'activo',
    },
  },
  {
    tableName: 'ensambladora_sync_credentials',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraSyncCredential;
