// src/config/registerTenantSchemaHooks.js
//
// Hace que TODAS las queries (findAll, findOne, create, update, destroy,
// bulkCreate, count, includes/joins, etc.) de los modelos de tenant se
// ejecuten automáticamente contra el schema del tenant actual, sin tocar
// controllers ni services existentes.
//
// VERSIÓN ANTERIOR (rota): usaba hooks (beforeFind/beforeCreate/...) que
// mutaban `options.schema`. Sequelize v6 NUNCA lee `options.schema` para
// resolver el nombre de tabla de una query normal -- `Model.getTableName()`
// (lib/model.js) ignora sus argumentos y siempre llama a
// `queryGenerator.addSchema(this)`, que lee `this._schema` (una propiedad
// del MODELO, no de las opciones de la query). Por eso, tras cortar un
// tenant, la app seguía leyendo/escribiendo en `public` sin que nada avisara
// del error -- los hooks corrían pero no tenían ningún efecto real. Solo
// `applySchemaToIncludes` (que sí llamaba a `model.schema(schema)`) hacía
// algo, y solo para modelos incluidos vía `include`, no para la query
// principal ni para create/update/destroy directos.
//
// FIX: en vez de mutar options, se reemplaza `_schema` en cada modelo de
// tenant por una propiedad dinámica (get/set) que resuelve
// `getCurrentSchema()` en el momento en que Sequelize la lee -- es decir,
// justo al armar el SQL de cada query, dentro del mismo contexto async del
// request (AsyncLocalStorage, ver tenantContext.js). Como TODOS los `include`
// de una query normal apuntan a la MISMA clase de modelo (no a un clon),
// heredan el mismo comportamiento dinámico automáticamente -- ya no hace
// falta re-resolver includes a mano.
//
// El setter conserva el comportamiento original de `Model.schema(x)` (usado
// internamente por Sequelize en asociaciones belongsToMany con `{ schema }`
// explícito): sigue produciendo un schema FIJO en el clon, en vez de dinámico,
// guardándolo en una propiedad propia (`_fixedSchema`) que el getter prioriza
// sobre el contexto del request.

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
  // Soporte técnico — SuperAdmin necesita ver los tickets de TODOS los
  // tenants desde una sola bandeja (/api/superadmin/support no pasa por
  // tenantMiddleware, así que su contexto de schema siempre es 'public').
  // Si estos modelos se resolvieran al schema del tenant activo, los
  // tickets creados por un tenant ya migrado a su propio schema quedarían
  // invisibles para SuperAdmin (mismo bug que ya se vio con checklist_in
  // en workOrders.controller.js, pero aquí sin raw query que lo tape).
  'SupportTicket',
  'SupportTicketMessage',
  'SupportTicketAttachment',
  // Acceso remoto de soporte: SuperAdmin crea la sesión (sin tenantMiddleware,
  // schema 'public'), pero el cliente la consulta desde /api/support/... que
  // SÍ pasa por tenantMiddleware -- si este modelo resolviera al schema del
  // tenant, la sesión creada en 'public' nunca aparecería del lado del
  // cliente (mismo bug que SupportTicket de arriba, "acceso remoto no
  // funciona" para tenants ya migrados a su propio schema).
  'RemoteSupportSession',
  // Fila única de config del sistema (API key/secret frente al Núcleo
  // Central de Facturación de ESC DataCore) -- no es dato de tenant, es
  // config a nivel de Pitbox completo. No estaba en esta lista; hoy no
  // causaba error porque nadie la consulta dentro de una request de
  // tenant (solo desde superadmin y desde el cron ncf-sync, ninguno de
  // los dos pasa por el middleware de tenant), pero si algún día se lee
  // desde un contexto de tenant sin darse cuenta, terminaría apuntando
  // al `ncf_config` vacío de ese schema en vez de la fila real de public.
  'NcfConfig',
  // Integración con Meta -- igual razón que NcfConfig: un webhook entrante
  // todavía no sabe a qué tenant pertenece (se resuelve por page_id/waba_id/
  // form_id), así que TenantMetaConfig tiene que ser consultable sin haber
  // fijado antes el schema de ningún tenant. Ver TenantMetaConfig.js.
  'MetaConfig',
  'TenantMetaConfig',
  // Sincronización con el Core Ensambladora -- mismo motivo que TenantMetaConfig:
  // un evento entrante en /api/webhooks/ensambladora/sync/inbound todavía no
  // sabe a qué tenant pertenece, se resuelve por X-Api-Key ANTES de poder fijar
  // el search_path del tenant. Ver ensambladora/EnsambladoraSyncCredential.js.
  'EnsambladoraSyncCredential',
  'EnsambladoraEventoSync',
]);

function registerTenantSchemaHooks(sequelize) {
  for (const modelName in sequelize.models) {
    if (PUBLIC_SCHEMA_MODELS.has(modelName)) continue; // se quedan en public siempre

    const model = sequelize.models[modelName];
    Object.defineProperty(model, '_schema', {
      configurable: true,
      get() {
        // `this` es el receptor real de la lectura (el modelo base O un
        // clon creado por `.schema(x)`) -- así el fijo gana sobre el
        // dinámico solo en el clon que lo pidió explícitamente.
        if (Object.prototype.hasOwnProperty.call(this, '_fixedSchema')) {
          return this._fixedSchema;
        }
        return getCurrentSchema();
      },
      set(value) {
        Object.defineProperty(this, '_fixedSchema', { value, writable: true, configurable: true });
      },
    });
  }
}

module.exports = { registerTenantSchemaHooks, PUBLIC_SCHEMA_MODELS };
