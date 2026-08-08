// backend/src/models/ensambladora/EnsambladoraCotizacion.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraCotizacion = sequelize.define(
  'EnsambladoraCotizacion',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: DataTypes.STRING,
    linea_id: { type: DataTypes.UUID, allowNull: false },
    linea_nombre: DataTypes.STRING,
    tecnico_documento: DataTypes.STRING,
    cliente_nombre: DataTypes.STRING,
    cliente_documento: DataTypes.STRING,
    cliente_telefono: DataTypes.STRING,
    fecha: { type: DataTypes.DATEONLY, allowNull: false },
    items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    total: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    core_cotizacion_id: DataTypes.UUID,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_cotizaciones',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraCotizacion;
