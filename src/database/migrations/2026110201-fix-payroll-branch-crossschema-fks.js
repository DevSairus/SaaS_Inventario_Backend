'use strict';

// Corrección de FKs cross-schema en las tablas de nómina hacia `branches`.
//
// EL BUG: 20260830040000-create-payroll-core-tables.js y
// 20260830250000-create-payroll-documents-tables.js declararon
//   branch_id UUID REFERENCES "public"."branches"(id) ON DELETE SET NULL
// pero `branches` es tabla de TENANT (vive en cada schema `tenant_*`), no
// compartida como tenants/users. Mismo error que corrigió
// 2026091704-fix-crm-crossschema-fks.js para el CRM.
//
// Consecuencias en un tenant ya cortado a su schema:
//   - Asignar a un empleado/periodo/documento una sede creada DESPUÉS del
//     corte revienta con "viola la llave foránea ..._branch_id_fkey" (esa
//     sede no existe en public).
//   - cleanupTenantPublicData.js borra las sedes del tenant en public y el
//     ON DELETE SET NULL deja en NULL el branch_id de sus empleados, periodos
//     y documentos de nómina DENTRO del schema del tenant.
//
// LA CORRECCIÓN: repuntar cada FK al mismo schema de la tabla hija, con SQL
// crudo y current_schema() (corre en public y en cada schema de tenant).
// Huérfanas: a diferencia de la migración del CRM NO se borran filas (son
// datos de negocio); solo se pone branch_id en NULL, que es lo mismo que
// habría hecho el ON DELETE SET NULL.
//
// Idempotente: si la FK ya apunta al schema correcto, no toca nada.

const FK_TARGETS = [
  { table: 'employees', constraint: 'employees_branch_id_fkey' },
  { table: 'payroll_periods', constraint: 'payroll_periods_branch_id_fkey' },
  { table: 'payroll_documents', constraint: 'payroll_documents_branch_id_fkey' },
];

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

async function tableExists(sequelize, schema, table) {
  const [rows] = await sequelize.query(
    'SELECT to_regclass(:qualified) IS NOT NULL AS ok',
    { replacements: { qualified: `${schema}.${table}` } }
  );
  return !!(rows[0] && rows[0].ok);
}

async function findForeignKey(sequelize, schema, table, column) {
  const [rows] = await sequelize.query(`
    SELECT con.conname AS name, ref_ns.nspname AS ref_schema
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

    if (!(await tableExists(sequelize, schema, 'branches'))) return;

    for (const fk of FK_TARGETS) {
      if (!(await tableExists(sequelize, schema, fk.table))) continue;

      const current = await findForeignKey(sequelize, schema, fk.table, 'branch_id');
      if (current && current.ref_schema === schema) continue; // ya está bien

      if (current) {
        await sequelize.query(`ALTER TABLE ${q(schema)}.${q(fk.table)} DROP CONSTRAINT ${q(current.name)}`);
      }

      const [, meta] = await sequelize.query(`
        UPDATE ${q(schema)}.${q(fk.table)} child
        SET branch_id = NULL
        WHERE child.branch_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${q(schema)}.branches b WHERE b.id = child.branch_id)
      `);
      const orphans = meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0;

      await sequelize.query(`
        ALTER TABLE ${q(schema)}.${q(fk.table)}
        ADD CONSTRAINT ${q(fk.constraint)}
        FOREIGN KEY (branch_id)
        REFERENCES ${q(schema)}.branches (id)
        ON DELETE SET NULL
      `);

      console.log(
        `[fix-payroll-branch-fks] ${schema}.${fk.table}.branch_id → ${schema}.branches ` +
        `(antes: ${current ? current.ref_schema : 'sin FK'}${orphans ? `, ${orphans} huérfanas a NULL` : ''})`
      );
    }
  },

  // Sin rollback: volver a apuntar a public es exactamente el bug.
  down: async () => {},
};
