// backend/src/models/ensambladora/EnsambladoraAuditLog.js
//
// Log de auditoría de acciones sobre entidades del módulo Ensambladora
// (garantía, alistamiento, etc). Registra QUIÉN (usuario logueado de este
// panel, o "Ensambladora (Core)" si el actor fue un evento entrante) hizo
// QUÉ acción y CUÁNDO. Es de solo-append (sin updated_at) -- ver
// services/ensambladora/auditLog.js#registrarAuditoria.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraAuditLog = sequelize.define(
  'EnsambladoraAuditLog',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    entidad_tipo: { type: DataTypes.STRING, allowNull: false },
    entidad_id: { type: DataTypes.UUID, allowNull: true },
    vin: { type: DataTypes.STRING, allowNull: true },
    accion: { type: DataTypes.STRING, allowNull: false },
    usuario_id: { type: DataTypes.UUID, allowNull: true },
    usuario_nombre: { type: DataTypes.STRING, allowNull: true },
    detalle: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  },
  {
    tableName: 'ensambladora_audit_logs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
  }
);

module.exports = EnsambladoraAuditLog;
