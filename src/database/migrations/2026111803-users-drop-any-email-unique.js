'use strict';

// Complemento de 2026111802-user-identities: esa migración quitaba la
// restricción de correo único global por NOMBRE (users_email_key /
// users_email_unique). Si en algún ambiente se llamaba distinto (por ejemplo
// users_email_key1, creada por un sync de Sequelize), seguía viva y vincular
// a una persona en otra empresa fallaba con una violación de llave única.
//
// Aquí se busca en pg_catalog CUALQUIER índice único, no parcial, de
// public.users cuya única columna sea `email` (columna simple, no la
// expresión lower(email)) y se elimina, sea constraint o índice suelto. Los
// índices nuevos (uq_users_email_tenant, uq_users_email_platform) son
// parciales y sobre lower(email), así que no se tocan.
//
// Idempotente; users vive en public, así que corre igual desde cualquier
// schema (migrateAllTenantSchemas la repite por tenant sin efecto).

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN
          SELECT i.indexrelid::regclass::text AS index_name, c.conname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid AND c.conrelid = i.indrelid
          WHERE i.indrelid = '"public"."users"'::regclass
            AND i.indisunique
            AND NOT i.indisprimary
            AND i.indnatts = 1
            AND i.indpred IS NULL
            AND i.indexprs IS NULL
            AND a.attname = 'email'
        LOOP
          IF r.conname IS NOT NULL THEN
            EXECUTE format('ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS %I', r.conname);
            RAISE NOTICE 'users: constraint % eliminada', r.conname;
          ELSE
            EXECUTE format('DROP INDEX IF EXISTS %s', r.index_name);
            RAISE NOTICE 'users: índice % eliminado', r.index_name;
          END IF;
        END LOOP;
      END $$;
    `);
  },

  down: async () => {
    // Sin reversa: volver al correo único global solo es posible si nadie
    // está vinculado a varias empresas (ver down de 2026111802).
  },
};
