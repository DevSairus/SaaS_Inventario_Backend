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
const { encryptToken, decryptToken } = require('../../utils/metaTokenCrypto');
const logger = require('../../config/logger') || console;

// app_secret y shared_system_user_token son los secretos más sensibles de
// toda la integración: el primero firma/verifica TODOS los webhooks
// entrantes de Meta (Lead Ads + WhatsApp) y el segundo es un token de larga
// duración con permisos sobre la página/WABA COMPARTIDA por todos los
// tenants en modo "pitbox". Antes se guardaban en texto plano (a diferencia
// de TenantMetaConfig.own_access_token, que sí usaba AES-256-GCM) -- se
// cifran acá con el mismo esquema (metaTokenCrypto), transparente para el
// resto del código: se sigue leyendo/escribiendo `config.app_secret` como
// texto plano, el cifrado/descifrado ocurre en el getter/setter del modelo.
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
      comment: 'App Secret -- se usa tanto para el intercambio OAuth (code -> token) como para verificar la firma HMAC de los webhooks (X-Hub-Signature-256). Cifrado en reposo (AES-256-GCM, ver metaTokenCrypto.js) -- expuesto en JS como texto plano vía getter/setter.',
      get() {
        const raw = this.getDataValue('app_secret');
        if (!raw) return raw;
        try {
          return decryptToken(raw);
        } catch (err) {
          logger.error('[MetaConfig] No se pudo descifrar app_secret:', err.message);
          return null;
        }
      },
      set(value) {
        this.setDataValue('app_secret', value ? encryptToken(value) : value);
      },
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
      comment: 'WhatsApp Business Account ID compartido (modo "servicio Pitbox")',
    },
    embedded_signup_config_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Config ID de Embedded Signup (FB JS SDK) para Tech Provider / coexistencia',
    },
    shared_system_user_token: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Token de larga duración de un usuario de sistema de Meta Business Manager, con permisos sobre shared_page_id/shared_waba_id. Cifrado en reposo, igual que app_secret.',
      get() {
        const raw = this.getDataValue('shared_system_user_token');
        if (!raw) return raw;
        try {
          return decryptToken(raw);
        } catch (err) {
          logger.error('[MetaConfig] No se pudo descifrar shared_system_user_token:', err.message);
          return null;
        }
      },
      set(value) {
        this.setDataValue('shared_system_user_token', value ? encryptToken(value) : value);
      },
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
