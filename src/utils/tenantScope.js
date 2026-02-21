/**
 * Agregar tenant_id automáticamente a las condiciones WHERE
 */
const addTenantScope = (where, req) => {
  // Super admin puede ver todo
  if (req.is_super_admin) {
    return where;
  }

  // Agregar tenant_id si no está presente
  if (req.tenant_id && !where.tenant_id) {
    return {
      ...where,
      tenant_id: req.tenant_id,
    };
  }

  return where;
};

/**
 * Agregar tenant_id a datos de creación
 */
const addTenantData = (data, req) => {
  // Super admin no agrega tenant_id automáticamente
  if (req.is_super_admin) {
    return data;
  }

  // Agregar tenant_id si no está presente
  if (req.tenant_id && !data.tenant_id) {
    return {
      ...data,
      tenant_id: req.tenant_id,
    };
  }

  return data;
};

/**
 * Validar que un recurso pertenece al tenant del usuario
 */
const validateTenantOwnership = (resource, req) => {
  // Super admin puede acceder a todo
  if (req.is_super_admin) {
    return true;
  }

  // Validar que el recurso pertenezca al tenant
  if (resource.tenant_id && resource.tenant_id !== req.tenant_id) {
    return false;
  }

  return true;
};

module.exports = {
  addTenantScope,
  addTenantData,
  validateTenantOwnership,
};
