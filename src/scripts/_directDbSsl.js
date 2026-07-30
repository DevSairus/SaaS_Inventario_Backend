// Los scripts de schema-per-tenant (cutover/provision/migrate/rollback/cleanup)
// se conectan siempre vía DATABASE_URL_DIRECT (bypass del pooler de Neon).
// Esa URL en producción es Neon y requiere SSL; en desarrollo local normalmente
// es un Postgres sin SSL configurado, así que forzar ssl:true rompía la conexión
// contra una base local. Se decide por host en vez de por NODE_ENV para que
// siga funcionando tal cual si alguna vez DATABASE_URL_DIRECT local es un Neon
// branch de dev (que sí necesita SSL).
function directDbDialectOptions(databaseUrl) {
  const host = new URL(databaseUrl).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  return isLocal ? {} : { ssl: { require: true, rejectUnauthorized: false } };
}

module.exports = { directDbDialectOptions };
