'use strict';

// Una persona en varias empresas (contadores, auxiliares) -- ver
// services/auth/identity.service.js.
//
// Diseño: cada empresa en la que trabaja la persona tiene SU fila en users
// (con su rol, sus sedes, su estado), y todas las filas de la misma persona
// comparten users.identity_id y la misma contraseña. Así no cambia nada de lo
// que ya filtra usuarios por tenant_id (listados, técnicos, comisiones, sedes,
// permisos, renovación del token).
//
//   - users.identity_id: NULL nunca después de esta migración (las filas
//     existentes quedan con identity_id = id; las nuevas lo reciben en el hook
//     beforeCreate de User).
//   - El correo deja de ser único en toda la tabla: es único por empresa
//     (lower(email), tenant_id) y entre usuarios de plataforma (tenant_id
//     NULL). Que dos identidades distintas no compartan correo lo garantiza la
//     aplicación (identity.service.assertEmailAvailable): solo "vincular"
//     crea otra fila con un correo existente.
//   - Una identidad tiene como máximo una fila por empresa.
//
// users vive siempre en public (PUBLIC_SCHEMA_MODELS), así que todo va
// calificado con "public". y es idempotente: migrateAllTenantSchemas la
// vuelve a correr por cada schema de tenant.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS identity_id UUID`);
    await q(`UPDATE "public"."users" SET identity_id = id WHERE identity_id IS NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_users_identity ON "public"."users" (identity_id)`);

    await q(`ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS users_email_key`);
    await q(`ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS users_email_unique`);
    await q(`DROP INDEX IF EXISTS "public".users_email_key`);
    await q(`DROP INDEX IF EXISTS "public".users_email_unique`);

    // Si en algún ambiente hubiera correos que solo difieren en mayúsculas
    // dentro de la misma empresa, el índice único fallaría: se deja aviso y
    // no se detiene el arranque (la app igual valida antes de crear).
    await q(`
      DO $$ BEGIN
        BEGIN
          CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_tenant
            ON "public"."users" (LOWER(email), tenant_id)
            WHERE email IS NOT NULL AND tenant_id IS NOT NULL;
        EXCEPTION WHEN unique_violation THEN
          RAISE NOTICE 'uq_users_email_tenant no creado: hay correos repetidos en una misma empresa';
        END;
        BEGIN
          CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_platform
            ON "public"."users" (LOWER(email))
            WHERE email IS NOT NULL AND tenant_id IS NULL;
        EXCEPTION WHEN unique_violation THEN
          RAISE NOTICE 'uq_users_email_platform no creado: hay correos repetidos entre usuarios de plataforma';
        END;
        BEGIN
          CREATE UNIQUE INDEX IF NOT EXISTS uq_users_identity_tenant
            ON "public"."users" (identity_id, tenant_id)
            WHERE tenant_id IS NOT NULL;
        EXCEPTION WHEN unique_violation THEN
          RAISE NOTICE 'uq_users_identity_tenant no creado';
        END;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS "public".uq_users_identity_tenant`);
    await q(`DROP INDEX IF EXISTS "public".uq_users_email_platform`);
    await q(`DROP INDEX IF EXISTS "public".uq_users_email_tenant`);
    // Volver al correo único global solo es posible si no se vinculó a nadie.
    await q(`ALTER TABLE "public"."users" ADD CONSTRAINT users_email_key UNIQUE (email)`);
    await q(`DROP INDEX IF EXISTS "public".idx_users_identity`);
    await q(`ALTER TABLE "public"."users" DROP COLUMN IF EXISTS identity_id`);
  },
};
