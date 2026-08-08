// backend/src/models/ensambladora/EnsambladoraTecnicoAsesor.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraTecnicoAsesor = sequelize.define(
  'EnsambladoraTecnicoAsesor',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    documento_identidad: { type: DataTypes.STRING, allowNull: false, unique: true },
    nombre: DataTypes.STRING,
    rol: { type: DataTypes.ENUM('tecnico', 'asesor'), allowNull: false },
    vinculado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_tecnicos_asesores',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraTecnicoAsesor;
