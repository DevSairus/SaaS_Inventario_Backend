// backend/src/services/payroll/payrollConceptsSeed.service.js
const { PAYROLL_CONCEPTS_STANDARD } = require('../../data/payroll-concepts-standard');

/**
 * Crea el catálogo estándar de conceptos de nómina para un tenant.
 * Idempotente: si el tenant ya tiene conceptos, no hace nada — mismo
 * criterio que seedChartOfAccountsForTenant (accountingSeed.service.js).
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function seedPayrollConceptsForTenant(tenantId, transaction) {
  const { PayrollConcept } = require('../../models');

  const existingCount = await PayrollConcept.count({ where: { tenant_id: tenantId }, transaction });
  if (existingCount > 0) {
    return { created: false, reason: 'El tenant ya tiene conceptos de nómina' };
  }

  for (const concept of PAYROLL_CONCEPTS_STANDARD) {
    await PayrollConcept.create(
      {
        tenant_id: tenantId,
        code: concept.code,
        name: concept.name,
        concept_type: concept.concept_type,
        dian_category: concept.dian_category,
        calculation_type: 'manual',
        default_value: 0,
        is_active: true,
        auto_apply: false,
        sort_order: concept.sort_order,
      },
      { transaction }
    );
  }

  return { created: true, concepts: PAYROLL_CONCEPTS_STANDARD.length };
}

/**
 * Reconciliación idempotente para tenants existentes que activen el
 * módulo de nómina después de creados (o que quedaron sin seed por algún
 * fallo en el alta) — mismo rol que ensureAccountingSeeded para el PUC.
 *
 * @param {string} tenantId
 * @param {import('sequelize').Transaction} [transaction]
 */
async function ensurePayrollConceptsSeeded(tenantId, transaction) {
  const { PayrollConcept } = require('../../models');
  const existingCount = await PayrollConcept.count({ where: { tenant_id: tenantId }, transaction });
  if (existingCount > 0) {
    return { created: false, reason: 'El tenant ya tiene conceptos de nómina' };
  }
  return seedPayrollConceptsForTenant(tenantId, transaction);
}

module.exports = { seedPayrollConceptsForTenant, ensurePayrollConceptsSeeded };
