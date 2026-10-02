// backend/src/services/payroll/payrollAccountingService.js
/**
 * Comprobantes contables de la nómina electrónica.
 *
 *  1. Comprobante de nómina (source_type 'payroll'): por cada empleado, una
 *     línea por concepto devengado y por deducción, más el neto por pagar,
 *     con la cédula del empleado como tercero. Las deducciones de seguridad
 *     social (salud, pensión, FSP) llevan como tercero el fondo del empleado
 *     (EPS/AFP) -- es a quien se le debe -- y el empleado en la descripción.
 *
 *  2. Aportes del empleador y provisiones: gasto consolidado por concepto y
 *     pasivo consolidado por fondo de destino (EPS, AFP, ARL, Caja, SENA,
 *     ICBF -- registrados como proveedores). Las provisiones de prestaciones
 *     (cesantías, intereses, prima, vacaciones) se acreditan por EMPLEADO:
 *     son del trabajador, y al pagarlas/liquidarlo hay que saber cuánto se
 *     le debe a cada uno.
 *     Va en el mismo asiento que (1) o en uno aparte (source_type
 *     'payroll_provisions') según PayrollSetting.accounting_voucher_mode.
 *
 *  3. Desembolso (source_type 'payroll_payment', ver registrarPago): pago
 *     del neto a los empleados y de la seguridad social a los fondos.
 *
 * Cuándo se causa cada prestación es configurable (PayrollSetting
 * *_accrual_mode) -- el encargado decide, el sistema solo ofrece las
 * opciones. Cesantías e intereses se PAGAN una vez al año y nunca hacen parte
 * del devengado mensual: lo que cambia es si se provisionan cada periodo o
 * en un solo asiento al 31-dic (causarCesantiasAnuales).
 *
 * Pago de una prestación (prima, vacaciones, cesantías/intereses en una
 * liquidación): se debita primero el pasivo provisionado de ESE empleado
 * hasta su saldo, y solo el excedente va al gasto. Así funciona igual con
 * cualquier modo de causación (sin provisión el saldo es 0 y todo va al
 * gasto) y no se duplica el gasto de lo ya provisionado.
 *
 * MEJOR ESFUERZO -- limitaciones conocidas:
 *  - El IBC de los aportes del empleador es el mismo que usa
 *    payrollService.js#calcularDeduccionesLegales para el empleado (solo el
 *    básico del periodo; sin horas extra/comisiones, sin el 70% del salario
 *    integral, sin pisos/topes de 1 y 25 SMLMV). Se mantiene igual a
 *    propósito para que empleado y empleador coticen sobre la misma base.
 *  - Intereses de cesantías en causación mensual: 12% de lo provisionado
 *    como cesantías (equivale a 1% mensual). Para quien no trabajó el año
 *    completo el valor legal es menor (× días/360) -- el ajuste queda al
 *    cierre. La causación anual sí aplica los días.
 */
'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const { PAYROLL_CONSTANTS, CONCEPT_LABELS, sumarValorNovedad } = require('./payrollService');
const { createDraftEntry, reverseEntry } = require('../accounting/journalEntry.service');

// Se resuelven en tiempo de ejecución: autoEntries.service.js importa este
// archivo y models/index.js carga medio sistema.
const models = () => require('../../models');

/* ──────────────────────────────────────────────────────────
 * Tarifas a cargo del empleador
 * ────────────────────────────────────────────────────────── */

const APORTES_EMPLEADOR = {
  SALUD: 8.5,
  SALUD_APRENDIZ: 12.5, // Ley 789/2002 Art. 30 -- el empleador asume la totalidad
  PENSION: 12,
  // Actividades de alto riesgo (Decreto 2090/2003): 10 puntos adicionales a
  // cargo exclusivo del empleador.
  PENSION_ALTO_RIESGO: 22,
  CCF: 4,
  SENA: 2,
  ICBF: 3,
  // Art. 114-1 E.T.: exonerados de salud/SENA/ICBF por trabajadores que
  // devenguen menos de 10 SMLMV.
  TOPE_EXONERACION_SMLMV: 10,
};

// Decreto 1295/1994 Art. 26 -- tarifa de cotización por clase de riesgo.
const ARL_TARIFAS = { 1: 0.522, 2: 1.044, 3: 2.436, 4: 4.35, 5: 6.96 };

const WORKER_TYPE = { PENSIONADO: '02', APRENDIZ_LECTIVA: '03', APRENDIZ_PRODUCTIVA: '04' };

const HORAS_KEYS = ['heds', 'hens', 'hrns', 'heddfs', 'hrddfs', 'hendfs', 'hrndfs'];

// Concepto devengado (key de liquidation.devengados) → sufijo de
// payroll_expense:*. Lo no listado va a 'otros'. Las prestaciones (primas,
// cesantías, vacaciones) se tratan aparte, ver desglosarDevengados.
const DEVENGADO_EXPENSE = {
  basico: 'basico',
  transporte: 'transporte',
  comisiones: 'comisiones',
  incapacidades: 'incapacidades_licencias',
  licencias: 'incapacidades_licencias',
  bonificaciones: 'bonificaciones',
  bonifRetiro: 'bonificaciones',
  auxilios: 'auxilios',
  teletrabajo: 'auxilios',
  apoyoSost: 'auxilios',
  dotacion: 'dotacion',
  indemnizacion: 'indemnizaciones',
  ...Object.fromEntries(HORAS_KEYS.map((k) => [k, 'horas_extra'])),
};

// Deducción (key de liquidation.deducciones) → cuenta y, para la seguridad
// social, el fondo del empleado que queda como tercero.
const DEDUCCION_ACCOUNT = {
  salud: { key: 'payroll_social_security_payable', fund: 'eps' },
  fondoPension: { key: 'payroll_pension_payable', fund: 'pension' },
  fondoSP: { key: 'payroll_pension_payable', fund: 'pension' },
  retencionFuente: { key: 'payroll_retefuente_payable' },
  libranzas: { key: 'payroll_libranzas_payable' },
  sindicatos: { key: 'payroll_union_dues_payable' },
  cooperativa: { key: 'payroll_cooperative_payable' },
  embargoFiscal: { key: 'payroll_garnishments_payable' },
  pensionVoluntaria: { key: 'payroll_voluntary_pension_payable' },
  afc: { key: 'payroll_voluntary_pension_payable' },
  anticipos: { key: 'payroll_advances_receivable' },
};
const DEDUCCION_DEFAULT = { key: 'payroll_other_deductions_payable' };

// Pasivos que se cancelan con el pago de seguridad social (PILA).
const SOCIAL_SECURITY_PAYABLE_KEYS = [
  'payroll_social_security_payable', 'payroll_pension_payable', 'payroll_arl_payable', 'payroll_parafiscales_payable',
];

const PRESTACION_LABELS = {
  cesantias: 'Cesantías',
  intereses_cesantias: 'Intereses sobre cesantías',
  prima: 'Prima de servicios',
  vacaciones: 'Vacaciones',
};

