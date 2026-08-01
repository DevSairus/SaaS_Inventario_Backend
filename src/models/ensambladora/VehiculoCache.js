// backend/src/models/ensambladora/VehiculoCache.js
// Copia local de solo lectura de vehículos consultados/vendidos por este
// CSA. Vive en el schema del tenant (default) -- ver la migración
// 2026080101-create-vehiculos-cache.js para el porqué.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehiculoCache = sequelize.define(
  'VehiculoCache',
  {
    vin: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    datos: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    ultima_sincronizacion: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    verificado_en_linea: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: 'vehiculos_cache',
    timestamps: false,
  }
);

module.exports = VehiculoCache;
