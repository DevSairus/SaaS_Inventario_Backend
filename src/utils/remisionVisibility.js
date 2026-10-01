// backend/src/utils/remisionVisibility.js
//
// Configuración del tenant `features.hide_remisiones_for_non_admin` (el nombre
// de la clave es histórico: hoy oculta también al admin). Cuando está activa,
// las ventas con document_type='remision' no se listan ni se suman para
// NINGÚN usuario del tenant -- solo las ve el superadmin (en su sesión de
// impersonación) -- historial de ventas, dashboard,
// informes de ventas, cartera e historial del cliente. Es SOLO visibilidad:
// las remisiones siguen existiendo y siguen contando en inventario,
// contabilidad y caja. El detalle por id (GET /sales/:id) no se bloquea, para
// que quien la acaba de crear pueda imprimirla.
//
// OT cerradas con remisión: work_orders.sale_id apunta a la venta generada
// al cerrar la OT. Los ingresos/costos del taller se agregan desde
// work_order_items (no desde sales), así que sin esto el taller seguía
// sumando lo que ventas/dashboard ya ocultaban -- ingresos descuadrados entre
// informes. Las OT en sí (listado, detalle) siguen visibles: son operación.

const { Op, literal } = require('sequelize');
const { getCurrentSchema } = require('../config/tenantContext');

const FEATURE_KEY = 'hide_remisiones_for_non_admin';

function isRemisionHidingEnabled(tenant) {
  return tenant?.features?.[FEATURE_KEY] === true;
}

// Solo el superadmin ve todo: directo (sin tenant) o impersonando a un
// usuario del tenant (token con impersonated_by).
function canSeeAllRemisiones(user) {
  return user?.role === 'super_admin' || Boolean(user?.impersonated_by);
}

// ¿Hay que ocultarle las remisiones a este request?
function shouldHideRemisiones(req) {
  if (!req?.user || canSeeAllRemisiones(req.user)) return false;
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

// Condición SQL sobre work_orders: excluye las OT cuya venta generada es una
// remisión. `alias` es como se referencia la tabla en la query ("wo", o el
// alias entre comillas de Sequelize, ej. '"WorkOrder"'). 'TRUE' si no aplica.
function workOrderRemisionSqlCondition(req, alias = 'wo') {
  if (!shouldHideRemisiones(req)) return 'TRUE';
  const schema = getCurrentSchema() || 'public';
  return `NOT EXISTS (SELECT 1 FROM "${schema}"."sales" rs WHERE rs.id = ${alias}.sale_id AND rs.document_type = 'remision')`;
}

// Igual, para un `where` de Sequelize sobre WorkOrder (o un include de él).
function applyWorkOrderRemisionFilter(req, where, alias = 'WorkOrder') {
  if (!shouldHideRemisiones(req)) return where;
  where[Op.and] = [...(where[Op.and] || []), literal(workOrderRemisionSqlCondition(req, `"${alias}"`))];
  return where;
}

module.exports = {
  FEATURE_KEY,
  isRemisionHidingEnabled,
  canSeeAllRemisiones,
  shouldHideRemisiones,
  remisionExclusionWhere,
  applyRemisionFilter,
  remisionSqlCondition,
  workOrderRemisionSqlCondition,
  applyWorkOrderRemisionFilter,
};