const APORTE_LABELS = {
  eps: 'Salud (EPS)',
  pension: 'Pensión (AFP)',
  arl: 'Riesgos laborales (ARL)',
  ccf: 'Caja de compensación',
  sena: 'SENA',
  icbf: 'ICBF',
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ──────────────────────────────────────────────────────────
 * Cálculo de aportes y provisiones (no toca la DIAN: el XML de nómina
 * electrónica no reporta lo que paga el empleador)
 * ────────────────────────────────────────────────────────── */

function basesDeLiquidacion(liquidation) {
  const dev = liquidation?.devengados || {};
  const sueldo = Number(dev.basico?.sueldoTrabajado || 0);
  const transporte = Number(dev.transporte?.auxilioTransporte || 0);
  const variables = HORAS_KEYS.reduce((s, k) => s + sumarValorNovedad(dev[k]), 0) + sumarValorNovedad(dev.comisiones);
  return {
    ibc: sueldo,
    // Cesantías y prima: salario + auxilio de transporte + lo variable
    // salarial (horas extra/recargos, comisiones). Vacaciones: solo salario.
    prestacional: sueldo + transporte + variables,
    vacaciones: sueldo,
    diasTrabajados: Number(dev.basico?.diasTrabajados || 0),
  };
}

/**
 * @param {object} params.employee
 * @param {object} params.liquidation - salida de liquidarEmpleado / snapshot_liquidation
 * @param {object} params.settings - PayrollSetting
 * @param {boolean} params.isLiquidacion - periodo de liquidación definitiva:
 *   no se provisiona (la liquidación ya paga las prestaciones completas).
 */
function calcularAportesYProvisiones({ employee, liquidation, settings, isLiquidacion = false }) {
  const { ibc, prestacional, vacaciones: baseVacaciones } = basesDeLiquidacion(liquidation);
  const pct = (base, p) => round2(base * (p / 100));

  const wt = employee.worker_type;
  const aprendiz = wt === WORKER_TYPE.APRENDIZ_LECTIVA || wt === WORKER_TYPE.APRENDIZ_PRODUCTIVA;
  const integral = employee.salary_type === 'integral';
  const salarioEnSmlmv = Number(employee.base_salary || 0) / PAYROLL_CONSTANTS.SMLMV;
  const exonerado = !!settings.employer_exonerated_114_1 && !aprendiz && salarioEnSmlmv < APORTES_EMPLEADOR.TOPE_EXONERACION_SMLMV;
  const claseRiesgo = Number(employee.arl_risk_class) || 1;

  const aportes = {
    eps: aprendiz ? pct(ibc, APORTES_EMPLEADOR.SALUD_APRENDIZ) : (exonerado ? 0 : pct(ibc, APORTES_EMPLEADOR.SALUD)),
    pension: (aprendiz || wt === WORKER_TYPE.PENSIONADO)
      ? 0
      : pct(ibc, employee.high_risk_pension ? APORTES_EMPLEADOR.PENSION_ALTO_RIESGO : APORTES_EMPLEADOR.PENSION),
    // El aprendiz en etapa lectiva no cotiza ARL; en etapa productiva sí.
    arl: wt === WORKER_TYPE.APRENDIZ_LECTIVA ? 0 : pct(ibc, ARL_TARIFAS[claseRiesgo] || ARL_TARIFAS[1]),
    ccf: aprendiz ? 0 : pct(ibc, APORTES_EMPLEADOR.CCF),
    sena: (aprendiz || exonerado) ? 0 : pct(ibc, APORTES_EMPLEADOR.SENA),
    icbf: (aprendiz || exonerado) ? 0 : pct(ibc, APORTES_EMPLEADOR.ICBF),
  };

  const provisiones = { cesantias: 0, intereses_cesantias: 0, prima: 0, vacaciones: 0 };
  if (!isLiquidacion && !aprendiz) {
    // El salario integral ya incluye el factor prestacional (Art. 132 CST):
    // no causa cesantías, intereses ni prima -- sí vacaciones.
    if (!integral && settings.cesantias_accrual_mode === 'monthly') {
      provisiones.cesantias = round2(prestacional / 12);
      provisiones.intereses_cesantias = round2(provisiones.cesantias * 0.12);
    }
    if (!integral && settings.prima_accrual_mode === 'monthly') {
      provisiones.prima = round2(prestacional / 12);
    }
    if (settings.vacaciones_accrual_mode === 'monthly') {
      provisiones.vacaciones = round2(baseVacaciones / 24); // 15 días por año = 1/24 del salario
    }
  }

  return { ibc, aportes, provisiones, exonerado };
}

/**
 * Líneas devengadas de una liquidación, con el destino contable de cada una.
 * Cesantías se parte en dos (pago + intereses) porque van a cuentas distintas.
 */
function desglosarDevengados(liquidation) {
  const items = [];
  for (const [key, value] of Object.entries(liquidation?.devengados || {})) {
    if (key === 'cesantias') {
      const pago = round2(value?.pago);
      const intereses = round2(value?.pagoIntereses);
      if (pago) items.push({ key, label: PRESTACION_LABELS.cesantias, amount: pago, prestacion: 'cesantias' });
      if (intereses) items.push({ key, label: PRESTACION_LABELS.intereses_cesantias, amount: intereses, prestacion: 'intereses_cesantias' });
      continue;
    }
    const amount = round2(sumarValorNovedad(value));
    if (!amount) continue;
    const label = CONCEPT_LABELS[key] || key;
    if (key === 'primas') items.push({ key, label: PRESTACION_LABELS.prima, amount, prestacion: 'prima' });
    else if (key === 'vacaciones') items.push({ key, label: PRESTACION_LABELS.vacaciones, amount, prestacion: 'vacaciones' });
    else items.push({ key, label, amount, expenseKey: DEVENGADO_EXPENSE[key] || 'otros' });
  }
  return items;
}

/* ──────────────────────────────────────────────────────────
 * Helpers contables
 * ────────────────────────────────────────────────────────── */

async function cargarMapeos(tenantId, t) {
  const { AccountMapping } = models();
  const rows = await AccountMapping.findAll({
    where: { tenant_id: tenantId, event_type: { [Op.like]: 'payroll%' } },
    transaction: t,
  });
  const map = new Map(rows.map((r) => [r.event_type, r.account_id]));
  return (key) => {
    const id = map.get(key);
    if (!id) throw new Error(`No hay mapeo contable configurado para "${key}" -- revíselo en Contabilidad → Mapeo de Cuentas (grupo Nómina).`);
    return id;
  };
}

async function getSettings(tenantId, t) {
  const { PayrollSetting } = models();
  const [settings] = await PayrollSetting.findOrCreate({
    where: { tenant_id: tenantId },
    defaults: { tenant_id: tenantId },
    transaction: t,
  });
  return settings;
}

async function nombresDeProveedores(tenantId, ids, t) {
  const { Supplier } = models();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await Supplier.findAll({ where: { tenant_id: tenantId, id: unique }, attributes: ['id', 'name', 'business_name'], transaction: t });
  return new Map(rows.map((s) => [s.id, s.business_name || s.name]));
}

// Saldo (crédito - débito) de un pasivo para un tercero, en asientos no
// anulados (los automáticos quedan en borrador hasta que el contador los
// revise, así que cuentan). Una reversión de un asiento contabilizado es
// otro asiento con signo contrario: también neutraliza.
async function saldoPasivoTercero(tenantId, accountId, thirdPartyId, t) {
  const { JournalEntry, JournalEntryLine } = models();
  const row = await JournalEntryLine.findOne({
    attributes: [[sequelize.literal('COALESCE(SUM("JournalEntryLine"."credit" - "JournalEntryLine"."debit"), 0)'), 'saldo']],
    include: [{ model: JournalEntry, as: 'entry', attributes: [], where: { tenant_id: tenantId, status: { [Op.ne]: 'voided' } } }],
    where: { account_id: accountId, third_party_id: thirdPartyId },
    raw: true,
    transaction: t,
  });
  return Number(row?.saldo || 0);
}

const nombreEmpleado = (e) => [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' ');
const etiquetaEmpleado = (e) => `${nombreEmpleado(e)} (${e.document_number})`;

async function asientosVigentesDelPeriodo(tenantId, periodId, sourceTypes, t, withLines = false) {
  const { JournalEntry, JournalEntryLine } = models();
  return JournalEntry.findAll({
    where: {
      tenant_id: tenantId,
      source_id: periodId,
      source_type: sourceTypes,
      status: { [Op.ne]: 'voided' },
      reversed_by_entry_id: null,
    },
    include: withLines ? [{ model: JournalEntryLine, as: 'lines' }] : [],
    order: [['created_at', 'ASC']],
    transaction: t,
  });
}

/* ──────────────────────────────────────────────────────────
 * 1 + 2. Comprobantes del periodo
 * ────────────────────────────────────────────────────────── */

async function construirLineas({ tenantId, period, liquidations, settings, t }) {
  const acc = await cargarMapeos(tenantId, t);
  const isLiquidacion = period.period_type === 'liquidacion';
  const warnings = [];

  const fundIds = liquidations.flatMap(({ employee }) => [employee.eps_supplier_id, employee.pension_fund_supplier_id, employee.severance_fund_supplier_id]);
  fundIds.push(settings.arl_supplier_id, settings.ccf_supplier_id, settings.sena_supplier_id, settings.icbf_supplier_id);
  const fundNames = await nombresDeProveedores(tenantId, fundIds, t);
  const fundName = (id) => (id ? fundNames.get(id) || 'fondo' : null);

  const nominaLines = [];
  // Aportes/provisiones: gasto consolidado por concepto, pasivo por fondo.
  const gastoAportes = new Map(); // mappingKey -> { amount, label, count }
  const pasivoAportes = new Map(); // `${mappingKey}|${tercero}` -> { key, tercero, amount, label }
  const provisionLines = [];

  const sumarGasto = (key, label, amount) => {
    if (!amount) return;
    const cur = gastoAportes.get(key) || { amount: 0, label, count: 0 };
    cur.amount = round2(cur.amount + amount);
    cur.count += 1;
    gastoAportes.set(key, cur);
  };
  const sumarPasivo = (key, tercero, label, amount) => {
    if (!amount) return;
    // Sin fondo asignado no se mezclan conceptos distintos de la misma
    // cuenta (Caja/SENA/ICBF comparten 237010).
    const id = `${key}|${tercero || `sin-fondo:${label}`}`;
    const cur = pasivoAportes.get(id) || { key, tercero, label, amount: 0 };
    cur.amount = round2(cur.amount + amount);
    pasivoAportes.set(id, cur);
  };

  for (const { employee, liquidation } of liquidations) {
    if (!liquidation) continue;
    const emp = etiquetaEmpleado(employee);
    const { aportes, provisiones } = calcularAportesYProvisiones({ employee, liquidation, settings, isLiquidacion });

    // ── Comprobante de nómina: devengados ──
    let totalDevengado = 0;
    for (const item of desglosarDevengados(liquidation)) {
      totalDevengado = round2(totalDevengado + item.amount);
      if (!item.prestacion) {
        nominaLines.push({ account_id: acc(`payroll_expense:${item.expenseKey}`), debit: item.amount, credit: 0, description: `${item.label} — ${emp}`, third_party_id: employee.id });
        continue;
      }
      const provisionAccount = acc(`payroll_provision:${item.prestacion}`);
      // eslint-disable-next-line no-await-in-loop
      const saldo = await saldoPasivoTercero(tenantId, provisionAccount, employee.id, t);
      const disponible = Math.max(0, round2(saldo + (provisiones[item.prestacion] || 0)));
      const contraPasivo = Math.min(item.amount, disponible);
      const alGasto = round2(item.amount - contraPasivo);
      if (contraPasivo > 0) {
        nominaLines.push({ account_id: provisionAccount, debit: contraPasivo, credit: 0, description: `Pago ${item.label.toLowerCase()} (provisionado) — ${emp}`, third_party_id: employee.id });
      }
      if (alGasto > 0) {
        nominaLines.push({ account_id: acc(`payroll_expense:${item.prestacion}`), debit: alGasto, credit: 0, description: `Pago ${item.label.toLowerCase()} — ${emp}`, third_party_id: employee.id });
      }
    }

    // ── Comprobante de nómina: deducciones ──
    let totalDeducido = 0;
    for (const [key, value] of Object.entries(liquidation.deducciones || {})) {
      const amount = round2(sumarValorNovedad(value));
      if (!amount) continue;
      totalDeducido = round2(totalDeducido + amount);
      const cfg = DEDUCCION_ACCOUNT[key] || DEDUCCION_DEFAULT;
      const label = CONCEPT_LABELS[key] || key;
      let tercero = employee.id;
      let sufijo = '';
      if (cfg.fund) {
        tercero = cfg.fund === 'eps' ? employee.eps_supplier_id : employee.pension_fund_supplier_id;
        if (!tercero) {
          sufijo = cfg.fund === 'eps' ? ' (sin EPS asignada)' : ' (sin fondo de pensiones asignado)';
          warnings.push(`${emp}: ${cfg.fund === 'eps' ? 'no tiene EPS' : 'no tiene fondo de pensiones'} asignada en su ficha -- la deducción queda sin tercero.`);
        } else {
          sufijo = ` — ${fundName(tercero)}`;
        }
      }
      nominaLines.push({ account_id: acc(cfg.key), debit: 0, credit: amount, description: `${label} — ${emp}${sufijo}`, third_party_id: tercero || null });
    }

    // ── Neto por pagar al empleado ──
    const neto = round2(totalDevengado - totalDeducido);
    const netoDocumento = round2(Number(liquidation.devengadosTotal || 0) - Number(liquidation.deduccionesTotal || 0));
    if (Math.abs(neto - netoDocumento) > 1) {
      warnings.push(`${emp}: el neto por conceptos (${neto}) no coincide con el total del documento DIAN (${netoDocumento}).`);
    }
    if (neto > 0) {
      nominaLines.push({ account_id: acc('payroll_net_payable'), debit: 0, credit: neto, description: `Neto a pagar — ${emp}`, third_party_id: employee.id });
    } else if (neto < 0) {
      nominaLines.push({ account_id: acc('payroll_net_payable'), debit: -neto, credit: 0, description: `Saldo a cargo del empleado — ${emp}`, third_party_id: employee.id });
    }

    // ── Aportes del empleador, por fondo de destino ──
    const terceroAporte = {
      eps: employee.eps_supplier_id,
      pension: employee.pension_fund_supplier_id,
      arl: settings.arl_supplier_id,
      ccf: settings.ccf_supplier_id,
      sena: settings.sena_supplier_id,
      icbf: settings.icbf_supplier_id,
    };
    const pasivoAporte = {
      eps: 'payroll_social_security_payable',
      pension: 'payroll_pension_payable',
      arl: 'payroll_arl_payable',
      ccf: 'payroll_parafiscales_payable',
      sena: 'payroll_parafiscales_payable',
      icbf: 'payroll_parafiscales_payable',
    };
    for (const [concepto, amount] of Object.entries(aportes)) {
      if (!amount) continue;
      sumarGasto(`payroll_employer:${concepto}`, `Aportes ${APORTE_LABELS[concepto]} a cargo del empleador`, amount);
      sumarPasivo(pasivoAporte[concepto], terceroAporte[concepto], APORTE_LABELS[concepto], amount);
    }

    // ── Provisiones de prestaciones, por empleado ──
    for (const [prestacion, amount] of Object.entries(provisiones)) {
      if (!amount) continue;
      sumarGasto(`payroll_expense:${prestacion}`, `Provisión ${PRESTACION_LABELS[prestacion].toLowerCase()}`, amount);
      const fondo = prestacion === 'cesantias' && employee.severance_fund_supplier_id ? ` — ${fundName(employee.severance_fund_supplier_id)}` : '';
      provisionLines.push({
        account_id: acc(`payroll_provision:${prestacion}`),
        debit: 0,
        credit: amount,
        description: `Provisión ${PRESTACION_LABELS[prestacion].toLowerCase()} — ${emp}${fondo}`,
        third_party_id: employee.id,
      });
    }
  }

  const sinFondo = [...pasivoAportes.values()].filter((p) => !p.tercero).map((p) => p.label);
  if (sinFondo.length) {
    warnings.push(`Aportes sin fondo asignado: ${[...new Set(sinFondo)].join(', ')} -- asígnelos en la ficha del empleado o en Configuración de Nómina.`);
  }

  const aportesLines = [
    ...[...gastoAportes.entries()].map(([key, g]) => ({
      account_id: acc(key), debit: g.amount, credit: 0, description: `${g.label} — consolidado (${g.count} empleado(s))`,
    })),
    ...[...pasivoAportes.values()].map((p) => ({
      account_id: acc(p.key), debit: 0, credit: p.amount,
      description: `Aportes ${p.label} por pagar — ${p.tercero ? fundName(p.tercero) : 'sin fondo asignado'}`,
      third_party_id: p.tercero || null,
    })),
    ...provisionLines,
  ];

  return { nominaLines, aportesLines, warnings };
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const esPeriodoCerrado = (error) => /está cerrado/.test(error?.message || '');

/**
 * Crea los asientos (uno o dos según accounting_voucher_mode) dentro de la
 * transacción dada. Si la fecha cae en un periodo fiscal cerrado y se
 * permite (regeneración por nota de ajuste), se fecha hoy.
 */
async function crearComprobantes({ period, liquidations, tenantId, userId, t, entryDate, sufijo = '', allowTodayFallback = false }) {
  const settings = await getSettings(tenantId, t);
  const { nominaLines, aportesLines, warnings } = await construirLineas({ tenantId, period, liquidations: liquidations || [], settings, t });
  if (!nominaLines.length) return { entries: [], warnings };

  const rango = `${period.start_date || ''} — ${period.end_date || ''}`;
  const empleados = (liquidations || []).filter((l) => l.liquidation).length;
  const vouchers = [];
  if (settings.accounting_voucher_mode === 'split' || !aportesLines.length) {
    vouchers.push({ sourceType: 'payroll', description: `Comprobante de nómina ${rango} (${empleados} empleado(s))${sufijo}`, lines: nominaLines });
    if (aportesLines.length) {
      vouchers.push({ sourceType: 'payroll_provisions', description: `Aportes de seguridad social y provisiones ${rango}${sufijo}`, lines: aportesLines });
    }
  } else {
    vouchers.push({
      sourceType: 'payroll',
      description: `Comprobante de nómina, aportes y provisiones ${rango} (${empleados} empleado(s))${sufijo}`,
      lines: [...nominaLines, ...aportesLines],
    });
  }

  let fecha = entryDate || period.payment_date || period.end_date || todayISO();
  const entries = [];
  for (const v of vouchers) {
    const data = { branchId: period.branch_id, sourceId: period.id, createdBy: userId, ...v };
    try {
      // eslint-disable-next-line no-await-in-loop
      entries.push(await createDraftEntry(tenantId, { ...data, entryDate: fecha }, t));
    } catch (error) {
      if (!allowTodayFallback || !esPeriodoCerrado(error) || fecha === todayISO()) throw error;
      fecha = todayISO();
      warnings.push('El periodo fiscal original está cerrado: el comprobante se registró con fecha de hoy.');
      // eslint-disable-next-line no-await-in-loop
      entries.push(await createDraftEntry(tenantId, { ...data, entryDate: fecha }, t));
    }
  }
  return { entries, warnings };
}

/**
 * Genera los comprobantes contables (en borrador) de un periodo de nómina ya
 * emitido. Idempotente: si el periodo ya tiene comprobantes vigentes, no
 * crea nada y los devuelve.
 *
 * @param {Array} liquidations - [{ employee, liquidation }]
 * @returns {{ entries: Array, warnings: string[], alreadyExisted: boolean }}
 */
async function generarComprobantesNomina(period, liquidations, tenantId, userId) {
  const t = await sequelize.transaction();
  try {
    const existing = await asientosVigentesDelPeriodo(tenantId, period.id, ['payroll', 'payroll_provisions'], t);
    if (existing.length) {
      await t.commit();
      return { entries: existing, warnings: [], alreadyExisted: true };
    }

    const { entries, warnings } = await crearComprobantes({ period, liquidations, tenantId, userId, t });
    await t.commit();
    if (warnings.length) logger.warn(`[Nómina-Contabilidad] Periodo ${period.id}: ${warnings.join(' | ')}`);
    return { entries, warnings, alreadyExisted: false };
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/**
 * Liquidación vigente de un documento: la de la última Nota de Ajuste
 * aceptada (Reemplazar), ninguna si esa nota fue Eliminar, o la original.
 * El Anexo Técnico es explícito en que la última nota validada es la que
 * sirve de soporte.
 */
function liquidacionVigente(doc) {
  const aceptadas = (doc.adjustments || [])
    .filter((a) => a.dian_status === 'accepted')
    .sort((a, b) => new Date(a.dian_accepted_at || a.created_at) - new Date(b.dian_accepted_at || b.created_at));
  const ultima = aceptadas[aceptadas.length - 1];
  if (!ultima) return doc.snapshot_liquidation;
  if (ultima.adjustment_type === 'delete') return null;
  return ultima.snapshot_liquidation;
}

const includeAjustes = () => ({ model: models().PayrollDocumentAdjustment, as: 'adjustments', required: false });

/**
 * Liquidaciones vigentes (aceptadas por la DIAN, con sus notas de ajuste
 * aplicadas) de un periodo, reconstruidas desde los snapshots.
 */
async function liquidacionesAceptadasDelPeriodo(tenantId, periodId, t = null) {
  const { PayrollDocument, Employee } = models();
  const docs = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, payroll_period_id: periodId, dian_status: 'accepted' },
    include: [{ model: Employee, as: 'employee' }, includeAjustes()],
    transaction: t,
  });
  return docs
    .map((d) => ({ employee: d.employee, liquidation: liquidacionVigente(d) }))
    .filter((l) => l.employee && l.liquidation);
}

// Anula (borrador) o reversa (contabilizado) un asiento dentro de la
// transacción -- mismo criterio que reverseEntry, pero voidEntry no recibe
// transacción y aquí la anulación y la regeneración deben ir juntas.
async function anularOReversarAsiento(entry, tenantId, userId, reason, t) {
  if (entry.status === 'draft') {
    await entry.update({ status: 'voided', voided_by: userId || null, voided_at: new Date(), void_reason: reason }, { transaction: t });
    return 'voided';
  }
  await reverseEntry(entry.id, tenantId, userId, reason, t);
  return 'reversed';
}

/**
 * Reemplaza los comprobantes de un periodo por unos nuevos calculados con
 * las liquidaciones vigentes -- se llama al quedar aceptada una Nota de
 * Ajuste (Reemplazar/Eliminar) y también a mano (cambio de fondos o de
 * configuración). Los borradores se anulan y conservan la fecha original;
 * si algún comprobante ya estaba contabilizado se reversa y el nuevo queda
 * con fecha de hoy (el original ya afectó reportes de su mes).
 * Los pagos ya registrados no se tocan: el pendiente por pagar se recalcula
 * desde los saldos (ver saldosPendientesPeriodo), así que una diferencia
 * queda como saldo a pagar o a favor.
 */
async function regenerarComprobantesPeriodo(tenantId, periodId, userId, reason = 'Regeneración de comprobantes de nómina') {
  const { PayrollPeriod } = models();
  const t = await sequelize.transaction();
  try {
    const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!period) throw new Error('Periodo no encontrado');
    if (!['emitido', 'cerrado'].includes(period.status)) throw new Error('Solo se contabiliza un periodo ya emitido a la DIAN');

    const existing = await asientosVigentesDelPeriodo(tenantId, period.id, ['payroll', 'payroll_provisions'], t);
    let huboContabilizado = false;
    for (const entry of existing) {
      // eslint-disable-next-line no-await-in-loop
      if (await anularOReversarAsiento(entry, tenantId, userId, reason, t) === 'reversed') huboContabilizado = true;
    }

    const liquidations = await liquidacionesAceptadasDelPeriodo(tenantId, period.id, t);
    const { entries, warnings } = liquidations.length
      ? await crearComprobantes({
        period, liquidations, tenantId, userId, t,
        entryDate: huboContabilizado ? todayISO() : undefined,
        sufijo: existing.length ? ' — regenerado' : '',
        allowTodayFallback: true,
      })
      : { entries: [], warnings: [] };

    await t.commit();
    return { entries, warnings, replaced: existing.length };
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * Cierre anual de cesantías e intereses
 * ────────────────────────────────────────────────────────── */

const validarAnio = (year) => {
  const anio = Number(year);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error('Año inválido');
  return anio;
};

/**
 * Base de cesantías del año por empleado, desde las liquidaciones vigentes.
 * Excluye a quien se liquidó en el año (cobró sus cesantías en la
 * liquidación), salario integral y aprendices.
 */
async function baseCesantiasDelAnio(tenantId, anio, t) {
  const { PayrollDocument, PayrollPeriod, Employee } = models();
  const docs = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, dian_status: 'accepted' },
    include: [
      { model: PayrollPeriod, as: 'period', where: { end_date: { [Op.between]: [`${anio}-01-01`, `${anio}-12-31`] } } },
      { model: Employee, as: 'employee' },
      includeAjustes(),
    ],
    transaction: t,
  });

  const liquidados = new Set(docs.filter((d) => d.period.period_type === 'liquidacion').map((d) => d.employee_id));
  const porEmpleado = new Map();
  for (const d of docs) {
    if (d.period.period_type === 'liquidacion' || liquidados.has(d.employee_id) || !d.employee) continue;
    if (d.employee.salary_type === 'integral') continue;
    if ([WORKER_TYPE.APRENDIZ_LECTIVA, WORKER_TYPE.APRENDIZ_PRODUCTIVA].includes(d.employee.worker_type)) continue;
    const liquidation = liquidacionVigente(d);
    if (!liquidation) continue;
    const { prestacional, diasTrabajados } = basesDeLiquidacion(liquidation);
    const cur = porEmpleado.get(d.employee_id) || { employee: d.employee, base: 0, dias: 0 };
    cur.base += prestacional;
    cur.dias += diasTrabajados;
    porEmpleado.set(d.employee_id, cur);
  }

  for (const cur of porEmpleado.values()) {
    cur.cesantias = round2(cur.base / 12);
    cur.intereses = round2(cur.cesantias * 0.12 * (Math.min(cur.dias, 360) / 360));
  }
  return porEmpleado;
}

