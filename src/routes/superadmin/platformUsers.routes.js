// routes/superadmin/platformUsers.routes.js
//
// Administración de los usuarios de plataforma (super_admin / support, sin
// tenant) -- solo el owner. Ver middleware/platformScope.js para lo que
// significa cada campo:
//   is_owner            -> super_admin que administra esta pantalla.
//   all_tenants_access  -> false = solo ve las empresas de tenant_ids.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { authMiddleware } = require('../../middleware/auth');
const { denyImpersonation } = require('../../middleware/denyImpersonation');
const { loadPlatformScope, requireOwner, getAllowedTenantIds } = require('../../middleware/platformScope');
const User = require('../../models/User');
const Tenant = require('../../models/Tenant');
const audit = require('../../utils/audit');

router.use(authMiddleware, denyImpersonation, loadPlatformScope, requireOwner);

const PLATFORM_ROLES = ['super_admin', 'support'];
const ATTRS = ['id', 'email', 'first_name', 'last_name', 'role', 'is_owner', 'all_tenants_access', 'is_active', 'last_login', 'created_at'];

const platformUserWhere = (extra = {}) => ({ tenant_id: null, role: { [Op.in]: PLATFORM_ROLES }, ...extra });

async function serialize(user) {
  const data = user.toJSON();
  delete data.password_hash;
  data.tenant_ids = data.all_tenants_access ? [] : await getAllowedTenantIds(user.id);
  return data;
}

// Reemplaza las empresas asignadas. Valida que existan.
async function setTenantIds(userId, tenantIds, actorId, transaction) {
  const ids = [...new Set((tenantIds || []).map(String))];
  if (ids.length) {
    const found = await Tenant.count({ where: { id: { [Op.in]: ids } }, transaction });
    if (found !== ids.length) {
      const err = new Error('Alguna de las empresas seleccionadas no existe');
      err.status = 400;
      throw err;
    }
  }
  await sequelize.query('DELETE FROM public.platform_user_tenants WHERE user_id = :userId', {
    replacements: { userId }, transaction,
  });
  for (const tenantId of ids) {
    await sequelize.query(
      'INSERT INTO public.platform_user_tenants (user_id, tenant_id, created_by) VALUES (:userId, :tenantId, :actorId)',
      { replacements: { userId, tenantId, actorId }, transaction }
    );
  }
}

