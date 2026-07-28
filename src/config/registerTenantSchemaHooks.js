// src/config/registerTenantSchemaHooks.js
//
// Registra hooks globales en Sequelize para que TODAS las queries
// (findAll, findOne, create, update, destroy, bulkCreate, count, etc.)
// se ejecuten automáticamente contra el schema del tenant actual,
// sin tocar controllers ni services existentes.
//
// IMPORTANTE: para queries con `include` (joins), cada modelo incluido
// también necesita el schema seteado -> lo resolvemos recursivamente.

const { getCurrentSchema } = require('./tenantContext');

// Modelos que NUNCA deben moverse de `public` aunque haya un tenant activo
const PUBLIC_SCHEMA_MODELS = new Set([
  'Tenant',
  'User',
  'SubscriptionPlan',
  'TenantSubscription',
  'SubscriptionInvoice',
  'SuperAdminMercadoPagoConfig',
  'Permission',
  'RolePermission',
  'Announcement',
  'UserAnnouncementView',
]);

function applySchemaToIncludes(includes, schema) {
  if (!includes) return;
  const list = Array.isArray(includes) ? includes : [includes];
  for (const inc of list) {
    if (!inc || !inc.model) continue;
    if (!PUBLIC_SCHEMA_MODELS.has(inc.model.name)) {
      inc.model = inc.model.schema(schema);
    }
    if (inc.include) applySchemaToIncludes(inc.include, schema);
  }
}

function withTenantSchema(options) {
  const schema = getCurrentSchema();
  if (!schema) return options; // rutas sin tenant (superadmin, login) -> comportamiento normal

  options = options || {};
  options.schema = schema;
  if (options.include) applySchemaToIncludes(options.include, schema);
  return options;
}

function registerTenantSchemaHooks(sequelize) {
  const hookNames = [
    'beforeFind',
    'beforeCount',
    'beforeBulkCreate',
    'beforeCreate',
    'beforeUpdate',
    'beforeBulkUpdate',
    'beforeDestroy',
    'beforeBulkDestroy',
    'beforeUpsert',
    'beforeSave',
  ];

  for (const modelName in sequelize.models) {
    const model = sequelize.models[modelName];
    if (PUBLIC_SCHEMA_MODELS.has(modelName)) continue; // se quedan en public siempre

    for (const hookName of hookNames) {
      model.addHook(hookName, (instanceOrOptions, options) => {
        // beforeCreate/beforeUpdate/beforeSave reciben (instance, options)
        const opts = options || instanceOrOptions;
        withTenantSchema(opts);
      });
    }
  }
}

module.exports = { registerTenantSchemaHooks, withTenantSchema, PUBLIC_SCHEMA_MODELS };