async function asientoAnualExistente(tenantId, sourceType, fecha, t) {
  const { JournalEntry } = models();
  return JournalEntry.findOne({
    where: { tenant_id: tenantId, source_type: sourceType, entry_date: fecha, status: { [Op.ne]: 'voided' }, reversed_by_entry_id: null },
    transaction: t,
  });
}

// cesantias_accrual_mode = 'year_end': un solo asiento de causación al 31-dic.
async function causarCesantiasAnuales(tenantId, anio, userId, t) {
  const fechaCorte = `${anio}-12-31`;
  const existing = await asientoAnualExistente(tenantId, 'payroll_cesantias_year_end', fechaCorte, t);
  if (existing) throw new Error(`Las cesantías de ${anio} ya fueron causadas (asiento ${existing.entry_number}).`);

  const porEmpleado = await baseCesantiasDelAnio(tenantId, anio, t);
  if (!porEmpleado.size) throw new Error(`No hay nómina aceptada por la DIAN en ${anio} para causar cesantías.`);

  const acc = await cargarMapeos(tenantId, t);
  const fundNames = await nombresDeProveedores(tenantId, [...porEmpleado.values()].map((e) => e.employee.severance_fund_supplier_id), t);

  let totalCesantias = 0;
  let totalIntereses = 0;
  const credits = [];
  for (const { employee, cesantias, intereses } of porEmpleado.values()) {
    if (!cesantias) continue;
    totalCesantias = round2(totalCesantias + cesantias);
    totalIntereses = round2(totalIntereses + intereses);
    const emp = etiquetaEmpleado(employee);
    const fondo = employee.severance_fund_supplier_id ? ` — ${fundNames.get(employee.severance_fund_supplier_id) || 'fondo'}` : '';
    credits.push({ account_id: acc('payroll_provision:cesantias'), debit: 0, credit: cesantias, description: `Cesantías ${anio} — ${emp}${fondo}`, third_party_id: employee.id });
    if (intereses) credits.push({ account_id: acc('payroll_provision:intereses_cesantias'), debit: 0, credit: intereses, description: `Intereses sobre cesantías ${anio} — ${emp}`, third_party_id: employee.id });
  }

  const lines = [
    { account_id: acc('payroll_expense:cesantias'), debit: totalCesantias, credit: 0, description: `Cesantías ${anio} — consolidado (${porEmpleado.size} empleado(s))` },
    ...(totalIntereses ? [{ account_id: acc('payroll_expense:intereses_cesantias'), debit: totalIntereses, credit: 0, description: `Intereses sobre cesantías ${anio} — consolidado` }] : []),
    ...credits,
  ];

  const entry = await createDraftEntry(tenantId, {
    entryDate: fechaCorte, sourceType: 'payroll_cesantias_year_end',
    description: `Causación anual de cesantías e intereses ${anio}`,
    lines, createdBy: userId,
  }, t);
  return { mode: 'year_end', entry, employees: porEmpleado.size, totalCesantias, totalIntereses };
}

