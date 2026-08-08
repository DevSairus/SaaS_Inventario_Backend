// backend/src/models/ensambladora/EnsambladoraRuntSolicitud.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraRuntSolicitud = sequelize.define(
  'EnsambladoraRuntSolicitud',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false },
    tipo_reporte: { type: DataTypes.ENUM('matricula', 'traspaso'), allowNull: false },
    datos_tramite: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_runt_solicitudes',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraRuntSolicitud;
