/**
 * Agregar tenant_id al scope de búsqueda
 */
const addTenantScope = (where, req) => {
  if (req.tenant_id) {
    where.tenant_id = req.tenant_id;
  }
  return where;
};

/**
 * Agregar tenant_id a los datos a crear/actualizar
 */
const addTenantData = (data, req) => {
  if (req.tenant_id) {
    data.tenant_id = req.tenant_id;
  }
  return data;
};

/**
 * Validar que un registro pertenece al tenant actual
 */
const validateTenantOwnership = (record, req) => {
  if (!record) {
    return false;
  }
  if (!req.tenant_id) {
    return false;
  }
  return record.tenant_id === req.tenant_id;
};

/**
 * Middleware para validar tenant en parámetros
 */
const validateTenantParam = (req, res, next) => {
  const { tenant_id } = req.params;

  if (tenant_id && tenant_id !== req.tenant_id) {
    return res.status(403).json({
      success: false,
      message: 'No tienes acceso a este tenant',
    });
  }

  next();
};

module.exports = {
  addTenantScope,
  addTenantData,
  validateTenantOwnership,
  validateTenantParam,
};