// Lo provisionado en el año (solo causaciones: créditos de los
// comprobantes de nómina vigentes) por empleado y cuenta de provisión.
async function provisionadoDelAnio(tenantId, anio, accountIds, t) {
  const { JournalEntry, JournalEntryLine } = models();
  const rows = await JournalEntryLine.findAll({
    attributes: ['account_id', 'third_party_id', [sequelize.literal('COALESCE(SUM("JournalEntryLine"."credit"), 0)'), 'total']],
    include: [{
      model: JournalEntry, as: 'entry', attributes: [],
      where: {
        tenant_id: tenantId,
        source_type: ['payroll', 'payroll_provisions'],
        status: { [Op.ne]: 'voided' },
        reversed_by_entry_id: null,
        entry_date: { [Op.between]: [`${anio}-01-01`, `${anio}-12-31`] },
      },
    }],
    where: { account_id: accountIds, third_party_id: { [Op.ne]: null } },
    group: ['JournalEntryLine.account_id', 'JournalEntryLine.third_party_id'],
    raw: true,
    transaction: t,
  });
  return new Map(rows.map((r) => [`${r.account_id}|${r.third_party_id}`, Number(r.total)]));
}

/**
 * cesantias_accrual_mode = 'monthly': ajuste al 31-dic de lo provisionado
 * contra el valor legal del año. La diferencia típica es de intereses: se
 * provisionan al 12% de lo causado cada periodo, pero el valor legal es
 * cesantías × 12% × días/360 (menor para quien no trabajó el año completo).
 */
