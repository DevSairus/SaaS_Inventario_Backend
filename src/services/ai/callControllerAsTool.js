// backend/src/services/ai/callControllerAsTool.js
//
// La mayoría de los controllers de Pitbox siguen el patrón
// `async (req, res) => { ... res.json({ success, data }) }`.
// En vez de duplicar esa lógica de negocio para el asistente de IA,
// este helper arma un `res` sintético que captura el JSON devuelto,
// para poder reusar los controllers TAL CUAL (misma validación,
// mismos permisos de datos, mismo tenant scoping) como "tools" del agente.
//
// IMPORTANTE: req.tenant_id / req.user / req.branch_id vienen SIEMPRE del
// request real y autenticado — el modelo de IA nunca los decide ni los ve
// como parámetro editable.

/**
 * Ejecuta un controller existente (req, res) => {} y devuelve su respuesta JSON.
 *
 * @param {Function} controllerFn - el controller original (ej. financialReportsCtrl.trialBalance)
 * @param {Object} baseReq - request real (para heredar user/tenant_id/tenant/branch_id)
 * @param {Object} extra - { query, params } que arma el tool a partir de los argumentos del modelo
 */
async function callControllerAsTool(controllerFn, baseReq, extra = {}) {
  let resolveFn, rejectFn;
  const resultPromise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const syntheticReq = {
    user: baseReq.user,
    tenant_id: baseReq.tenant_id,
    tenant: baseReq.tenant,
    branch_id: baseReq.branch_id,
    is_super_admin: baseReq.is_super_admin,
    query: extra.query || {},
    params: extra.params || {},
    body: extra.body || {},
  };

  const syntheticRes = {
    statusCode: 200,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    json(payload) {
      this.headersSent = true;
      if (this.statusCode >= 400) {
        const err = new Error(payload?.message || 'Error ejecutando la consulta');
        err.statusCode = this.statusCode;
        err.payload = payload;
        rejectFn(err);
      } else {
        resolveFn(payload);
      }
    },
    send(payload) {
      this.json(typeof payload === 'string' ? { success: true, data: payload } : payload);
    },
  };

  await controllerFn(syntheticReq, syntheticRes);
  return resultPromise;
}

module.exports = { callControllerAsTool };
