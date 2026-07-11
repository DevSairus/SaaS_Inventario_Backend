// backend/src/services/finance/recurringExpense.service.js
//
// Fase 3 del Asistente de IA — memoria de patrones de gasto recurrente.
//
// No hay tabla nueva de "plantillas": reutilizamos el propio histórico de
// `Expense`. Si el usuario marcó `is_recurring: true` alguna vez (ej. el
// arriendo), el gasto recurrente más reciente de esa categoría/descripción
// sirve como plantilla para la próxima vez que pida registrar "lo mismo".
// Así, si el valor cambia (sube el arriendo), el próximo gasto recurrente
// que se registre ya pasa a ser la nueva referencia — no hay que mantener
// una plantilla aparte sincronizada a mano.

const { Op } = require('sequelize');
const { Expense, Supplier } = require('../../models');

/**
 * Busca el gasto recurrente más reciente que coincida con una categoría
 * y/o una palabra clave en la descripción.
 *
 * @param {string} tenantId
 * @param {{ category?: string, keyword?: string }} params
 * @returns {Promise<Object|null>} plantilla lista para reusar, o null si no hay coincidencia
 */
async function findRecurringExpensePattern(tenantId, { category, keyword } = {}) {
  if (!category && !keyword) {
    throw new Error('Debes indicar category o keyword para buscar un patrón');
  }

  const where = {
    tenant_id: tenantId,
    is_recurring: true,
  };
  if (category) where.category = category;
  if (keyword) where.description = { [Op.iLike]: `%${keyword}%` };

  const match = await Expense.findOne({
    where,
    order: [['expense_date', 'DESC']],
    include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name'] }],
  });

  if (!match) return null;

  return {
    description: match.description,
    category: match.category,
    total_amount: Number(match.total_amount),
    payment_method: match.payment_method,
    supplier_id: match.supplier_id,
    supplier_name: match.supplier?.name || null,
    branch_id: match.branch_id,
    last_expense_date: match.expense_date,
    last_expense_number: match.expense_number,
  };
}

module.exports = { findRecurringExpensePattern };