async function ajustarProvisionesAnuales(tenantId, anio, userId, t) {
  const fechaCorte = `${anio}-12-31`;
  const existing = await asientoAnualExistente(tenantId, 'payroll_provision_adjustment', fechaCorte, t);
  if (existing) throw new Error(`Las provisiones de ${anio} ya fueron ajustadas (asiento ${existing.entry_number}).`);

  const porEmpleado = await baseCesantiasDelAnio(tenantId, anio, t);
  if (!porEmpleado.size) throw new Error(`No hay nómina aceptada por la DIAN en ${anio} para ajustar.`);

  const acc = await cargarMapeos(tenantId, t);
  const conceptos = [
    { key: 'cesantias', valor: (e) => e.cesantias, label: 'Cesantías' },
    { key: 'intereses_cesantias', valor: (e) => e.intereses, label: 'Intereses sobre cesantías' },
  ];
  const provisionAccounts = conceptos.map((c) => acc(`payroll_provision:${c.key}`));
  const provisionado = await provisionadoDelAnio(tenantId, anio, provisionAccounts, t);

  const lines = [];
  const resumen = {};
  for (const c of conceptos) {
    const provisionAccount = acc(`payroll_provision:${c.key}`);
    let neto = 0;
    for (const e of porEmpleado.values()) {
      const diff = round2(c.valor(e) - (provisionado.get(`${provisionAccount}|${e.employee.id}`) || 0));
      if (Math.abs(diff) < 0.01) continue;
      neto = round2(neto + diff);
      lines.push({
        account_id: provisionAccount,
        debit: diff < 0 ? -diff : 0,
        credit: diff > 0 ? diff : 0,
        description: `Ajuste ${c.label.toLowerCase()} ${anio} — ${etiquetaEmpleado(e.employee)}`,
        third_party_id: e.employee.id,
      });
    }
    resumen[c.key] = neto;
    if (Math.abs(neto) >= 0.01) {
      lines.push({
        account_id: acc(`payroll_expense:${c.key}`),
        debit: neto > 0 ? neto : 0,
        credit: neto < 0 ? -neto : 0,
        description: `Ajuste ${c.label.toLowerCase()} ${anio} — consolidado`,
      });
    }
  }

  if (lines.length < 2) {
    return { mode: 'monthly', entry: null, employees: porEmpleado.size, ajusteCesantias: 0, ajusteIntereses: 0 };
  }

  const entry = await createDraftEntry(tenantId, {
    entryDate: fechaCorte, sourceType: 'payroll_provision_adjustment',
    description: `Ajuste anual de provisiones de cesantías e intereses ${anio}`,
    lines, createdBy: userId,
  }, t);
  return { mode: 'monthly', entry, employees: porEmpleado.size, ajusteCesantias: resumen.cesantias, ajusteIntereses: resumen.intereses_cesantias };
}

