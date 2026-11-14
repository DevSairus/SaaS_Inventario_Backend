// backend/src/services/payroll/payrollWorkflow.service.js
//
// 6.1 — Flujograma de nómina: etapas del período con validaciones previas,
// responsables y bitácora.
//
// Etapas, en orden:
//   novedades → empleados → seguridad_social → liquidacion → emision → cierre
// Las tres primeras son de PREPARACIÓN (solo validan); las otras tres son las
// transiciones reales del período (abierto → liquidado → emitido → cerrado).
//
// Cada validación tiene un nivel:
//   error   — bloquea avanzar (algo que la DIAN rechazaría o que daría un resultado
//             sin sentido: empleado sin documento o sin salario).
//   warning — se muestra y queda en la bitácora, pero no bloquea (datos que el
//             contador puede aceptar: un empleado sin EPS, un aporte sin fondo).
// El responsable de una etapa es quien hizo la transición (bitácora); las etapas
// de preparación no tienen responsable: son validaciones automáticas.
'use strict';

const { Op } = require('sequelize');

const models = () => require('../../models');

const STAGES = [
  { key: 'novedades', label: 'Novedades', prep: true },
  { key: 'empleados', label: 'Empleados', prep: true },
  { key: 'seguridad_social', label: 'Seguridad social y aportes', prep: true },
  { key: 'liquidacion', label: 'Liquidación', status: 'liquidado' },
  { key: 'emision', label: 'Emisión DIAN y contabilización', status: 'emitido' },
  { key: 'cierre', label: 'Cierre', status: 'cerrado' },
];
const STATUS_ORDER = ['abierto', 'liquidado', 'emitido', 'cerrado'];

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const nameOf = (e) => [e.first_name, e.first_surname].filter(Boolean).join(' ') || e.document_number || e.id;

const check = (key, level, message, items = []) => ({ key, level, message, items });

/**
 * Validaciones puras. Recibe todo ya cargado.
 * @returns {{ novedades: Array, empleados: Array, seguridad_social: Array, emision: Array }}
 */
