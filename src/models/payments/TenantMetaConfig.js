// backend/src/models/payments/TenantMetaConfig.js
// Conexión de UN tenant con Meta (Facebook/Instagram Lead Ads hoy,
// WhatsApp Business Cloud API en una fase posterior). Soporta dos modos:
//
//   - provider_mode = 'own'    -> el tenant conectó SU PROPIA cuenta de
//     Meta Business vía OAuth. Los leads llegan a la página/WABA del
//     tenant, identificados por own_page_id/own_waba_id.
//   - provider_mode = 'pitbox' -> el tenant no tiene cuenta propia; usa el
//     App/página/WABA compartido de Pitbox (ver MetaConfig). Se identifica
//     por pitbox_lead_form_ids -- los IDs de formulario de Lead Ads que
//     Meta reporta en cada webhook, mapeados a este tenant al darlo de alta.
//
// OJO -- a propósito vive en `public`, NO en el schema propio del tenant
// (a diferencia de Customer/Sale/Opportunity, que sí son schema-per-tenant):
// cuando llega un webhook de Meta, Pitbox todavía no sabe a qué tenant
// pertenece -- necesita resolverlo primero por page_id/waba_id/form_id
// ANTES de poder fijar el search_path del tenant. Por eso esta tabla, igual
// que Tenant.ncf_external_ref, tiene que ser consultable sin schema previo.
// Ver registerTenantSchemaHooks.js (PUBLIC_SCHEMA_MODELS).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TenantMetaConfig = sequelize.define(
  'TenantMetaConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'tenants', key: 'id' },
      onDelete: 'CASCADE',
    },
    provider_mode: {
      type: DataTypes.ENUM('own', 'pitbox'),
      allowNull: true,
      comment: 'null = todavía no conectó nada',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // ── Modo "own" -- credenciales OAuth propias del tenant ────────────────
    own_app_id: { type: DataTypes.STRING(100), allowNull: true },
    own_page_id: { type: DataTypes.STRING(100), allowNull: true },
    own_page_name: { type: DataTypes.STRING(255), allowNull: true },
    own_waba_id: { type: DataTypes.STRING(100), allowNull: true },
    own_phone_number_id: { type: DataTypes.STRING(100), allowNull: true },
    own_access_token: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Token de larga duración (page access token) obtenido en el intercambio OAuth -- Meta lo vence ~60 días, ver own_token_expires_at',
    },
    own_token_expires_at: { type: DataTypes.DATE, allowNull: true },

    // ── Modo "pitbox" -- mapeo dentro del App/página compartida ────────────
    pitbox_lead_form_ids: {
      type: DataTypes.JSONB,
      defaultValue: [],
      comment: 'IDs de formularios de Lead Ads (bajo la página compartida de MetaConfig) asignados a este tenant al darlo de alta',
    },
    pitbox_external_ref: {
      type: DataTypes.STRING(150),
      allowNull: true,
      comment: 'Referencia libre para soporte/onboarding manual (ej. nombre de la cuenta de anuncios del tenant) -- no la usa la lógica de resolución de leads, solo trazabilidad',
    },

    // ── Estado de la conexión ───────────────────────────────────────────────
    connected_at: { type: DataTypes.DATE, allowNull: true },
    disconnected_at: { type: DataTypes.DATE, allowNull: true },
    last_lead_at: { type: DataTypes.DATE, allowNull: true },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    tableName: 'tenant_meta_configs',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = TenantMetaConfig;
