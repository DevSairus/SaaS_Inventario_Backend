// src/config/tenantContext.js
const { AsyncLocalStorage } = require('async_hooks');
const tenantContext = new AsyncLocalStorage();

function runWithTenantSchema(schemaName, fn) {
  return tenantContext.run({ schemaName }, fn);
}

function getCurrentSchema() {
  const store = tenantContext.getStore();
  return store ? store.schemaName : undefined;
}

module.exports = { tenantContext, runWithTenantSchema, getCurrentSchema };