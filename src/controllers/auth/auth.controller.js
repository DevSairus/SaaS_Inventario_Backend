const logger = require('../../config/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const audit = require('../../utils/audit');
const { isSessionRevoked, sessionRevokedResponse } = require('../../utils/sessionRevocation');

const { Op, fn, col, where: sqlWhere } = require('sequelize');

const User = require('../../models/auth/User');
const Tenant = require('../../models/auth/Tenant');
const identity = require('../../services/auth/identity.service');

const emailLookupWhere = (email) =>
  sqlWhere(fn('lower', col('email')), String(email).toLowerCase().trim());

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'; // Configurable via env, default 24h
const IMPERSONATION_EXPIRES_IN = process.env.IMPERSONATION_EXPIRES_IN || '2h';

const login = async (req, res) => {
  try {
    const { email, password, tenant_id } = req.body;

    /* =====================================================
       VALIDACIONES BÁSICAS
    ===================================================== */

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y password son requeridos'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 8 caracteres'
      });
    }

    /* =====================================================
       FILAS DE ESE CORREO
       Una persona puede tener una fila por empresa (misma identity_id y
       contraseña): ver services/auth/identity.service.js. Solo cuentan las
       filas activas, con acceso y cuya contraseña coincide -- un técnico sin
       acceso (has_system_access = false) no tiene hash y nunca entra.
    ===================================================== */

    const where = { [Op.and]: [identity.emailWhere(email)] };
    if (tenant_id) where.tenant_id = tenant_id;
    const rows = (await User.findAll({ where })).filter(identity.canLogIn);

    const hashOk = new Map();
    const matching = [];
    for (const row of rows) {
      if (!hashOk.has(row.password_hash)) {
        hashOk.set(row.password_hash, await bcrypt.compare(password, row.password_hash));
      }
      if (hashOk.get(row.password_hash)) matching.push(row);
    }

    if (!matching.length) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    // Usuario de plataforma (super_admin / soporte): sin empresa.
    const platformUser = matching.find((u) => !u.tenant_id);
    if (platformUser) return sendSession(res, req, platformUser, null, 1);

    /* =====================================================
       VALIDAR EMPRESAS
       Mismos mensajes de antes (suspendida, cancelada, prueba vencida) si
       ninguna de sus empresas deja entrar.
    ===================================================== */

    const tenants = await Tenant.findAll({ where: { id: matching.map((u) => u.tenant_id) } });
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const allowed = matching.filter((u) => !identity.tenantAccessError(byId.get(u.tenant_id)));

    if (!allowed.length) {
      const err = identity.tenantAccessError(byId.get(matching[0].tenant_id));
      return res.status(err.status).json({ success: false, message: err.message, ...(err.code ? { code: err.code } : {}) });
    }

    if (allowed.length === 1) {
      return sendSession(res, req, allowed[0], byId.get(allowed[0].tenant_id), 1);
    }

    /* =====================================================
       VARIAS EMPRESAS: elegir a cuál entrar
       Token de selección de 10 min con las filas permitidas; el frontend
       llama a POST /auth/select-tenant con la elegida.
    ===================================================== */

    const accounts = allowed
      .map((u) => ({ user: u, tenant: byId.get(u.tenant_id) }))
      .sort((a, b) => a.tenant.company_name.localeCompare(b.tenant.company_name, 'es'));

    return res.json({
      success: true,
      message: 'Elige la empresa',
      data: {
        requires_tenant_selection: true,
        selection_token: identity.signSelectionToken(allowed[0].identity_id || allowed[0].id, allowed.map((u) => u.id)),
        companies: accounts.map((a) => identity.accountSummary(a)),
      }
    });

  } catch (error) {
    logger.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    });
  }
};

// Emite el token de una fila ya validada y responde como el login de siempre.
async function sendSession(res, req, user, tenant, companiesCount) {
  await user.update({ last_login: new Date() });
  const token = identity.signSessionToken(user);
  // Audit: registrar login exitoso
  setImmediate(() => audit({ tenant_id: user.tenant_id, user_id: user.id, action: 'LOGIN', entity: 'user', entity_id: user.id, changes: { email: user.email }, req }));
  let count = companiesCount;
  if (user.tenant_id && count === 1) count = (await identity.switchableAccounts(user)).length || 1;
  return res.json({
    success: true,
    message: 'Login exitoso',
    data: { token, user: identity.sessionUser(user, tenant, count) }
  });
}

/* =====================================================
   ELEGIR EMPRESA (después del login)
   Body: { selection_token, user_id }
===================================================== */