function evaluateChecks({ period, employees = [], novedades = [], settings = {}, mappedKeys = null, unattachedVacations = [], pendingTerminations = [] }) {
  const inPeriod = new Set(employees.map((e) => e.id));
  const out = { novedades: [], empleados: [], seguridad_social: [], emision: [] };

  // ── Novedades ──
  const orphan = novedades.filter((n) => !inPeriod.has(n.employee_id));
  if (orphan.length) {
    out.novedades.push(check('novedades_sin_empleado', 'warning',
      `${orphan.length} novedad(es) son de empleados que no entran a este período (retirados, otra periodicidad o sede) y no se pagarán aquí.`,
      [...new Set(orphan.map((n) => n.employee_id))]));
  }
  if (unattachedVacations.length) {
    out.novedades.push(check('vacaciones_sin_agregar', 'warning',
      `${unattachedVacations.length} liquidación(es) de vacaciones pagadas en este rango aún no están en la nómina: agréguelas para que se reporten a la DIAN y se descuente el anticipo.`,
      unattachedVacations.map((v) => `VAC-${v.doc_number}`)));
  }
  if (pendingTerminations.length) {
    out.novedades.push(check('retiros_sin_liquidar', 'warning',
      `${pendingTerminations.length} empleado(s) se retiran en este período y su liquidación definitiva no está emitida.`,
      pendingTerminations.map(nameOf)));
  }
  if (!out.novedades.length) out.novedades.push(check('novedades_ok', 'ok', 'Sin observaciones en las novedades.'));

  // ── Empleados ──
  const sinDocumento = employees.filter((e) => !String(e.document_number || '').trim());
  const sinSalario = employees.filter((e) => !(Number(e.base_salary) > 0));
  if (employees.length === 0) out.empleados.push(check('sin_empleados', 'error', 'No hay empleados activos con esta periodicidad (y sede) para este período.'));
  if (sinDocumento.length) out.empleados.push(check('sin_documento', 'error', 'Empleados sin número de documento: la DIAN rechaza el documento.', sinDocumento.map(nameOf)));
  if (sinSalario.length) out.empleados.push(check('sin_salario', 'error', 'Empleados sin salario base mayor a cero.', sinSalario.map(nameOf)));
  const vencidos = employees.filter((e) => e.contract_end_date && iso(e.contract_end_date) < iso(period.start_date));
  if (vencidos.length) {
    out.empleados.push(check('contrato_vencido', 'warning', 'Contrato a término fijo vencido antes del período: renueve o registre el retiro.', vencidos.map(nameOf)));
  }
  if (!out.empleados.length) out.empleados.push(check('empleados_ok', 'ok', `${employees.length} empleado(s) con datos completos.`));

  // ── Seguridad social y aportes ──
  const sinEps = employees.filter((e) => !e.eps_supplier_id);
  const sinPension = employees.filter((e) => !e.pension_fund_supplier_id && !e.is_pensioned);
  if (sinEps.length) out.seguridad_social.push(check('sin_eps', 'warning', 'Empleados sin EPS asignada: la deducción de salud queda sin tercero.', sinEps.map(nameOf)));
  if (sinPension.length) out.seguridad_social.push(check('sin_pension', 'warning', 'Empleados sin fondo de pensiones asignado: la deducción queda sin tercero.', sinPension.map(nameOf)));
  const sinFondos = [['arl_supplier_id', 'ARL'], ['ccf_supplier_id', 'Caja de compensación'], ['sena_supplier_id', 'SENA'], ['icbf_supplier_id', 'ICBF']]
    .filter(([k]) => !settings[k]).map(([, label]) => label);
  if (sinFondos.length) {
    out.seguridad_social.push(check('aportes_sin_fondo', 'warning', 'Aportes del empleador sin fondo asignado en Configuración de Nómina.', sinFondos));
  }
  if (!out.seguridad_social.length) out.seguridad_social.push(check('ss_ok', 'ok', 'Seguridad social y aportes con sus fondos asignados.'));

  // ── Emisión: mapeos contables que usa el comprobante ──
  if (mappedKeys) {
    const required = ['payroll_net_payable', 'payroll_expense:basico'];
    const missing = required.filter((k) => !mappedKeys.has(k));
    if (missing.length) {
      out.emision.push(check('mapeos_contables', 'warning',
        'Faltan mapeos contables de nómina: el comprobante contable no se podrá generar (Contabilidad → Mapeo de cuentas, grupo Nómina).', missing));
    } else {
      out.emision.push(check('mapeos_ok', 'ok', 'Mapeos contables de nómina completos.'));
    }
  }
  return out;
}

const worst = (checks) => (checks.some((c) => c.level === 'error') ? 'error' : checks.some((c) => c.level === 'warning') ? 'warning' : 'ok');

/**
 * Pura: arma las etapas con su estado, validaciones y responsable.
 * @param {Array} events bitácora del período (cualquier orden)
 */
function buildStages({ period, checks, events = [] }) {
  const statusIdx = STATUS_ORDER.indexOf(period.status);
  const lastChange = (toStatus) => [...events]
    .filter((e) => e.event_type === 'status_change' && e.to_status === toStatus)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;

  let firstPending = true;
  return STAGES.map((stage) => {
    const stageChecks = checks[stage.key] || [];
    const base = { key: stage.key, label: stage.label, prep: !!stage.prep, checks: stageChecks, validation: worst(stageChecks) };
    if (stage.prep) {
      // Las de preparación quedan "hechas" cuando el período ya pasó a liquidado.
      const done = statusIdx >= 1;
      return { ...base, state: done ? 'done' : 'open', responsible: null, completed_at: null };
    }
    const targetIdx = STATUS_ORDER.indexOf(stage.status);
    const ev = lastChange(stage.status);
    if (statusIdx >= targetIdx) {
      return { ...base, state: 'done', responsible: ev?.user_name || null, completed_at: ev?.created_at || null };
    }
    const state = firstPending ? 'current' : 'pending';
    firstPending = false;
    return { ...base, state, responsible: null, completed_at: null };
  });
}

