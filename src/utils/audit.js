const AuditLog = require('../models/AuditLog');

/**
 * Registra una acción en el audit log.
 * Falla silenciosamente para no interrumpir la operación principal.
 */
async function audit({ tenant_id, user_id, action, entity, entity_id, changes, req }) {
  try {
    await AuditLog.create({
      tenant_id:  tenant_id  || null,
      user_id:    user_id    || null,
      action,
      entity:     entity     || null,
      entity_id:  entity_id  ? String(entity_id) : null,
      changes:    changes    || null,
      ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      user_agent: req?.headers?.['user-agent']?.slice(0, 500) || null,
    });
  } catch (err) {
    // No bloquear la operación si falla el audit
    console.error('[AuditLog] Error registrando:', err.message);
  }
}

module.exports = audit;