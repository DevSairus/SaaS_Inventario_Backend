'use strict';

// Cierra el hueco de aislamiento multi-tenant en WhatsApp Cloud API: hasta
// ahora `tenant_meta_configs.own_phone_number_id` solo tenía un índice NO
// único, así que nada en la base de datos impedía que dos tenants activos
// terminaran apuntando al mismo phone_number_id (por error humano, o si
// alguien lo forzaba vía completeEmbeddedSignup -- ver la validación nueva
// en whatsappCloud.service.js). Si eso pasa, los webhooks entrantes de
// Meta se resuelven con TenantMetaConfig.findOne() y terminan en el inbox
// de "el que sea que la consulta devuelva primero" -- fuga de conversaciones
// de un cliente entre tenants.
//
// Regla: como máximo UN registro ACTIVO por phone_number_id. Se usa un
// índice único PARCIAL (WHERE is_active AND own_phone_number_id IS NOT
// NULL) en vez de UNIQUE simple porque:
//   - Un tenant puede desconectar y reconectar (is_active=false en el
//     medio) sin chocar consigo mismo.
//   - Varios tenants sin conectar (own_phone_number_id NULL) no deben
//     contar como "duplicados".
module.exports = {
  up: async (queryInterface) => {
    // Antes de crear el índice: si en la BD de pruebas ya hay duplicados
    // activos (de antes de este fix), se desactivan todos menos el más
    // reciente para no romper la migración -- y queda registrado en
    // last_error para que soporte lo revise a mano.
    const [dupes] = await queryInterface.sequelize.query(`
      SELECT own_phone_number_id
      FROM tenant_meta_configs
      WHERE is_active = true AND own_phone_number_id IS NOT NULL
      GROUP BY own_phone_number_id
      HAVING COUNT(*) > 1
    `);

    for (const row of dupes) {
      await queryInterface.sequelize.query(`
        UPDATE tenant_meta_configs
        SET is_active = false,
            last_error = 'Desactivado automáticamente: phone_number_id duplicado detectado por la migración 2026080601 (revisar con soporte antes de reactivar)'
        WHERE own_phone_number_id = :phoneNumberId
          AND is_active = true
          AND id <> (
            SELECT id FROM tenant_meta_configs
            WHERE own_phone_number_id = :phoneNumberId AND is_active = true
            ORDER BY updated_at DESC
            LIMIT 1
          )
      `, { replacements: { phoneNumberId: row.own_phone_number_id } });
    }

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tenant_meta_configs_active_phone_number_id_uq
      ON tenant_meta_configs (own_phone_number_id)
      WHERE is_active = true AND own_phone_number_id IS NOT NULL
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS tenant_meta_configs_active_phone_number_id_uq
    `);
  },
};
