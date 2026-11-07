// backend/src/middleware/keepTenantContext.js
//
// multer (busboy) termina de leer el archivo en callbacks de streams que no
// siempre heredan el AsyncLocalStorage de tenantMiddleware: lo que corre
// después puede quedar SIN schema del tenant y consultar `public` (un
// documento que sí existe aparece como "no encontrado"). Esto envuelve un
// middleware y vuelve a entrar al schema del request antes de seguir.
const { getCurrentSchema, runWithTenantSchema } = require('../config/tenantContext');

const keepTenantContext = (middleware) => (req, res, next) => {
  const schema = getCurrentSchema();
  middleware(req, res, (err) => {
    if (!schema) return next(err);
    return runWithTenantSchema(schema, () => next(err));
  });
};

module.exports = { keepTenantContext };
