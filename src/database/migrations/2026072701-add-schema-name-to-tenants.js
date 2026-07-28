// src/database/migrations/2026072701-add-schema-name-to-tenants.js
module.exports = {
  up: (qi, S) => qi.addColumn('tenants', 'schema_name', { type: S.STRING, allowNull: true, unique: true }),
  down: (qi) => qi.removeColumn('tenants', 'schema_name'),
};