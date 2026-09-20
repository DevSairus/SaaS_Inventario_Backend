// backend/src/services/workshop/commissionCategory.service.js
//
// Resuelve la categoría de comisión (Frenos, Suspensión, Motor, Otros...) de
// un ítem de mano de obra, y el % efectivo a aplicar (override por técnico >
// % de la categoría > fallback global) -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md secciones 2-4.

const {
  CommissionCategory,
  TechnicianCommissionRate,
  DiagramSystemCommissionMap,
  Category,
} = require('../../models');
const { DEFAULT_LABOR_COST_PCT } = require('./laborCost.service');

/**
 * Devuelve (creándola si hace falta) la categoría "Otros" del tenant, para
 * que un producto/sistema sin mapeo explícito nunca quede "sin comisión"
 * silencioso (ver sección 5, punto 4 del plan).
 */
async function getOrCreateDefaultCategory(tenant_id, transaction) {
  let category = await CommissionCategory.findOne({
    where: { tenant_id, is_default: true },
    transaction,
  });
  if (category) return category;

  category = await CommissionCategory.create({
    tenant_id,
    name: 'Otros',
    code: 'otros',
    default_percentage: DEFAULT_LABOR_COST_PCT,
    is_default: true,
    is_active: true,
  }, { transaction });
  return category;
}

/**
 * Resuelve la commission_category_id para un producto de catálogo, vía
 * product.category_id -> categories.commission_category_id. Si el producto
 * no tiene categoría o esta no está mapeada, cae a la categoría "Otros".
 */
async function resolveCategoryForProduct(tenant_id, product, transaction) {
  if (product?.category_id) {
    const category = await Category.findOne({
      where: { id: product.category_id, tenant_id },
      transaction,
    });
    if (category?.commission_category_id) return category.commission_category_id;
  }
  const fallback = await getOrCreateDefaultCategory(tenant_id, transaction);
  return fallback.id;
}

/**
 * Resuelve la commission_category_id para un `system` de diagram_templates
 * (ver generateItemsFromMarks). Cae a "Otros" si no hay mapeo configurado.
 */
async function resolveCategoryForDiagramSystem(tenant_id, system, transaction) {
  if (system) {
    const map = await DiagramSystemCommissionMap.findOne({
      where: { tenant_id, system },
      transaction,
    });
    if (map) return map.commission_category_id;
  }
  const fallback = await getOrCreateDefaultCategory(tenant_id, transaction);
  return fallback.id;
}

/**
 * % efectivo a aplicar para un técnico en una categoría dada: override del
 * técnico si existe, si no el % por defecto de la categoría.
 */
async function getEffectivePercentage(tenant_id, technician_id, commission_category_id, transaction) {
  if (technician_id && commission_category_id) {
    const rate = await TechnicianCommissionRate.findOne({
      where: { tenant_id, technician_id, commission_category_id },
      transaction,
    });
    if (rate) return parseFloat(rate.percentage);
  }
  if (commission_category_id) {
    const category = await CommissionCategory.findOne({
      where: { id: commission_category_id, tenant_id },
      transaction,
    });
    if (category) return parseFloat(category.default_percentage);
  }
  return DEFAULT_LABOR_COST_PCT;
}

module.exports = {
  getOrCreateDefaultCategory,
  resolveCategoryForProduct,
  resolveCategoryForDiagramSystem,
  getEffectivePercentage,
};
