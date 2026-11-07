// backend/src/routes/rolePermissions.routes.js
//
// Roles y permisos de la empresa (Ajustes → Roles y permisos).
// Base: /api/role-permissions
//   GET  /me      permisos efectivos del usuario (para mostrar/ocultar acciones)
//   GET  /        matriz rol × permiso
//   PUT  /        { changes: [{ role, key, allowed }] }
//   POST /reset   { role? } vuelve a los permisos por defecto

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/requirePermission');
const service = require('../services/tenantPermissions.service');
const audit = require('../utils/audit');

const tenantOf = (req) => req.user.tenant_id || req.tenant_id;
const fail = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error('[rolePermissions]', error);
  return res.status(500).json({ success: false, message: fallback });
};

router.get('/me', async (req, res) => {
  try {
    res.json({ success: true, data: { role: req.user.role, permissions: await service.allowedKeys(tenantOf(req), req.user.role) } });
  } catch (error) {
    fail(res, error, 'Error al obtener tus permisos');
  }
});

router.get('/', requirePermission('permissions.manage'), async (req, res) => {
  try {
    res.json({ success: true, data: await service.getMatrix(tenantOf(req)) });
  } catch (error) {
    fail(res, error, 'Error al obtener los permisos');
  }
});

router.put('/', requirePermission('permissions.manage'), async (req, res) => {
  try {
    const changes = req.body?.changes || [];
    await service.setPermissions(tenantOf(req), changes, req.user.id);
    audit({ tenant_id: tenantOf(req), user_id: req.user.id, action: 'update', entity: 'role_permissions', changes, req });
    res.json({ success: true, message: `${changes.length} permiso(s) actualizado(s)`, data: await service.getMatrix(tenantOf(req)) });
  } catch (error) {
    fail(res, error, 'Error al guardar los permisos');
  }
});

router.post('/reset', requirePermission('permissions.manage'), async (req, res) => {
  try {
    await service.resetPermissions(tenantOf(req), req.body?.role || null);
    audit({ tenant_id: tenantOf(req), user_id: req.user.id, action: 'reset', entity: 'role_permissions', changes: { role: req.body?.role || 'todos' }, req });
    res.json({ success: true, message: 'Permisos restablecidos', data: await service.getMatrix(tenantOf(req)) });
  } catch (error) {
    fail(res, error, 'Error al restablecer los permisos');
  }
});

module.exports = router;
