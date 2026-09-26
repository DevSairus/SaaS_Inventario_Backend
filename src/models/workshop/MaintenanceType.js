// backend/src/models/workshop/MaintenanceType.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Mismos valores que Vehicle.vehicle_type -- en BD es STRING (ver migración
// 2026092501), la lista válida se impone acá.
const VEHICLE_TYPES = ['automovil', 'camioneta', 'motocicleta', 'camion', 'otro'];

// Tipo de mantenimiento con su intervalo, por tenant y tipo de vehículo --
// ver 00 - Documentación/plan-portal-mantenimiento-vehiculo.md sección 3.1.
const MaintenanceType = sequelize.define('MaintenanceType', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  vehicle_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [VEHICLE_TYPES] },
  },
  interval_km: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  interval_months: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  // Palabras que, si aparecen en product_name de un ítem de la OT, disparan
  // el registro automático de este mantenimiento al entregarla.
  match_keywords: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'maintenance_types',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'vehicle_type'] },
  ],
  validate: {
    // Sin ninguno de los dos no hay forma de calcular el "próximo".
    hasSomeInterval() {
      if (!this.interval_km && !this.interval_months) {
        throw new Error('Debes indicar un intervalo en km, en meses o ambos');
      }
    },
  },
});

MaintenanceType.VEHICLE_TYPES = VEHICLE_TYPES;

module.exports = MaintenanceType;
