// backend/src/utils/remisionVisibility.js
//
// Configuración del tenant `features.hide_remisiones_for_non_admin`: cuando
// está activa, las ventas con document_type='remision' no se listan ni se
// suman para usuarios que no son admin -- historial de ventas, dashboard,
// informes de ventas, cartera e historial del cliente. Es SOLO visibilidad:
// las remisiones siguen existiendo y siguen contando en inventario,
// contabilidad y caja. El detalle por id (GET /sales/:id) no se bloquea, para
// que quien la acaba de crear pueda imprimirla.

const { Op } = require('sequelize');

const FEATURE_KEY = 'hide_remisiones_for_non_admin';
const ROLES_THAT_SEE_ALL = ['admin', 'super_admin'];

function isRemisionHidingEnabled(tenant) {
  return tenant?.features?.[FEATURE_KEY] === true;
}

// ¿Hay que ocultarle las remisiones a este request?
function shouldHideRemisiones(req) {
  if (!req?.user || ROLES_THAT_SEE_ALL.includes(req.user.role)) return false;
  return isRemisionHidingEnabled(req.tenant);
}

// Fragmento para un `where` de Sequelize sobre Sale. document_type puede ser
// NULL (borradores), por eso no alcanza con Op.ne.
function remisionExclusionWhere() {
  return { [Op.or]: [{ document_type: null }, { document_type: { [Op.ne]: 'remision' } }] };
}

// Agrega la exclusión a un `where` existente sin pisar otros Op.and / Op.or.
function applyRemisionFilter(req, where) {
  if (!shouldHideRemisiones(req)) return where;
  const exclusion = remisionExclusionWhere();
  where[Op.and] = [...(where[Op.and] || []), exclusion];
  return where;
}

// Condición para SQL crudo: `AND ${remisionSqlCondition(req, 's')}`.
// Devuelve 'TRUE' si no aplica, para poder concatenarla siempre.
function remisionSqlCondition(req, alias = 's') {
  if (!shouldHideRemisiones(req)) return 'TRUE';
  const col = alias ? `${alias}.document_type` : 'document_type';
  return `${col} IS DISTINCT FROM 'remision'`;
}

module.exports = {
  FEATURE_KEY,
  isRemisionHidingEnabled,
  shouldHideRemisiones,
  remisionExclusionWhere,
  applyRemisionFilter,
  remisionSqlCondition,
};
