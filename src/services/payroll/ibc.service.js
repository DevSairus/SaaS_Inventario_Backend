// backend/src/services/payroll/ibc.service.js
//
// Ingreso Base de Cotización de un periodo de nómina. Antes era solo
// sueldo + comisiones; por ley (Art. 127 CST, Ley 100/1993 Art. 18 y 204,
// Ley 1393/2010 Art. 30) integra todo pago salarial:
//   - salario de los días efectivamente laborados (70% si es integral),
//   - horas extra y recargos, comisiones, bonificaciones/auxilios/otros
//     conceptos salariales, compensaciones ordinarias, bonos salariales,
//   - lo pagado por incapacidades, licencias remuneradas (incluida
//     maternidad/paternidad) y vacaciones disfrutadas,
//   - el exceso de los pagos NO salariales sobre el 40% de la remuneración
//     total (Ley 1393).
// No integran: auxilio de transporte, vacaciones compensadas, primas,
// cesantías, indemnizaciones, dotación, auxilio de conectividad.
// Mínimo 1 SMLMV proporcional a los días cotizados (salvo aprendices) y
// máximo 25 SMLMV.
//
// Lo usan payrollService.liquidarEmpleado (deducciones del empleado),
// payrollAccountingService (aportes del empleador) y la PILA -- el mismo
// IBC en los tres.

const HORAS_KEYS = ['heds', 'hens', 'hrns', 'heddfs', 'hrddfs', 'hendfs', 'hrndfs'];
const TOPE_IBC_SMLMV = 25;
const FACTOR_INTEGRAL = 0.7;
// Códigos de tipo de cotizante (tabla 5.5.3 DIAN = tipo de cotizante PILA).
const APRENDICES = ['12', '19'];

const num = (v) => Number(v) || 0;
const list = (v) => (Array.isArray(v) ? v.flat(Infinity) : (v ? [v] : []));
const sumField = (items, field) => list(items).reduce((s, it) => s + num(it?.[field]), 0);

/**
 * @param {object} p
 * @param {object} p.employee
 * @param {object} p.devengados - liquidation.devengados (con basico ya calculado)
 * @param {number} p.diasPeriodo - días comerciales del periodo
 * @param {number} p.smlmv
 * @returns {{ ibc, salario, variables, ausencias, exceso40, noSalarial, diasLaborados, diasAusencia, diasCotizados, vst }}
 */
function calcularIBC({ employee, devengados = {}, diasPeriodo = 30, smlmv }) {
  const salarioDia = num(employee.base_salary) / 30;
  const diasTrabajados = num(devengados.basico?.diasTrabajados);
  const aprendiz = APRENDICES.includes(String(employee.worker_type));

  // Ausencias pagadas (cuentan como días cotizados con su propio valor) y
  // licencias no remuneradas (no cuentan).
  const incap = list(devengados.incapacidades);
  const vacComunes = list(devengados.vacaciones?.comunes);
  const licMP = list(devengados.licencias?.maternidadPaternidad);
  const licR = list(devengados.licencias?.remunerada);
  const licNR = list(devengados.licencias?.noRemunerada);
  const pagadas = [...incap, ...vacComunes, ...licMP, ...licR];
  const diasAusencia = sumField(pagadas, 'cantidad');
  const diasNR = sumField(licNR, 'cantidad');
  const ausencias = sumField(pagadas, 'pago');

  // Si al registrar la ausencia no se descontaron esos días del básico
  // (días no remunerados), el básico los está pagando además de la
  // incapacidad/vacación: para el IBC esos días se toman una sola vez, con
  // el valor de la ausencia.
  const traslape = Math.max(0, diasTrabajados + diasAusencia + diasNR - diasPeriodo);
  const diasLaborados = Math.max(0, diasTrabajados - traslape);
  let salario = salarioDia * diasLaborados;

  let variables = 0;
  for (const k of HORAS_KEYS) variables += sumField(devengados[k], 'pago');
  variables += list(devengados.comisiones).reduce((s, v) => s + num(typeof v === 'object' ? v?.comision : v), 0);
  variables += sumField(devengados.bonificaciones, 'bonificacionS');
  variables += sumField(devengados.auxilios, 'auxilioS');
  variables += sumField(devengados.otrosConceptos, 'conceptoS');
  variables += sumField(devengados.compensaciones, 'compensacionO');
  variables += sumField(devengados.bonoEPCTVs, 'pagoS') + sumField(devengados.bonoEPCTVs, 'pagoAlimentacionS');

  const noSalarial = sumField(devengados.bonificaciones, 'bonificacionNS')
    + sumField(devengados.auxilios, 'auxilioNS')
    + sumField(devengados.otrosConceptos, 'conceptoNS')
    + sumField(devengados.compensaciones, 'compensacionE')
    + sumField(devengados.bonoEPCTVs, 'pagoNS')
    + sumField(devengados.bonoEPCTVs, 'pagoAlimentacionNS');

  if (employee.salary_type === 'integral') {
    salario *= FACTOR_INTEGRAL;
    variables *= FACTOR_INTEGRAL;
  }
  // Aprendices: la base es el apoyo de sostenimiento.
  if (aprendiz) salario += num(devengados.apoyoSost);

  const base = salario + variables + ausencias;
  const exceso40 = Math.max(0, noSalarial - 0.4 * (base + noSalarial));
  let ibc = base + exceso40;

  const diasCotizados = Math.min(diasPeriodo, diasLaborados + diasAusencia);
  if (!aprendiz && diasCotizados > 0) ibc = Math.max(ibc, (smlmv / 30) * diasCotizados);
  ibc = Math.min(ibc, ((smlmv * TOPE_IBC_SMLMV) / 30) * diasPeriodo);

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    ibc: r2(ibc),
    salario: r2(salario),
    variables: r2(variables),
    ausencias: r2(ausencias),
    exceso40: r2(exceso40),
    noSalarial: r2(noSalarial),
    diasLaborados,
    diasAusencia,
    diasCotizados,
    traslape,
    // Variación transitoria de salario (novedad VST de la PILA).
    vst: variables > 0 || exceso40 > 0,
  };
}

module.exports = { calcularIBC, APRENDICES };
