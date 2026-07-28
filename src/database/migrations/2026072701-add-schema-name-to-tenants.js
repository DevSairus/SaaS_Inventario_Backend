// src/database/migrations/2026072701-add-schema-name-to-tenants.js
module.exports = {
  up: async (qi, S) => {
    // `tenants` es compartida (vive en "public") y esta migración corre una
    // vez por cada schema de tenant aprovisionado -> hay que chequear
    // existencia o el segundo tenant que se aprovisione choca con
    // "column already exists".
    const existingColumns = await qi.describeTable('tenants', { schema: 'public' });
    if (!existingColumns.schema_name) {
      await qi.addColumn('tenants', 'schema_name', { type: S.STRING, allowNull: true, unique: true }, { schema: 'public' });
    }
  },
  down: (qi) => qi.removeColumn('tenants', 'schema_name', { schema: 'public' }),
};
