// backend/src/services/workshop/commissionPayroll.service.js
//
// Cruce automático de una liquidación de comisión de técnico (taller) hacia
// una novedad de nómina de categoría DIAN "Comisiones", cuando el tenant
// tiene el módulo de nómina habilitado. Calcado del mismo patrón ya usado
// para las recompensas del CRM -- ver
// services/crmRewardService.js#chargeRewardToPayroll -- porque es
// exactamente el mismo problema: "dinero variable generado en otro módulo
// que debe entrar a la nómina formal del empleado, si existe uno vinculado".
//
// No hay un enlace manual User↔Employee: se emparejan por email/documento
// (ver utils/crmRewardMatching.js). Si no hay empleado o no hay período de
// nómina abierto para la fecha, la liquidación NO se bloquea -- el técnico
// igual cobra por fuera (mismo criterio que CrmReward), y el estado queda
// registrado en CommissionSettlement.payroll_status/payroll_error para que
// el admin pueda corregirlo y reintentar.
const { Op } = require('sequelize');
const { findEmployeeForUser } = require('../../utils/crmRewardMatching');

const COMMISSION_PAYROLL_MODES = ['salarial', 'no_salarial', 'no_reportar'];

// Tratamiento de la comisión para ESTE empleado: su excepción si la tiene,
// si no el valor del tenant (PayrollSetting), si no 'salarial' (Art. 127
// CST: la comisión es salario salvo pacto expreso en contrario).
async function resolveCommissionPayrollMode(tenant_id, employee) {
  if (employee?.commission_payroll_mode && COMMISSION_PAYROLL_MODES.includes(employee.commission_payroll_mode)) {
    return employee.commission_payroll_mode;
  }
  const { PayrollSetting } = require('../../models');
  const settings = await PayrollSetting.findOne({ where: { tenant_id }, attributes: ['commission_payroll_mode'] });
  return settings?.commission_payroll_mode || 'salarial';
}

async function tenantHasPayroll(tenant_id) {
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  const modules = await getEffectiveModulesForTenantId(tenant_id);
  return modules.includes('payroll');
}

// Período de nómina que cubre la fecha de la liquidación y todavía admite
// novedades ('emitido'/'cerrado' ya no: la novedad no entraría en ninguna
// liquidación de nómina).
async function findOpenPayrollPeriod(tenant_id, dateStr) {
  const { PayrollPeriod } = require('../../models');
  return PayrollPeriod.findOne({
    where: {
      tenant_id,
      status: { [Op.in]: ['abierto', 'liquidado'] },
      start_date: { [Op.lte]: dateStr },
      end_date: { [Op.gte]: dateStr },
    },
    order: [['start_date', 'DESC']],
  });
}

/**
 * Lleva una CommissionSettlement ya creada hasta nómina. Idempotente: si ya
 * tiene payroll_novedad_id, no hace nada. Devuelve el payroll_status final.
 *
 * @param {CommissionSettlement} settlement
 * @param {User} technician - el técnico de la liquidación (id, email, cedula)
 */
async function chargeCommissionToPayroll(settlement, technician) {
  const { PayrollNovedad, Employee } = require('../../models');

  if (settlement.payroll_novedad_id) return settlement.payroll_status;

  if (!(await tenantHasPayroll(settlement.tenant_id))) {
    await settlement.update({ payroll_status: 'not_applicable', payroll_error: null });
    return settlement.payroll_status;
  }

  let emp = settlement.employee_id ? await Employee.findByPk(settlement.employee_id) : null;
  if (!emp) emp = await findEmployeeForUser(settlement.tenant_id, technician);

  if (!emp) {
    await settlement.update({
      payroll_status: 'sin_empleado_vinculado',
      payroll_error: 'No se encontró un empleado de nómina con el mismo email o documento que el técnico',
    });
    return settlement.payroll_status;
  }

  const mode = await resolveCommissionPayrollMode(settlement.tenant_id, emp);
  if (mode === 'no_reportar') {
    // Ni novedad ni reintento: el llamador registra la comisión como gasto
    // operativo (comisiones_tecnicos) porque el estado no es 'cargada_nomina'.
    await settlement.update({ employee_id: emp.id, payroll_status: 'no_reporta_nomina', payroll_error: null });
    return settlement.payroll_status;
  }

  const dateStr = settlement.date_to || new Date().toISOString().slice(0, 10);
  const period = await findOpenPayrollPeriod(settlement.tenant_id, dateStr);
  if (!period) {
    await settlement.update({
      employee_id: emp.id,
      payroll_status: 'pendiente_periodo',
      payroll_error: 'No hay un período de nómina abierto que cubra la fecha de la liquidación',
    });
    return settlement.payroll_status;
  }

  const amount = parseFloat(settlement.commission_amount || 0);
  const novedad = await PayrollNovedad.create({
    tenant_id: settlement.tenant_id,
    employee_id: emp.id,
    payroll_period_id: period.id,
    // Salarial: 'Comisiones' es kind 'simpleList' en DIAN_CATEGORY_MAP
    // (services/payroll/payrollService.js): el payload se empuja tal cual
    // dentro del arreglo <Comisiones><Comision>...</Comision></Comisiones>
    // del XML -- por eso va como número plano. El Anexo no tiene variante
    // no salarial de <Comision>, así que la comisión no salarial se reporta
    // como <Bonificacion BonificacionNS> (kind 'array', payload objeto),
    // igual que las recompensas no salariales del CRM.
    dian_category: mode === 'no_salarial' ? 'Bonificaciones' : 'Comisiones',
    payload: mode === 'no_salarial' ? { bonificacionNS: amount } : amount,
    notes: `Comisión de mano de obra${mode === 'no_salarial' ? ' (no salarial)' : ''} — ${settlement.settlement_number}`,
    created_by: settlement.created_by,
  });

  await settlement.update({
    employee_id: emp.id,
    payroll_novedad_id: novedad.id,
    payroll_status: 'cargada_nomina',
    payroll_error: null,
  });

  return settlement.payroll_status;
}

module.exports = { COMMISSION_PAYROLL_MODES, resolveCommissionPayrollMode, tenantHasPayroll, findOpenPayrollPeriod, chargeCommissionToPayroll };
