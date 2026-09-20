'use strict';

// Corrección de FKs cross-schema en tablas del CRM.
//
// EL BUG: `2026091703-create-crm-gamification-base.js` declaró
//   goal_id: references: { model: { tableName: 'crm_goals', schema: 'public' } }
// y `2026080306-create-crm-automation-rules.js` hizo lo mismo con
// `crm_automation_rules` y `opportunities`. Esa calificación explícita de
// schema solo corresponde a las tablas que de verdad viven siempre en
// `public` (tenants, users, subscription_plans — ver
// scripts/codemod-crossschema-fk.js). `crm_goals`, `crm_automation_rules` y
// `opportunities` son tablas de TENANT: se crean dentro de cada schema
// `tenant_*` cuando provisionTenantSchema.js corre las migraciones con el
// search_path apuntando a ese schema.
//
// Resultado: en un tenant ya cortado a su propio schema, la fila de la meta
// vive en `tenant_x.crm_goals`, pero la FK de `tenant_x.crm_goal_progress`
// apunta a `public.crm_goals` — donde ese id no existe. Todo INSERT revienta
// con "viola la llave foránea crm_goal_progress_goal_id_fkey", y como
// getOrRecalculateProgress() escribe la caché en cada lectura, GET
// /api/crm/goals/progress devuelve 500 siempre. Lo mismo le pasa (más
// silenciosamente, porque el motor de automatizaciones traga sus errores) a
// crm_automation_rule_logs: sus logs de dedupe nunca se insertan, así que
// una regla puede dispararse más de una vez para la misma oportunidad.
//
// LA CORRECCIÓN: repuntar cada FK al MISMO schema donde vive la tabla hija.
// Se hace con SQL crudo y `current_schema()` a propósito: queryInterface
// .addConstraint() resuelve el schema por `sequelize.options.schema` y no
// por el search_path, así que no sirve para una migración que tiene que
// funcionar tanto en `public` como dentro de cada schema de tenant.
//
// Es idempotente: si la FK ya apunta al schema correcto, no toca nada.
// provisionTenantSchema.js / migrateAllTenantSchemas.js (que corre solo al
// arrancar el servidor) la aplicarán a cada tenant ya cortado.

const FK_TARGETS = [
  {
    table: 'crm_goal_progress',
    column: 'goal_id',
    refTable: 'crm_goals',
    refColumn: 'id',
    constraint: 'crm_goal_progress_goal_id_fkey',
    onDelete: 'CASCADE',
  },
  {
    table: 'crm_automation_rule_logs',
    column: 'automation_rule_id',
    refTable: 'crm_automation_rules',
    refColumn: 'id',
    constraint: 'crm_automation_rule_logs_automation_rule_id_fkey',
    onDelete: 'CASCADE',
  },
  {
    table: 'crm_automation_rule_logs',
    column: 'opportunity_id',
    refTable: 'opportunities',
    refColumn: 'id',
    constraint: 'crm_automation_rule_logs_opportunity_id_fkey',
    onDelete: 'CASCADE',
  },
];

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

async function tableExists(sequelize, schema, table) {
  const [rows] = await sequelize.query(
    'SELECT to_regclass(:qualified) IS NOT NULL AS ok',
    { replacements: { qualified: `${schema}.${table}` } }
  );
  return !!(rows[0] && rows[0].ok);
}

// FK de una sola columna definida sobre (schema.table, column), con el
// schema al que apunta hoy. Devuelve null si no hay ninguna.
async function findForeignKey(sequelize, schema, table, column) {
  const [rows] = await sequelize.query(`
    SELECT con.conname AS name, ref_ns.nspname AS ref_schema, ref.relname AS ref_table
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_class ref ON ref.oid = con.confrelid
    JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND ns.nspname = :schema
      AND rel.relname = :table
      AND att.attname = :column
    LIMIT 1
  `, { replacements: { schema, table, column } });
  return rows[0] || null;
}

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [schemaRows] = await sequelize.query('SELECT current_schema() AS schema');
    const schema = schemaRows[0].schema;

    for (const fk of FK_TARGETS) {
      const childExists = await tableExists(sequelize, schema, fk.table);
      if (!childExists) continue; // el schema todavía no tiene esa tabla

      const parentExists = await tableExists(sequelize, schema, fk.refTable);
      if (!parentExists) {
        console.warn(`[fix-crm-fks] ${schema}.${fk.refTable} no existe — se omite ${fk.table}.${fk.column}`);
        continue;
      }

      const current = await findForeignKey(sequelize, schema, fk.table, fk.column);
      if (current && current.ref_schema === schema) continue; // ya está bien

      if (current) {
        await sequelize.query(
          `ALTER TABLE ${q(schema)}.${q(fk.table)} DROP CONSTRAINT ${q(current.name)}`
        );
      }

      // Huérfanas: filas cuyo padre no existe en ESTE schema. En la
      // práctica no debería haber ninguna (el INSERT venía fallando, por eso
      // el bug se ve como un 500), pero sin esto el ALTER no podría agregar
      // la constraint. Son tablas de caché/log, no de negocio.
      await sequelize.query(`
        DELETE FROM ${q(schema)}.${q(fk.table)} child
        WHERE child.${q(fk.column)} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${q(schema)}.${q(fk.refTable)} parent
            WHERE parent.${q(fk.refColumn)} = child.${q(fk.column)}
          )
      `);

      await sequelize.query(`
        ALTER TABLE ${q(schema)}.${q(fk.table)}
        ADD CONSTRAINT ${q(fk.constraint)}
        FOREIGN KEY (${q(fk.column)})
        REFERENCES ${q(schema)}.${q(fk.refTable)} (${q(fk.refColumn)})
        ON DELETE ${fk.onDelete} ON UPDATE CASCADE
      `);

      console.log(`[fix-crm-fks] ${schema}.${fk.table}.${fk.column} → ${schema}.${fk.refTable} (antes: ${current ? current.ref_schema : 'sin FK'})`);
    }
  },

  // Sin rollback: volver a apuntar estas FKs a `public` es exactamente el
  // bug que esta migración corrige.
  down: async () => {},
};
