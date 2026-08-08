// backend/src/models/ensambladora/EnsambladoraVenta.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraVenta = sequelize.define(
  'EnsambladoraVenta',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    vin: { type: DataTypes.STRING, allowNull: false, unique: true },
    cliente_documento: DataTypes.STRING,
    cliente_nombre: DataTypes.STRING,
    cliente_telefono: DataTypes.STRING,
    fecha_venta: { type: DataTypes.DATEONLY, allowNull: false },
    precio: DataTypes.DECIMAL(14, 2),
    // Quién hizo la venta -- cédula del usuario logueado por defecto, o de
    // quien elija un admin (ver useUsuarioTecnico.js del frontend).
    vendedor_documento: DataTypes.STRING,
    sync_estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    evento_sync_id: DataTypes.UUID,
  },
  {
    tableName: 'ensambladora_ventas',
    timestamps: true,
    underscored: true,
  }
);

module.exports = EnsambladoraVenta;