// Normaliza el body: el owner siempre ve todo; support nunca es owner.
function normalizeAccess(body, current = {}) {
  const role = body.role ?? current.role;
  if (!PLATFORM_ROLES.includes(role)) {
    const err = new Error(`Rol inválido. Valores permitidos: ${PLATFORM_ROLES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const isOwner = role === 'super_admin' && Boolean(body.is_owner ?? current.is_owner);
  const allTenants = isOwner ? true : Boolean(body.all_tenants_access ?? current.all_tenants_access ?? true);
  return { role, is_owner: isOwner, all_tenants_access: allTenants };
}

async function countOtherActiveOwners(userId) {
  return User.count({ where: platformUserWhere({ is_owner: true, is_active: true, id: { [Op.ne]: userId } }) });
}

const fail = (res, error, fallback) => {
  if (error.status) return res.status(error.status).json({ success: false, error: error.message });
  if (error.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({ success: false, error: 'Ese email ya está registrado' });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, error: fallback });
};

// GET / -- usuarios de plataforma con sus empresas asignadas
router.get('/', async (req, res) => {
  try {
    const users = await User.findAll({
      where: platformUserWhere(),
      attributes: ATTRS,
      order: [['is_owner', 'DESC'], ['first_name', 'ASC']],
    });
    res.json({ success: true, users: await Promise.all(users.map(serialize)) });
  } catch (error) {
    fail(res, error, 'Error al listar usuarios de plataforma');
  }
});

// GET /tenant-options -- lista liviana para el selector de empresas
router.get('/tenant-options', async (req, res) => {
  try {
    const tenants = await Tenant.findAll({
      attributes: ['id', 'company_name', 'business_name', 'is_active'],
      order: [['company_name', 'ASC']],
    });
    res.json({ success: true, tenants });
  } catch (error) {
    fail(res, error, 'Error al listar empresas');
  }
});

// POST / -- { email, password, first_name, last_name, role, is_owner, all_tenants_access, tenant_ids }
router.post('/', async (req, res) => {
  const { email, password, first_name, last_name, tenant_ids } = req.body;
  if (!email || !password || !first_name || !last_name) {
    return res.status(400).json({ success: false, error: 'Email, contraseña, nombre y apellido son obligatorios' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  try {
    const access = normalizeAccess({ role: 'super_admin', ...req.body });
    const user = await sequelize.transaction(async (transaction) => {
      const created = await User.create({
        email,
        password_hash: await bcrypt.hash(password, 10),
        first_name,
        last_name,
        ...access,
        tenant_id: null,
        is_active: true,
      }, { transaction });
      if (!access.all_tenants_access) await setTenantIds(created.id, tenant_ids, req.user.id, transaction);
      return created;
    });
    audit({ user_id: req.user.id, action: 'PLATFORM_USER_CREATE', entity: 'user', entity_id: user.id, changes: { email: user.email, ...access, tenant_ids: access.all_tenants_access ? [] : tenant_ids }, req });
    res.status(201).json({ success: true, user: await serialize(await User.findByPk(user.id, { attributes: ATTRS })) });
  } catch (error) {
    fail(res, error, 'Error al crear usuario de plataforma');
  }
});

// PUT /:id -- datos, rol, acceso y empresas
router.put('/:id', async (req, res) => {
  try {
    const user = await User.findOne({ where: platformUserWhere({ id: req.params.id }) });
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

    const access = normalizeAccess(req.body, user);
    if (user.is_owner && !access.is_owner) {
      if (user.id === req.user.id) {
        return res.status(400).json({ success: false, error: 'No puedes quitarte el rol owner a ti mismo' });
      }
      if (!(await countOtherActiveOwners(user.id))) {
        return res.status(400).json({ success: false, error: 'Debe quedar al menos un owner activo' });
      }
    }

    const { first_name, last_name, email, tenant_ids } = req.body;
    await sequelize.transaction(async (transaction) => {
      await user.update({
        ...(first_name !== undefined && { first_name }),
        ...(last_name !== undefined && { last_name }),
        ...(email !== undefined && { email }),
        ...access,
      }, { transaction });
      if (access.all_tenants_access) await setTenantIds(user.id, [], req.user.id, transaction);
      else if (tenant_ids !== undefined) await setTenantIds(user.id, tenant_ids, req.user.id, transaction);
    });
    audit({ user_id: req.user.id, action: 'PLATFORM_USER_UPDATE', entity: 'user', entity_id: user.id, changes: { ...access, tenant_ids }, req });
    res.json({ success: true, user: await serialize(await User.findByPk(user.id, { attributes: ATTRS })) });
  } catch (error) {
    fail(res, error, 'Error al actualizar usuario de plataforma');
  }
});

// PATCH /:id/toggle-status
router.patch('/:id/toggle-status', async (req, res) => {
  try {
    const user = await User.findOne({ where: platformUserWhere({ id: req.params.id }) });
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    if (user.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'No puedes desactivar tu propio usuario' });
    }
    if (user.is_active && user.is_owner && !(await countOtherActiveOwners(user.id))) {
      return res.status(400).json({ success: false, error: 'Debe quedar al menos un owner activo' });
    }
    await user.update({ is_active: !user.is_active });
    audit({ user_id: req.user.id, action: 'PLATFORM_USER_TOGGLE', entity: 'user', entity_id: user.id, changes: { is_active: user.is_active }, req });
    res.json({ success: true, user: await serialize(await User.findByPk(user.id, { attributes: ATTRS })) });
  } catch (error) {
    fail(res, error, 'Error al cambiar el estado del usuario');
  }
});

// PUT /:id/password -- { password }
router.put('/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const user = await User.findOne({ where: platformUserWhere({ id: req.params.id }) });
    if (!user) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    await user.update({ password_hash: await bcrypt.hash(password, 10) });
    audit({ user_id: req.user.id, action: 'PLATFORM_USER_PASSWORD', entity: 'user', entity_id: user.id, req });
    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (error) {
    fail(res, error, 'Error al cambiar la contraseña');
  }
});

module.exports = router;
