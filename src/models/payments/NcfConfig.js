// backend/src/models/NcfConfig.js
// Configuración de la conexión de Pitbox con el Núcleo Central de
// Facturación (NCF) de ESC DataCore. Es UNA sola fila -- análoga a
// SuperAdminMercadoPagoConfig -- porque Pitbox como sistema origen tiene
// una sola API key/secret frente al Núcleo, sin importar cuántos tenants
// facturen a través de él.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const NcfConfig = sequelize.define(
  'NcfConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    ncf_base_url: {
      type: DataTypes.STRING(300),
      allowNull: true,
      comment: 'URL base de la API del Núcleo, ej: https://ncf-nucleo-central.up.railway.app/api/v1',
    },
    ncf_api_key: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'API key entregada por el Núcleo al crear el SistemaOrigen "PITBOX" (header x-ncf-api-key)',
    },
    ncf_webhook_secret: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Secreto HMAC entregado por el Núcleo para verificar la firma de los webhooks entrantes (X-NCF-Signature)',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Si está en false, Pitbox no envía prefacturas al Núcleo aunque haya tenants con facturación centralizada activa',
    },
    last_test_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_test_ok: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    last_test_message: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
  },
  {
    tableName: 'ncf_config',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = NcfConfig;