/** Errores que bloquean pasar a `targetStatus`. */
function blockingErrors(checks, targetStatus) {
  if (targetStatus === 'liquidado') {
    return ['novedades', 'empleados', 'seguridad_social'].flatMap((k) => checks[k] || []).filter((c) => c.level === 'error');
  }
  if (targetStatus === 'emitido') {
    return ['empleados', 'emision'].flatMap((k) => checks[k] || []).filter((c) => c.level === 'error');
  }
  return [];
}

async function loadChecks(tenantId, period) {
  const { PayrollNovedad, PayrollSetting, AccountMapping, PayrollVacationSettlement } = models();
  const { getEmployeesActiveInPeriod } = require('./payrollPeriodEmissionService');

  const employees = await getEmployeesActiveInPeriod(tenantId, period);
  const novedades = await PayrollNovedad.findAll({ where: { tenant_id: tenantId, payroll_period_id: period.id }, attributes: ['id', 'employee_id'] });
  const settings = (await PayrollSetting.findOne({ where: { tenant_id: tenantId } }))?.get({ plain: true }) || {};
  const mappings = await AccountMapping.findAll({ where: { tenant_id: tenantId, event_type: { [Op.like]: 'payroll%' } }, attributes: ['event_type'] });
  const unattachedVacations = (await PayrollVacationSettlement.findAll({
    where: { tenant_id: tenantId, status: 'pagada', payroll_period_id: null, payment_date: { [Op.between]: [period.start_date, period.end_date] } },
    attributes: ['doc_number'],
  })).map((r) => r.get({ plain: true }));

  // Retiros dentro del período cuya liquidación definitiva aún no se emitió (6.4).
  const leaving = employees.filter((e) => e.termination_date && iso(e.termination_date) >= iso(period.start_date) && iso(e.termination_date) <= iso(period.end_date));
  let pendingTerminations = leaving;
  if (leaving.length) {
    const settled = await models().PayrollPeriod.findAll({
      where: { tenant_id: tenantId, period_type: 'liquidacion', status: 'emitido', employee_id: leaving.map((e) => e.id) },
      attributes: ['employee_id'],
    });
    const settledIds = new Set(settled.map((p) => p.employee_id));
    pendingTerminations = leaving.filter((e) => !settledIds.has(e.id));
  }
  return evaluateChecks({
    period, employees, novedades, settings,
    mappedKeys: new Set(mappings.map((m) => m.event_type)),
    unattachedVacations, pendingTerminations,
  });
}

async function listEvents(tenantId, periodId, limit = 100) {
  const { PayrollPeriodEvent } = models();
  return PayrollPeriodEvent.findAll({
    where: { tenant_id: tenantId, payroll_period_id: periodId },
    order: [['created_at', 'DESC']],
    limit,
  });
}

async function getWorkflow(tenantId, period) {
  const checks = await loadChecks(tenantId, period);
  const events = (await listEvents(tenantId, period.id)).map((e) => e.get({ plain: true }));
  return { period_id: period.id, status: period.status, stages: buildStages({ period, checks, events }), events };
}

/** Registra un evento; nunca rompe el flujo si la bitácora falla. */
async function logEvent(tenantId, periodId, { type, fromStatus = null, toStatus = null, user = null, note = null, details = null }) {
  try {
    const { PayrollPeriodEvent } = models();
    const userName = user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || null) : null;
    await PayrollPeriodEvent.create({
      tenant_id: tenantId, payroll_period_id: periodId, event_type: type, from_status: fromStatus, to_status: toStatus,
      user_id: user?.id || null, user_name: userName, note, details,
    });
  } catch (error) {
    require('../../config/logger').warn(`[6.1] No se pudo registrar el evento del período ${periodId}: ${error.message}`);
  }
}

/**
 * Valida antes de avanzar. Devuelve { ok, errors, checks }. Los períodos de
 * liquidación definitiva (un solo empleado) no pasan por el flujograma.
 */
async function validateAdvance(tenantId, period, targetStatus) {
  if (period.period_type === 'liquidacion') return { ok: true, errors: [], checks: null };
  const checks = await loadChecks(tenantId, period);
  const errors = blockingErrors(checks, targetStatus);
  return { ok: errors.length === 0, errors, checks };
}

module.exports = { STAGES, evaluateChecks, buildStages, blockingErrors, getWorkflow, listEvents, logEvent, validateAdvance };
