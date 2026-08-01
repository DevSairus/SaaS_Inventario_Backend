// backend/src/models/payments/MetaConfig.js
// Configuración de la App de Meta (Facebook/Instagram) que Pitbox usa como
// PROPIA -- análoga a NcfConfig. Es UNA sola fila porque:
//   1) Se usa como la App de Meta para el flujo OAuth "cuenta propia" de
//      cualquier tenant (Pitbox necesita un solo App ID/secret registrado
//      en Meta for Developers para poder redirigir al diálogo OAuth).
//   2) En el modo "servicio suministrado por Pitbox" (tenant sin cuenta
//      propia de Meta), es el WABA/página compartido que reciben los leads
//      de TODOS los tenants en ese modo -- ver TenantMetaConfig.js para
//      cómo se resuelve cuál lead pertenece a cuál tenant.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const MetaConfig = sequelize.define(
  'MetaConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    app_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'App ID de la App de Meta for Developers registrada por Pitbox',
    },
    app_secret: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'App Secret -- se usa tanto para el intercambio OAuth (code -> token) como para verificar la firma HMAC de los webhooks (X-Hub-Signature-256)',
    },
    webhook_verify_token: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Token arbitrario que Meta reenvía en el handshake GET del webhook (hub.verify_token) -- se define acá y se pega igual en el dashboard de Meta',
    },
    shared_page_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID de la página de Facebook compartida (modo "servicio Pitbox") -- de acá salen los leadgen forms de los tenants sin cuenta propia',
    },
    shared_waba_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'WhatsApp Business Account ID compartido (modo "servicio Pitbox") -- fase WhatsApp Cloud API, aún no operativo',
    },
    shared_system_user_token: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Token de larga duración de un usuario de sistema de Meta Business Manager, con permisos sobre shared_page_id/shared_waba_id',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Si está en false, se rechaza cualquier conexión nueva (OAuth u opt-in al modo compartido) aunque haya credenciales guardadas',
    },
    last_test_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_test_ok: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    last_test_message: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
  },
  {
    tableName: 'meta_config',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = MetaConfig;