/**
 * Cierre anual según la configuración: causación (year_end) o ajuste de lo
 * provisionado (monthly).
 */
async function cierreAnualCesantias(tenantId, year, userId) {
  const anio = validarAnio(year);
  const t = await sequelize.transaction();
  try {
    const settings = await getSettings(tenantId, t);
    const result = settings.cesantias_accrual_mode === 'year_end'
      ? await causarCesantiasAnuales(tenantId, anio, userId, t)
      : await ajustarProvisionesAnuales(tenantId, anio, userId, t);
    await t.commit();
    return result;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * 3. Comprobantes de desembolso
 * ────────────────────────────────────────────────────────── */

async function cuentaBancaria(tenantId, bankAccountId, acc, t) {
  if (!bankAccountId) return { accountId: acc('payroll_payment_bank'), label: 'banco' };
  const { BankAccount } = models();
  const bank = await BankAccount.findOne({ where: { id: bankAccountId, tenant_id: tenantId, is_active: true }, transaction: t });
  if (!bank) throw new Error('Cuenta bancaria no encontrada o inactiva');
  return { accountId: bank.chart_of_account_id, label: `${bank.bank_name} ${bank.account_alias || bank.account_number}` };
}

async function lineasDePagosActivos(payments, t) {
  const { JournalEntryLine } = models();
  const ids = payments.map((p) => p.journal_entry_id).filter(Boolean);
  return ids.length ? JournalEntryLine.findAll({ where: { entry_id: ids }, transaction: t }) : [];
}

/**
 * Lo que se debe y lo que ya se pagó de un periodo, desde los asientos
 * (no desde los documentos): así una Nota de Ajuste posterior al pago deja
 * la diferencia como saldo pendiente (o a favor) sin tocar el pago.
 */
async function saldosPendientesPeriodo(tenantId, periodId, acc, t) {
  const { PayrollPayment } = models();
  const vouchers = await asientosVigentesDelPeriodo(tenantId, periodId, ['payroll', 'payroll_provisions'], t, true);
  const payments = await PayrollPayment.findAll({ where: { tenant_id: tenantId, payroll_period_id: periodId, status: 'active' }, transaction: t });
  const paymentLines = await lineasDePagosActivos(payments, t);

  const netAccount = acc('payroll_net_payable');
  const ssAccounts = new Set(SOCIAL_SECURITY_PAYABLE_KEYS.map((k) => acc(k)));
  const neto = new Map(); // employeeId -> { total, pagado }
  const ss = new Map(); // `${account}|${tercero}` -> { account_id, third_party_id, total, pagado }

  const bump = (map, id, init, field, amount) => {
    const cur = map.get(id) || { ...init, total: 0, pagado: 0 };
    cur[field] = round2(cur[field] + amount);
    map.set(id, cur);
  };

  for (const l of vouchers.flatMap((e) => e.lines)) {
    const amount = Number(l.credit) - Number(l.debit);
    if (l.account_id === netAccount && l.third_party_id) bump(neto, l.third_party_id, {}, 'total', amount);
    else if (ssAccounts.has(l.account_id)) bump(ss, `${l.account_id}|${l.third_party_id || ''}`, { account_id: l.account_id, third_party_id: l.third_party_id }, 'total', amount);
  }
  for (const l of paymentLines) {
    const amount = Number(l.debit) - Number(l.credit);
    if (l.account_id === netAccount && l.third_party_id) bump(neto, l.third_party_id, {}, 'pagado', amount);
    else if (ssAccounts.has(l.account_id)) bump(ss, `${l.account_id}|${l.third_party_id || ''}`, { account_id: l.account_id, third_party_id: l.third_party_id }, 'pagado', amount);
  }
  for (const map of [neto, ss]) {
    for (const cur of map.values()) cur.pendiente = round2(cur.total - cur.pagado);
  }

  return { hasVouchers: vouchers.length > 0, neto, ss, payments };
}

/**
 * Registra el pago de un periodo emitido y genera su comprobante. Paga el
 * saldo pendiente según los asientos (todo, o la diferencia que haya
 * dejado una Nota de Ajuste).
 *
 * @param {string} params.paymentType - 'net_pay' (neto a empleados) | 'social_security' (aportes a fondos)
 * @param {Array<string>} [params.employeeIds] - solo net_pay: limitar a estos empleados (default: todos los pendientes)
 */
async function registrarPago({ tenantId, periodId, paymentType, paymentDate, bankAccountId, reference, employeeIds, userId }) {
  const { PayrollPeriod, PayrollPayment, PayrollDocument, Employee } = models();
  if (!['net_pay', 'social_security'].includes(paymentType)) throw new Error('Tipo de pago inválido');
  if (!paymentDate) throw new Error('La fecha de pago es obligatoria');

  const t = await sequelize.transaction();
  try {
    const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!period) throw new Error('Periodo no encontrado');
    if (!['emitido', 'cerrado'].includes(period.status)) throw new Error('Solo se pueden registrar pagos de un periodo ya emitido');

    const acc = await cargarMapeos(tenantId, t);
    const saldos = await saldosPendientesPeriodo(tenantId, period.id, acc, t);
    if (!saldos.hasVouchers) throw new Error('El periodo no tiene comprobante de nómina -- genérelo primero.');

    const bank = await cuentaBancaria(tenantId, bankAccountId, acc, t);
    const rango = `${period.start_date} — ${period.end_date}`;
    const debitLines = [];
    let paidEmployeeIds = [];

    if (paymentType === 'net_pay') {
      const seleccion = Array.isArray(employeeIds) && employeeIds.length ? new Set(employeeIds) : null;
      const pendientes = [...saldos.neto.entries()].filter(([id, s]) => s.pendiente > 0.005 && (!seleccion || seleccion.has(id)));
      if (!pendientes.length) throw new Error('No hay neto pendiente de pago para los empleados seleccionados.');

      const employees = await Employee.findAll({ where: { tenant_id: tenantId, id: pendientes.map(([id]) => id) }, transaction: t });
      const byId = new Map(employees.map((e) => [e.id, e]));
      const netAccount = acc('payroll_net_payable');
      for (const [employeeId, s] of pendientes) {
        const emp = byId.get(employeeId);
        debitLines.push({
          account_id: netAccount, debit: s.pendiente, credit: 0,
          description: `Pago neto nómina${s.pagado > 0 ? ' (diferencia por ajuste)' : ''} — ${emp ? etiquetaEmpleado(emp) : employeeId}`,
          third_party_id: employeeId,
        });
      }
      paidEmployeeIds = pendientes.map(([id]) => id);
    } else {
      const pendientes = [...saldos.ss.values()].filter((s) => s.pendiente > 0.005);
      if (!pendientes.length) throw new Error('No hay aportes de seguridad social pendientes de pago en este periodo.');
      const fundNames = await nombresDeProveedores(tenantId, pendientes.map((f) => f.third_party_id), t);
      for (const f of pendientes) {
        debitLines.push({
          account_id: f.account_id, debit: f.pendiente, credit: 0,
          description: `Pago seguridad social ${rango} — ${f.third_party_id ? fundNames.get(f.third_party_id) || 'fondo' : 'sin fondo asignado'}`,
          third_party_id: f.third_party_id || null,
        });
      }
    }

    const total = round2(debitLines.reduce((s, l) => s + l.debit, 0));
    const payment = await PayrollPayment.create({
      tenant_id: tenantId,
      payroll_period_id: period.id,
      payment_type: paymentType,
      payment_date: paymentDate,
      bank_account_id: bankAccountId || null,
      amount: total,
      reference: reference || null,
      created_by: userId || null,
    }, { transaction: t });

    const titulo = paymentType === 'net_pay'
      ? `Pago de nómina ${rango} (${debitLines.length} empleado(s))`
      : `Pago de seguridad social ${rango}`;
    const entry = await createDraftEntry(tenantId, {
      branchId: period.branch_id,
      entryDate: paymentDate,
      sourceType: 'payroll_payment',
      sourceId: payment.id,
      description: `${titulo}${reference ? ` — Ref. ${reference}` : ''}`,
      lines: [...debitLines, { account_id: bank.accountId, debit: 0, credit: total, description: `${titulo} — ${bank.label}` }],
      createdBy: userId,
    }, t);
    await payment.update({ journal_entry_id: entry.id }, { transaction: t });

    if (paidEmployeeIds.length) {
      await PayrollDocument.update(
        { payment_id: payment.id },
        { where: { tenant_id: tenantId, payroll_period_id: period.id, employee_id: paidEmployeeIds, dian_status: 'accepted' }, transaction: t }
      );
    }

    await t.commit();
    return { payment, entry };
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

async function anularPago(tenantId, paymentId, userId, reason) {
  const { PayrollPayment, PayrollDocument } = models();
  const t = await sequelize.transaction();
  try {
    const payment = await PayrollPayment.findOne({ where: { id: paymentId, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!payment) throw new Error('Pago no encontrado');
    if (payment.status === 'voided') throw new Error('El pago ya está anulado');

    if (payment.journal_entry_id) {
      await reverseEntry(payment.journal_entry_id, tenantId, userId, reason || 'Pago de nómina anulado', t);
    }
    await PayrollDocument.update({ payment_id: null }, { where: { tenant_id: tenantId, payment_id: payment.id }, transaction: t });
    await payment.update({ status: 'voided' }, { transaction: t });

    await t.commit();
    return payment;
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * Consignación anual de cesantías al fondo
 * ────────────────────────────────────────────────────────── */

/**
 * Por empleado: saldo de cesantías por pagar al 31-dic del año (provisiones
 * o causación anual, menos lo ya pagado en liquidaciones), lo ya consignado
 * por ese año y lo pendiente. Los intereses no se consignan: se le pagan al
 * empleado en la nómina de enero (novedad "Cesantías e intereses"), y ese
 * comprobante ya los descuenta de la provisión.
 */
async function estadoCesantiasAnuales(tenantId, year, t = null) {
  const { JournalEntry, JournalEntryLine, PayrollPayment, Employee, BankAccount } = models();
  const anio = validarAnio(year);
  const acc = await cargarMapeos(tenantId, t);
  const cesAccount = acc('payroll_provision:cesantias');

  const saldos = await JournalEntryLine.findAll({
    attributes: ['third_party_id', [sequelize.literal('COALESCE(SUM("JournalEntryLine"."credit" - "JournalEntryLine"."debit"), 0)'), 'saldo']],
    include: [{
      model: JournalEntry, as: 'entry', attributes: [],
      where: { tenant_id: tenantId, status: { [Op.ne]: 'voided' }, entry_date: { [Op.lte]: `${anio}-12-31` } },
    }],
    where: { account_id: cesAccount, third_party_id: { [Op.ne]: null } },
    group: ['JournalEntryLine.third_party_id'],
    raw: true,
    transaction: t,
  });

  const payments = await PayrollPayment.findAll({
    where: { tenant_id: tenantId, payment_type: 'severance_fund', fiscal_year: anio },
    include: [{ model: BankAccount, as: 'bankAccount', attributes: ['bank_name', 'account_number', 'account_alias'] }],
    order: [['created_at', 'DESC']],
    transaction: t,
  });
  const activos = payments.filter((p) => p.status === 'active');
  const consignado = new Map();
  for (const l of await lineasDePagosActivos(activos, t)) {
    if (l.account_id !== cesAccount || !l.third_party_id) continue;
    consignado.set(l.third_party_id, round2((consignado.get(l.third_party_id) || 0) + Number(l.debit) - Number(l.credit)));
  }

  const ids = [...new Set([...saldos.map((r) => r.third_party_id), ...consignado.keys()])];
  const employees = ids.length ? await Employee.findAll({ where: { tenant_id: tenantId, id: ids }, transaction: t }) : [];
  const fundNames = await nombresDeProveedores(tenantId, employees.map((e) => e.severance_fund_supplier_id), t);
  const saldoPorEmpleado = new Map(saldos.map((r) => [r.third_party_id, round2(Number(r.saldo))]));

  const rows = employees.map((e) => {
    const saldoCorte = saldoPorEmpleado.get(e.id) || 0;
    const yaConsignado = consignado.get(e.id) || 0;
    return {
      employee_id: e.id,
      employee_name: nombreEmpleado(e),
      employee_document: e.document_number,
      fund_id: e.severance_fund_supplier_id || null,
      fund_name: e.severance_fund_supplier_id ? fundNames.get(e.severance_fund_supplier_id) || 'fondo' : null,
      saldo_corte: saldoCorte,
      consignado: yaConsignado,
      pendiente: round2(saldoCorte - yaConsignado),
    };
  }).filter((r) => Math.abs(r.saldo_corte) >= 0.01 || Math.abs(r.consignado) >= 0.01)
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  return {
    year: anio,
    employees: rows,
    totalPendiente: round2(rows.reduce((s, r) => s + Math.max(r.pendiente, 0), 0)),
    payments: payments.map((p) => ({
      id: p.id, payment_date: p.payment_date, amount: Number(p.amount), reference: p.reference, status: p.status,
      bank: p.bankAccount ? `${p.bankAccount.bank_name} ${p.bankAccount.account_alias || p.bankAccount.account_number}` : null,
    })),
  };
}

/**
 * Consigna las cesantías pendientes del año a los fondos: debita el pasivo
 * por empleado y acredita el banco con una línea por fondo (una
 * transferencia por fondo, como se paga en la práctica).
 */
async function consignarCesantias({ tenantId, year, paymentDate, bankAccountId, reference, employeeIds, userId }) {
  const { PayrollPayment } = models();
  const anio = validarAnio(year);
  if (!paymentDate) throw new Error('La fecha de consignación es obligatoria');

  const t = await sequelize.transaction();
  try {
    const estado = await estadoCesantiasAnuales(tenantId, anio, t);
    const seleccion = Array.isArray(employeeIds) && employeeIds.length ? new Set(employeeIds) : null;
    const pendientes = estado.employees.filter((r) => r.pendiente > 0.005 && (!seleccion || seleccion.has(r.employee_id)));
    if (!pendientes.length) throw new Error(`No hay cesantías de ${anio} pendientes de consignar para los empleados seleccionados.`);

    const sinFondo = pendientes.filter((r) => !r.fund_id);
    if (sinFondo.length) {
      throw new Error(`Asigne el fondo de cesantías en la ficha de: ${sinFondo.map((r) => r.employee_name).join(', ')}.`);
    }

    const acc = await cargarMapeos(tenantId, t);
    const bank = await cuentaBancaria(tenantId, bankAccountId, acc, t);
    const cesAccount = acc('payroll_provision:cesantias');

    const lines = [];
    const porFondo = new Map();
    for (const r of pendientes) {
      lines.push({
        account_id: cesAccount, debit: r.pendiente, credit: 0,
        description: `Consignación cesantías ${anio} — ${r.employee_name} (${r.employee_document}) — ${r.fund_name}`,
        third_party_id: r.employee_id,
      });
      const cur = porFondo.get(r.fund_id) || { name: r.fund_name, amount: 0 };
      cur.amount = round2(cur.amount + r.pendiente);
      porFondo.set(r.fund_id, cur);
    }
    for (const [fundId, f] of porFondo.entries()) {
      lines.push({ account_id: bank.accountId, debit: 0, credit: f.amount, description: `Consignación cesantías ${anio} — ${f.name} — ${bank.label}`, third_party_id: fundId });
    }

    const total = round2(pendientes.reduce((s, r) => s + r.pendiente, 0));
    const payment = await PayrollPayment.create({
      tenant_id: tenantId,
      payroll_period_id: null,
      fiscal_year: anio,
      payment_type: 'severance_fund',
      payment_date: paymentDate,
      bank_account_id: bankAccountId || null,
      amount: total,
      reference: reference || null,
      created_by: userId || null,
    }, { transaction: t });

    const entry = await createDraftEntry(tenantId, {
      entryDate: paymentDate,
      sourceType: 'payroll_payment',
      sourceId: payment.id,
      description: `Consignación de cesantías ${anio} a fondos (${pendientes.length} empleado(s))${reference ? ` — Ref. ${reference}` : ''}`,
      lines,
      createdBy: userId,
    }, t);
    await payment.update({ journal_entry_id: entry.id }, { transaction: t });

    await t.commit();
    return { payment, entry };
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * Resumen para la pantalla del periodo
 * ────────────────────────────────────────────────────────── */

async function resumenContablePeriodo(tenantId, periodId) {
  const { PayrollPeriod, PayrollPayment, PayrollDocument, Employee, BankAccount, JournalEntry } = models();
  const period = await PayrollPeriod.findOne({ where: { id: periodId, tenant_id: tenantId } });
  if (!period) throw new Error('Periodo no encontrado');

  const entries = await asientosVigentesDelPeriodo(tenantId, period.id, ['payroll', 'payroll_provisions'], null, true);
  const payments = await PayrollPayment.findAll({
    where: { tenant_id: tenantId, payroll_period_id: period.id },
    include: [{ model: BankAccount, as: 'bankAccount', attributes: ['id', 'bank_name', 'account_number', 'account_alias'] }],
    order: [['created_at', 'DESC']],
  });
  const docs = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, payroll_period_id: period.id, dian_status: 'accepted' },
    include: [
      { model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_number'] },
      includeAjustes(),
    ],
    order: [['created_at', 'ASC']],
  });

  let saldos = null;
  let mappingError = null;
  try {
    const acc = await cargarMapeos(tenantId, null);
    saldos = await saldosPendientesPeriodo(tenantId, period.id, acc, null);
  } catch (e) {
    mappingError = e.message;
  }

  const paymentEntryIds = payments.map((p) => p.journal_entry_id).filter(Boolean);
  const paymentEntries = paymentEntryIds.length
    ? await JournalEntry.findAll({ where: { id: paymentEntryIds, tenant_id: tenantId }, attributes: ['id', 'entry_number'] })
    : [];
  const entryNumber = new Map(paymentEntries.map((e) => [e.id, e.entry_number]));

  const documents = docs.map((d) => {
    const s = saldos?.neto.get(d.employee_id);
    const ultimaNota = (d.adjustments || []).filter((a) => a.dian_status === 'accepted')
      .sort((a, b) => new Date(b.dian_accepted_at || b.created_at) - new Date(a.dian_accepted_at || a.created_at))[0];
    return {
      id: d.id,
      employee_id: d.employee_id,
      employee_name: d.employee ? nombreEmpleado(d.employee) : '—',
      employee_document: d.employee?.document_number || null,
      adjustment: ultimaNota ? ultimaNota.adjustment_type : null,
      net: s ? s.total : 0,
      paid: s ? s.pagado : 0,
      pending: s ? s.pendiente : 0,
    };
  });

  const ssPendientes = saldos ? [...saldos.ss.values()] : [];
  return {
    period: { id: period.id, status: period.status },
    mappingError,
    entries: entries.map((e) => ({
      id: e.id, entry_number: e.entry_number, source_type: e.source_type, status: e.status,
      entry_date: e.entry_date, description: e.description, total: Number(e.total_debit), line_count: e.lines.length,
    })),
    payments: payments.map((p) => ({
      id: p.id, payment_type: p.payment_type, payment_date: p.payment_date, amount: Number(p.amount),
      reference: p.reference, status: p.status, entry_number: entryNumber.get(p.journal_entry_id) || null,
      bank: p.bankAccount ? `${p.bankAccount.bank_name} ${p.bankAccount.account_alias || p.bankAccount.account_number}` : null,
    })),
    documents,
    pendingSocialSecurity: round2(ssPendientes.reduce((s, f) => s + Math.max(f.pendiente, 0), 0)),
    paidSocialSecurity: round2(ssPendientes.reduce((s, f) => s + f.pagado, 0)),
  };
}

module.exports = {
  APORTES_EMPLEADOR,
  ARL_TARIFAS,
  basesDeLiquidacion,
  calcularAportesYProvisiones,
  desglosarDevengados,
  liquidacionVigente,
  generarComprobantesNomina,
  regenerarComprobantesPeriodo,
  liquidacionesAceptadasDelPeriodo,
  cierreAnualCesantias,
  estadoCesantiasAnuales,
  consignarCesantias,
  registrarPago,
  anularPago,
  resumenContablePeriodo,
};
