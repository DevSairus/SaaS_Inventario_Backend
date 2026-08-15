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
    // Mismo criterio que EnsambladoraOrdenRevision -- sin esto, el evento
    // alistamiento.completado nunca llevaba valor a cobrar y el Core no
    // tenía nada que facturar en la liquidación.
    tarifario_servicio_id: DataTypes.UUID,
    valor_mano_obra: DataTypes.DECIMAL(12, 2),
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
