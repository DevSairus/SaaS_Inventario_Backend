// backend/src/models/ensambladora/EnsambladoraOrdenAlistamiento.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraOrdenAlistamiento = sequelize.define(
  'EnsambladoraOrdenAlistamiento',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false, unique: true },
    responsable: DataTypes.STRING,
    fecha: { type: DataTypes.DATE, allowNull: false },
    checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    observaciones: DataTypes.TEXT,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_ordenes_alistamiento',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraOrdenAlistamiento;
