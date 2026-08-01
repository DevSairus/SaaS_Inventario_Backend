// backend/src/models/ensambladora/EnsambladoraOrdenEntrega.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraOrdenEntrega = sequelize.define(
  'EnsambladoraOrdenEntrega',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false, unique: true },
    fecha_entrega: { type: DataTypes.DATE, allowNull: false },
    recibido_por: DataTypes.STRING,
    evidencia_url: DataTypes.STRING,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_ordenes_entrega',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraOrdenEntrega;
