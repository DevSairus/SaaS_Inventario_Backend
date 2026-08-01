// backend/src/models/ensambladora/EnsambladoraEventoSync.js
//
// Outbox/inbox de sincronización de ESTE tenant con el Core Ensambladora.
// Vive en `public` con tenant_id explícito, igual que EnsambladoraSyncCredential
// (ver ese archivo para el motivo). Análogo a `eventos_sync` del lado Core --
// ver modelo-datos-ensambladora.md, sección 5.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const EnsambladoraEventoSync = sequelize.define(
  'EnsambladoraEventoSync',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      comment: 'event_id del envelope -- clave de idempotencia, no se autogenera aquí',
    },
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'tenants', key: 'id' },
      onDelete: 'CASCADE',
    },
    direccion: {
      type: DataTypes.ENUM('saliente', 'entrante'),
      allowNull: false,
    },
    tipo_evento: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: '1.0',
    },
    entidad_tipo: DataTypes.STRING(100),
    entidad_id: DataTypes.UUID,
    payload: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    origen: {
      type: DataTypes.ENUM('ensambladora', 'csa_pdv'),
      allowNull: false,
    },
    estado: {
      type: DataTypes.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    intentos: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    ultimo_error: DataTypes.TEXT,
    revisado: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    revisado_por: DataTypes.STRING(150),
    revisado_en: DataTypes.DATE,
    ocurrido_en: DataTypes.DATE,
    procesado_en: DataTypes.DATE,
  },
  {
    tableName: 'ensambladora_eventos_sync',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
  }
);

module.exports = EnsambladoraEventoSync;