const selectTenant = async (req, res) => {
  try {
    const { selection_token, user_id } = req.body || {};
    const sel = identity.verifySelectionToken(selection_token);
    if (!sel || !sel.user_ids.includes(user_id)) {
      return res.status(401).json({ success: false, message: 'La selección venció. Inicia sesión de nuevo.', code: 'SELECTION_EXPIRED' });
    }
    const user = await User.findByPk(user_id);
    if (!identity.canLogIn(user) || (user.identity_id || user.id) !== sel.identity_id) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
    }
    const tenant = await Tenant.findByPk(user.tenant_id);
    const err = identity.tenantAccessError(tenant);
    if (err) return res.status(err.status).json({ success: false, message: err.message, ...(err.code ? { code: err.code } : {}) });
    return sendSession(res, req, user, tenant, sel.user_ids.length);
  } catch (error) {
    logger.error('Error en selectTenant:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

/* =====================================================
   MIS EMPRESAS / CAMBIAR DE EMPRESA (sin cerrar sesión)
===================================================== */

const myCompanies = async (req, res) => {
  try {
    if (req.user.impersonated_by) return res.json({ success: true, data: [] });
    const user = await User.findByPk(req.user.id);
    if (!user || !user.tenant_id) return res.json({ success: true, data: [] });
    const accounts = await identity.switchableAccounts(user);
    res.json({ success: true, data: accounts.map((a) => identity.accountSummary(a, user.id)) });
  } catch (error) {
    logger.error('Error en myCompanies:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

// Body: { tenant_id }
const switchTenant = async (req, res) => {
  try {
    if (req.user.impersonated_by) {
      return res.status(403).json({ success: false, message: 'No se puede cambiar de empresa en modo soporte' });
    }
    const current = await User.findByPk(req.user.id);
    if (!identity.canLogIn(current) || !current.tenant_id) {
      return res.status(401).json({ success: false, message: 'Usuario no válido' });
    }
    const { tenant_id: targetTenantId } = req.body || {};
    const accounts = await identity.switchableAccounts(current);
    const target = accounts.find((a) => a.tenant.id === targetTenantId);
    if (!target) {
      return res.status(403).json({ success: false, message: 'No tienes acceso a esa empresa' });
    }
    setImmediate(() => audit({
      tenant_id: target.user.tenant_id, user_id: target.user.id, action: 'SWITCH_TENANT', entity: 'user', entity_id: target.user.id,
      changes: { from_tenant_id: current.tenant_id, from_user_id: current.id }, req,
    }));
    return sendSession(res, req, target.user, target.tenant, accounts.length);
  } catch (error) {
    logger.error('Error en switchTenant:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

/* =====================================================
   PERFIL
===================================================== */

const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password_hash'] }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    logger.error('Error en getProfile:', error);
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    });
  }
};

/* =====================================================
   VERIFY TOKEN
===================================================== */

const verifyToken = (req, res) => {
  res.json({
    success: true,
    message: 'Token válido',
    data: {
      user: req.user
    }
  });
};

/* =====================================================
   REFRESH TOKEN
   Re-emite un token nuevo con los datos actuales del usuario
   El frontend lo llama cada 10 min para mantener la sesión
===================================================== */

const refreshToken = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'email', 'role', 'tenant_id', 'is_active'],
    });

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'Usuario no válido' });
    }

    // Un token anterior a un cierre forzado de sesiones no se puede renovar
    // (utils/sessionRevocation.js) -- si no, el refresh lo esquivaría.
    if (user.tenant_id) {
      const tenant = await Tenant.findByPk(user.tenant_id, { attributes: ['id', 'features'] });
      if (isSessionRevoked(tenant, req.user)) return sessionRevokedResponse(res);
    }

    const payload = { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id };

    // Si esta sesión es una impersonación de soporte, el claim debe sobrevivir
    // al refresh — si no, se perdería a los 10 min (ver SessionKeepAlive.jsx)
    // y la sesión dejaría de estar marcada/bloqueada de rutas de superadmin.
    const isImpersonating = Boolean(req.user.impersonated_by);
    if (isImpersonating) {
      payload.impersonated_by = req.user.impersonated_by;
    }

    const token = jwt.sign(
      payload,
      JWT_SECRET,
      { expiresIn: isImpersonating ? IMPERSONATION_EXPIRES_IN : JWT_EXPIRES_IN }
    );

    res.json({ success: true, data: { token } });
  } catch (error) {
    logger.error('Error en refreshToken:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

/* =====================================================
   FIN DE IMPERSONACIÓN
   Cierra una sesión de soporte iniciada desde superadmin — vive en /api/auth
   (no en /api/superadmin) para que una sesión impersonada, bloqueada de las
   rutas de superadmin, sí pueda terminarse a sí misma.
===================================================== */

const endImpersonation = async (req, res) => {
  if (!req.user.impersonated_by) {
    return res.status(400).json({ success: false, message: 'No estás en una sesión de soporte' });
  }

  setImmediate(() => audit({
    tenant_id: req.user.tenant_id,
    user_id: req.user.impersonated_by,
    action: 'IMPERSONATE_END',
    entity: 'user',
    entity_id: req.user.id,
    changes: { impersonated_email: req.user.email },
    req,
  }));

  res.json({ success: true, message: 'Sesión de soporte finalizada' });
};

module.exports = {
  selectTenant,
  myCompanies,
  switchTenant,
  login,
  getProfile,
  verifyToken,
  refreshToken,
  endImpersonation,
};