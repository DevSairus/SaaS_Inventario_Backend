'use strict';

// Módulo Ensambladora — Fase 0. Ambas tablas viven en `public` (no en el
// schema propio de cada tenant) por la misma razón que tenant_meta_configs:
// un evento entrante todavía no sabe a qué tenant pertenece hasta resolver
// el X-Api-Key, así que tienen que ser consultables sin haber fijado antes
// el search_path de ningún tenant. Ver EnsambladoraSyncCredential.js y
// registerTenantSchemaHooks.js (PUBLIC_SCHEMA_MODELS).
//
// ensambladora_sync_credentials: una fila por tenant con el módulo activo,
// con el api_key/hmac_secret que le asignó el Core Ensambladora (mismo
// esquema descrito en contrato-sincronizacion-ensambladora.md, sección 2).
//
// ensambladora_eventos_sync: outbox/inbox del lado Pitbox, análogo a
// `eventos_sync` del Core (ver modelo-datos-ensambladora.md, sección 5),
// con tenant_id explícito porque vive en public.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ensambladora_sync_credentials', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE',
      },
      csa_pdv_id_externo: {
        type: Sequelize.UUID,
        allowNull: true,
        comment: 'id del csa_pdv correspondiente en el Core Ensambladora',
      },
      api_key: {
        type: Sequelize.STRING(150),
        allowNull: false,
        unique: true,
        comment: 'Emitida por el Core Ensambladora; se envía en X-Api-Key en ambas direcciones',
      },
      hmac_secret: {
        type: Sequelize.STRING(150),
        allowNull: false,
        comment: 'Secreto compartido con el Core para firmar/verificar X-Signature',
      },
      estado: {
        type: Sequelize.ENUM('activo', 'suspendido', 'revocado'),
        allowNull: false,
        defaultValue: 'activo',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ensambladora_eventos_sync', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'También actúa como event_id / clave de idempotencia',
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE',
      },
      direccion: { type: Sequelize.ENUM('saliente', 'entrante'), allowNull: false },
      tipo_evento: { type: Sequelize.STRING(100), allowNull: false },
      version: { type: Sequelize.STRING(10), allowNull: false, defaultValue: '1.0' },
      entidad_tipo: { type: Sequelize.STRING(100), allowNull: true },
      entidad_id: { type: Sequelize.UUID, allowNull: true },
      payload: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      origen: { type: Sequelize.ENUM('ensambladora', 'csa_pdv'), allowNull: false },
      estado: {
        type: Sequelize.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      intentos: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ultimo_error: { type: Sequelize.TEXT, allowNull: true },
      revisado: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      revisado_por: { type: Sequelize.STRING(150), allowNull: true },
      revisado_en: { type: Sequelize.DATE, allowNull: true },
      ocurrido_en: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      procesado_en: { type: Sequelize.DATE, allowNull: true },
    });

    await queryInterface.addIndex('ensambladora_eventos_sync', ['tenant_id', 'estado']);
    await queryInterface.addIndex('ensambladora_eventos_sync', ['tipo_evento']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ensambladora_eventos_sync');
    await queryInterface.dropTable('ensambladora_sync_credentials');
  },
};
