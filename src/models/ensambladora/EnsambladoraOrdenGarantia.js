// backend/src/models/ensambladora/EnsambladoraOrdenGarantia.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraOrdenGarantia = sequelize.define(
  'EnsambladoraOrdenGarantia',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false },
    tecnico_documento: DataTypes.STRING,
    items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    core_orden_garantia_id: DataTypes.UUID,
    cerrada: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    fecha_cierre: DataTypes.DATEONLY,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
    // Token público para que el cliente consulte el estado de su garantía
    // sin autenticarse -- mismo patrón que WorkOrder.share_token.
    share_token: { type: DataTypes.UUID, allowNull: true, unique: true },
  },
  {
    tableName: 'ensambladora_ordenes_garantia',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraOrdenGarantia;
