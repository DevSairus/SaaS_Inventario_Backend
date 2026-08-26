'use strict';

// Cifra en reposo los secretos que hasta ahora vivían en texto plano en
// meta_config: app_secret (firma HMAC de webhooks + OAuth client_secret) y
// shared_system_user_token (token del WABA/página compartida de Pitbox).
// A partir de esta migración, MetaConfig.js lee/escribe estos campos vía
// getter/setter que cifra con metaTokenCrypto (AES-256-GCM) -- acá solo se
// re-encriptan los valores que ya estaban guardados en texto plano, para
// que el "en reposo" también aplique a datos existentes, no solo a los
// nuevos. Es un data-migration, no altera el esquema (por eso no toca
// columnas ni tipos).
const { encryptToken } = require('../../utils/metaTokenCrypto');

const FIELDS = ['app_secret', 'shared_system_user_token'];
const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';

module.exports = {
  up: async (queryInterface) => {
    const desc = await queryInterface.describeTable('meta_config').catch(() => null);
    if (!desc) return;

    const [rows] = await queryInterface.sequelize.query(
      `SELECT id, ${FIELDS.join(', ')} FROM meta_config`
    );

    for (const row of rows) {
      const updates = {};
      for (const field of FIELDS) {
        const value = row[field];
        if (!value) continue;
        if (value.startsWith(ENC_PREFIX) || value.startsWith(PLAIN_PREFIX)) continue; // ya procesado
        updates[field] = encryptToken(value);
      }
      if (Object.keys(updates).length === 0) continue;

      const setClause = Object.keys(updates).map((f, i) => `${f} = :v${i}`).join(', ');
      const replacements = { id: row.id };
      Object.keys(updates).forEach((f, i) => { replacements[`v${i}`] = updates[f]; });

      await queryInterface.sequelize.query(
        `UPDATE meta_config SET ${setClause} WHERE id = :id`,
        { replacements }
      );
    }
  },

  down: async () => {
    // Irreversible a propósito: no hay forma segura de "des-cifrar hacia
    // texto plano" sin conocer si el valor original tenía o no el prefijo
    // plain: -- y dejar secretos en claro de nuevo no es un rollback
    // razonable. Si hace falta revertir, restaurar desde backup de BD.
  },
};
