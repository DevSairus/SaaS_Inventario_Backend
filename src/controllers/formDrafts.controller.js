// backend/src/controllers/formDrafts.controller.js
//
// Copia en el servidor de los borradores de formularios (venta, cotización,
// ingreso de OT) para continuarlos desde otro equipo -- ver
// frontend/src/hooks/useFormDraft.js y la migración
// 2026100602-create-form-drafts.js. Cada usuario solo ve los suyos.
//
//   GET    /api/form-drafts?scope=sale:new
//   PUT    /api/form-drafts        { scope, data, meta, saved_at, device_id, base_saved_at, force }
//   DELETE /api/form-drafts?scope=sale:new
//
// Conflictos: el PUT se rechaza con 409 (devolviendo la versión del
// servidor) si la del servidor es más reciente, o si la guardó OTRO equipo
// y este no la conocía (base_saved_at distinto) -- el mismo usuario
// trabajando el mismo borrador en dos equipos. `force` la sobrescribe.
const { Op } = require('sequelize');
const { FormDraft } = require('../models');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const SCOPE_RE = /^[a-z]+(:[A-Za-z0-9_-]+){1,3}$/;

const fail = (res, status, message) => res.status(status).json({ success: false, message });

const toDto = (d) => (d ? {
  scope: d.scope,
  data: d.data,
  meta: d.meta,
  saved_at: new Date(d.saved_at).getTime(),
  device_id: d.device_id,
} : null);

const owner = (req) => ({ tenant_id: req.user.tenant_id, user_id: req.user.id });

const validScope = (scope) => typeof scope === 'string' && scope.length <= 150 && SCOPE_RE.test(scope);

const getDraft = async (req, res) => {
  try {
    const { scope } = req.query;
    if (!validScope(scope)) return fail(res, 400, 'scope inválido');
    const draft = await FormDraft.findOne({ where: { ...owner(req), scope } });
    if (draft && Date.now() - new Date(draft.saved_at).getTime() > MAX_AGE_MS) {
      await draft.destroy();
      return res.json({ success: true, data: null });
    }
    res.json({ success: true, data: toDto(draft) });
  } catch (error) {
    console.error('Error en getDraft:', error);
    fail(res, 500, 'Error obteniendo el borrador');
  }
};

const saveDraft = async (req, res) => {
  try {
    const { scope, data, meta = null, saved_at, device_id = null, base_saved_at = null, force = false } = req.body || {};
    if (!validScope(scope)) return fail(res, 400, 'scope inválido');
    if (!data || typeof data !== 'object') return fail(res, 400, 'data requerido');
    const savedAt = Number(saved_at);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return fail(res, 400, 'saved_at inválido');
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) return fail(res, 413, 'El borrador es demasiado grande');

    const where = { ...owner(req), scope };
    const existing = await FormDraft.findOne({ where });
    if (existing && !force) {
      const existingAt = new Date(existing.saved_at).getTime();
      const fromOtherDevice = existing.device_id && existing.device_id !== device_id;
      if (existingAt > savedAt || (fromOtherDevice && Number(base_saved_at) !== existingAt)) {
        return res.status(409).json({ success: false, code: 'DRAFT_CONFLICT', message: 'Hay una versión más reciente de este borrador', data: toDto(existing) });
      }
    }

    const values = { data, meta, saved_at: new Date(savedAt), device_id: device_id ? String(device_id).slice(0, 64) : null };
    const draft = existing ? await existing.update(values) : await FormDraft.create({ ...where, ...values });

    // Limpieza oportunista de los vencidos del mismo usuario.
    await FormDraft.destroy({ where: { ...owner(req), saved_at: { [Op.lt]: new Date(Date.now() - MAX_AGE_MS) } } });

    res.json({ success: true, data: { saved_at: new Date(draft.saved_at).getTime() } });
  } catch (error) {
    console.error('Error en saveDraft:', error);
    fail(res, 500, 'Error guardando el borrador');
  }
};

const deleteDraft = async (req, res) => {
  try {
    const { scope } = req.query;
    if (!validScope(scope)) return fail(res, 400, 'scope inválido');
    await FormDraft.destroy({ where: { ...owner(req), scope } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error en deleteDraft:', error);
    fail(res, 500, 'Error eliminando el borrador');
  }
};

module.exports = { getDraft, saveDraft, deleteDraft };
