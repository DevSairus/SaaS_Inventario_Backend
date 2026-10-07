// backend/src/services/payroll/pila/pilaCalc.js
//
// Cálculo de los registros tipo 02 de un cotizante en la PILA a partir de
// las liquidaciones de nómina del mes. Función pura -- pila.service.js carga
// los datos.
//
// Una línea por novedad (Resolución 2388 de 2016): cada incapacidad,
// licencia, vacación o licencia no remunerada va en su propia línea con sus
// días, fechas e IBC, y los días normales en otra. Qué subsistemas cotizan
// en cada línea:
//
//                         Pensión   Salud     ARL   Caja/SENA/ICBF
//   Días normales           sí       sí       sí        sí
//   IGE, IRL, LMA           sí       sí       no        no
//   VAC, licencia remun.    sí       sí       no        sí
//   SLN                     12%*     0%       no        no
//   (* solo la parte del empleador: 12%, o 22% en alto riesgo)
//
// IBC de cada línea: el valor pagado por la novedad (incapacidad,
// vacaciones, licencia); el salario proporcional para la SLN; el resto del
// IBC del mes para los días normales. Mínimo 1 SMLMV proporcional a los días
// de la línea (salvo aprendices), máximo 25 SMLMV; redondeado al peso
// superior. Cotizaciones: IBC x tarifa al múltiplo de 100 superior
// (Decreto 1990 de 2016). Salud 4% con exoneración (Art. 114-1 E.T.), si no
// 12,5%; aprendices 12,5%. Pensión 16% (26% alto riesgo). SENA 2% e ICBF 3%
// solo sin exoneración. Caja 4%. Aprendiz en etapa lectiva (12): solo salud;
// productiva (19): salud y ARL. Pensionado: no cotiza pensión.

const { weeklyHoursFor } = require('../jornada');

const ARL_TARIFAS = { 1: 0.00522, 2: 0.01044, 3: 0.02436, 4: 0.0435, 5: 0.0696 };
const FSP_TRAMOS = [
  { desde: 4, hasta: 16, pct: 0.01 }, { desde: 16, hasta: 17, pct: 0.012 }, { desde: 17, hasta: 18, pct: 0.014 },
  { desde: 18, hasta: 19, pct: 0.016 }, { desde: 19, hasta: 20, pct: 0.018 }, { desde: 20, hasta: Infinity, pct: 0.02 },
];
const DOC_TYPES = { 13: 'CC', 22: 'CE', 21: 'CE', 12: 'TI', 11: 'RC', 41: 'PA', 42: 'PA', 47: 'PE', 48: 'PT' };
const SUBTIPOS_PENSIONADO = ['01', '03', '04', '05', '06'];

// Subsistemas que cotizan en cada tipo de línea.
const COTIZA = {
  normal: { afp: true, eps: true, arl: true, ccf: true },
  IGE: { afp: true, eps: true, arl: false, ccf: false },
  IRL: { afp: true, eps: true, arl: false, ccf: false },
  LMA: { afp: true, eps: true, arl: false, ccf: false },
  VAC: { afp: true, eps: true, arl: false, ccf: true },
  LR: { afp: true, eps: true, arl: false, ccf: true },
  SLN: { afp: true, eps: true, arl: false, ccf: false },
};
const ORDEN = ['normal', 'IGE', 'IRL', 'LMA', 'VAC', 'LR', 'SLN'];

const ceil100 = (n) => (n > 0 ? Math.ceil(Math.round(n * 100) / 100 / 100) * 100 : 0);
const ceilPeso = (n) => Math.ceil(Math.round((Number(n) || 0) * 100) / 100);
const list = (v) => (Array.isArray(v) ? v.flat(Infinity) : (v ? [v] : []));
const iso = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

// Días comerciales (mes de 30) entre dos fechas ISO inclusive.
function diasComerciales(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number);
  const [y2, m2, d2] = hasta.split('-').map(Number);
  const a = Math.min(d1, 30);
  const b = d2 === 31 || (m2 === 2 && d2 >= 28 && new Date(Date.UTC(y2, 2, 0)).getUTCDate() === d2) ? 30 : d2;
  return Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (b - a) + 1);
}

const clampFecha = (f, min, max) => (f ? (f < min ? min : (f > max ? max : f)) : null);

/**
 * @param {object} p
 * @param {object} p.employee - Employee (plano)
 * @param {Array<object>} p.liquidations - liquidaciones vigentes del mes (snapshot_liquidation)
 * @param {number} p.unpaidDays - días no remunerados registrados como novedad (sin fechas)
 * @param {{year:number, month:number}} p.period
 * @param {object} p.settings - PayrollSetting (plano)
 * @param {{eps?:string, afp?:string, ccf?:string, arl?:string}} p.codes - códigos PILA de las administradoras
 * @param {number} p.smlmv
 * @param {string} [p.defaultCityCode] - DIVIPOLA del empleador, si el empleado no tiene ciudad de trabajo
 * @param {function} [p.ibcFallback] - IBC de una liquidación sin desglose (anteriores a ibc.service.js)
 * @returns {{ lines: object[], fields: object, warnings: string[], summary: object }}
 *   `lines`: un registro 02 por línea (sin secuencia); `fields` = la primera.
 */
function computeCotizante({ employee: e, liquidations, unpaidDays = 0, period, settings = {}, codes = {}, smlmv, defaultCityCode, ibcFallback }) {
  const warnings = [];
  const mm = String(period.month).padStart(2, '0');
  const mesInicio = `${period.year}-${mm}-01`;
  const mesFin = `${period.year}-${mm}-${String(new Date(Date.UTC(period.year, period.month, 0)).getUTCDate()).padStart(2, '0')}`;
  const fx = (f) => clampFecha(iso(f), mesInicio, mesFin);

  const tipoCotizante = String(e.worker_type || '01').padStart(2, '0');
  const subtipo = String(e.worker_subtype || '00').padStart(2, '0');
  const lectiva = ['12', '03'].includes(tipoCotizante);
  const productiva = ['19', '04'].includes(tipoCotizante);
  const aprendiz = lectiva || productiva;
  const pensionado = SUBTIPOS_PENSIONADO.includes(subtipo);
  const tipoCotizantePila = { '03': '12', '04': '19' }[tipoCotizante] || tipoCotizante;
  const salarioDia = Number(e.base_salary || 0) / 30;

  // ── Días de vinculación en el mes ──
  const hire = iso(e.hire_date);
  const term = iso(e.termination_date);
  const desde = hire && hire > mesInicio ? hire : mesInicio;
  const hasta = term && term < mesFin ? term : mesFin;
  const diasEmpleo = hasta >= desde ? Math.min(30, diasComerciales(desde, hasta)) : 0;

  // ── Novedades con fechas -> segmentos ──
  const dev = (k) => liquidations.flatMap((l) => list(l?.devengados?.[k]));
  const devSub = (k, sub) => liquidations.flatMap((l) => list(l?.devengados?.[k]?.[sub]));
  const incap = dev('incapacidades');
  const segmentos = [
    ...incap.filter((i) => String(i.tipo || '1') === '1').map((i) => ({ ...i, tipo: 'IGE' })),
    ...incap.filter((i) => String(i.tipo || '1') !== '1').map((i) => ({ ...i, tipo: 'IRL' })),
    ...devSub('licencias', 'maternidadPaternidad').map((i) => ({ ...i, tipo: 'LMA' })),
    ...devSub('vacaciones', 'comunes').map((i) => ({ ...i, tipo: 'VAC' })),
    ...devSub('licencias', 'remunerada').map((i) => ({ ...i, tipo: 'LR' })),
    ...devSub('licencias', 'noRemunerada').map((i) => ({ ...i, tipo: 'SLN', pago: 0 })),
  ]
    .map((s) => ({ tipo: s.tipo, inicio: fx(s.fechaInicio), fin: fx(s.fechaFin), dias: Math.max(0, Math.round(Number(s.cantidad) || 0)), pago: Number(s.pago) || 0 }))
    .filter((s) => s.dias > 0)
    .sort((a, b) => (a.inicio || '9').localeCompare(b.inicio || '9') || ORDEN.indexOf(a.tipo) - ORDEN.indexOf(b.tipo));
  if (Number(unpaidDays) > 0) {
    segmentos.push({ tipo: 'SLN', inicio: null, fin: null, dias: Math.round(Number(unpaidDays)), pago: 0 });
    warnings.push(`Tiene ${Math.round(Number(unpaidDays))} día(s) no remunerados sin fechas: complete las fechas de la licencia (SLN) en el operador.`);
  }
  // Los días de las novedades no pueden pasar de los días de vinculación.
  let restante = diasEmpleo;
  for (const s of segmentos) {
    s.dias = Math.min(s.dias, restante);
    restante -= s.dias;
  }
  const novedades = segmentos.filter((s) => s.dias > 0);
  const diasNormal = restante;
  if (novedades.some((s) => s.tipo === 'SLN')) {
    warnings.push('Licencia no remunerada: se reporta con pensión al 12% (solo empleador), salud al 0% y sin ARL ni caja. Verifíquelo con el operador.');
  }

  // ── IBC por línea ──
  const ibcMes = liquidations.reduce((s, l) => s + (l?.ibc?.ibc != null ? Number(l.ibc.ibc) : (ibcFallback ? ibcFallback(l) : 0)), 0);
  const pagosNovedades = novedades.reduce((s, n) => s + n.pago, 0);
  const pisoYTope = (ibc, dias) => {
    let v = ceilPeso(ibc);
    if (!aprendiz && dias > 0) v = Math.max(v, ceilPeso((smlmv * dias) / 30));
    v = Math.min(v, ceilPeso((smlmv * 25 * dias) / 30));
    return dias > 0 ? v : 0;
  };
  const ibcNovedad = (n) => pisoYTope(n.tipo === 'SLN' || !n.pago ? salarioDia * n.dias : n.pago, n.dias);
  const ibcNormal = pisoYTope(Math.max(0, ibcMes - pagosNovedades), diasNormal);
  const vst = liquidations.some((l) => l?.ibc?.vst);

  // ── Tarifas comunes ──
  const exonerado = !!settings.employer_exonerated_114_1 && !aprendiz && Number(e.base_salary || 0) < 10 * smlmv;
  const cotizaAfp = !aprendiz && !pensionado;
  const tarifaEpsBase = aprendiz ? 0.125 : (exonerado ? 0.04 : 0.125);
  const tarifaArlBase = Number(e.arl_rate) > 0 ? Number(e.arl_rate) : ARL_TARIFAS[Number(e.arl_risk_class) || 1];
  const ibcAfpMes = cotizaAfp ? ibcNormal + novedades.reduce((s, n) => s + ibcNovedad(n), 0) : 0;
  const tramoFsp = FSP_TRAMOS.find((t) => ibcAfpMes / smlmv >= t.desde && ibcAfpMes / smlmv < t.hasta);

  // ── Datos fijos del cotizante ──
  const city = String(e.work_city_code || e.city_code || defaultCityCode || '').replace(/\D/g, '');
  const actividad = String(e.arl_economic_activity || settings.arl_economic_activity || '').replace(/\D/g, '');
  const weekly = weeklyHoursFor(mesFin, settings.weekly_hours);
  const base = {
    tipoDoc: DOC_TYPES[e.document_type] || 'CC',
    documento: String(e.document_number || '').replace(/\s/g, ''),
    tipoCotizante: tipoCotizantePila,
    subtipoCotizante: subtipo,
    departamento: city.slice(0, 2),
    municipio: city.slice(2, 5),
    primerApellido: String(e.first_surname || '').toUpperCase(),
    segundoApellido: String(e.second_surname || '').toUpperCase(),
    primerNombre: String(e.first_name || '').toUpperCase(),
    segundoNombre: String(e.other_names || '').toUpperCase(),
    salarioBasico: Math.round(Number(e.base_salary || 0)),
    salarioIntegral: e.salary_type === 'integral' ? 'X' : 'F',
    avpAfiliado: 0, avpAportante: 0, valorNoRetenido: 0, valorUpc: 0, valorIge: 0, valorLma: 0,
    tarifaEsap: 0, aporteEsap: 0, tarifaMen: 0, aporteMen: 0,
    exonerado: exonerado ? 'S' : 'N',
    irl: 0,
  };

  // Una línea: `tipo` define qué subsistemas cotizan; `dias` e `ibc` los de la línea.
  const linea = (tipo, dias, ibc, extra = {}) => {
    const c = COTIZA[tipo];
    const diasAfp = c.afp && cotizaAfp ? dias : 0;
    const diasEps = c.eps ? dias : 0;
    const diasArl = c.arl && !lectiva ? dias : 0;
    const diasCcf = c.ccf && !aprendiz ? dias : 0;
    const sln = tipo === 'SLN';
    const tarifaAfp = diasAfp > 0 ? (sln ? (e.high_risk_pension ? 0.22 : 0.12) : (e.high_risk_pension ? 0.26 : 0.16)) : 0;
    const tarifaEps = sln ? 0 : tarifaEpsBase;
    const tarifaArl = diasArl > 0 ? tarifaArlBase : 0;
    const tarifaCcf = diasCcf > 0 ? 0.04 : 0;
    const parafiscales = !exonerado && !aprendiz && diasCcf > 0;
    const ibcAfp = diasAfp > 0 ? ibc : 0;
    const ibcArl = diasArl > 0 ? ibc : 0;
    const ibcCcf = diasCcf > 0 ? ibc : 0;
    const cotizacionAfp = ceil100(ibcAfp * tarifaAfp);
    const fsp = tramoFsp && ibcAfp > 0 && !sln ? ceil100(ibcAfp * 0.005) : 0;
    const fsps = tramoFsp && ibcAfp > 0 && !sln ? ceil100(ibcAfp * (tramoFsp.pct - 0.005)) : 0;
    return {
      ...base,
      afp: diasAfp > 0 ? (codes.afp || '') : '',
      eps: codes.eps || '',
      ccf: diasCcf > 0 ? (codes.ccf || '') : '',
      diasAfp, diasEps, diasArl, diasCcf,
      ibcAfp, ibcEps: diasEps > 0 ? ibc : 0, ibcArl, ibcCcf,
      tarifaAfp, cotizacionAfp, totalAfp: cotizacionAfp, fsp, fsps,
      tarifaEps, cotizacionEps: ceil100((diasEps > 0 ? ibc : 0) * tarifaEps),
      tarifaArl,
      centroTrabajo: diasArl > 0 ? (String(e.pila_work_center || '0').replace(/\D/g, '') || '0') : '0',
      cotizacionArl: ceil100(ibcArl * tarifaArl),
      tarifaCcf, aporteCcf: ceil100(ibcCcf * tarifaCcf),
      tarifaSena: parafiscales ? 0.02 : 0, aporteSena: parafiscales ? ceil100(ibc * 0.02) : 0,
      tarifaIcbf: parafiscales ? 0.03 : 0, aporteIcbf: parafiscales ? ceil100(ibc * 0.03) : 0,
      codigoArl: diasArl > 0 ? (codes.arl || '') : '',
      claseRiesgo: diasArl > 0 ? (Number(e.arl_risk_class) || 1) : 0,
      tarifaEspecialPension: e.high_risk_pension && diasAfp > 0 ? '1' : '',
      ibcOtrosParafiscales: parafiscales ? ibc : 0,
      horasLaboradas: diasArl > 0 ? Math.round((diasArl * weekly) / 6) : 0,
      actividadArl: diasArl > 0 ? actividad : '0',
      ...extra,
    };
  };

  const lines = [];
  if (diasNormal > 0 || !novedades.length) lines.push(linea('normal', diasNormal, ibcNormal));
  for (const n of novedades) {
    const ibc = ibcNovedad(n);
    const fechas = { inicio: n.inicio, fin: n.fin };
    if (n.tipo === 'IGE') lines.push(linea('IGE', n.dias, ibc, { ige: 'X', fechaIgeInicio: fechas.inicio, fechaIgeFin: fechas.fin }));
    if (n.tipo === 'IRL') lines.push(linea('IRL', n.dias, ibc, { irl: n.dias, fechaIrlInicio: fechas.inicio, fechaIrlFin: fechas.fin }));
    if (n.tipo === 'LMA') lines.push(linea('LMA', n.dias, ibc, { lma: 'X', fechaLmaInicio: fechas.inicio, fechaLmaFin: fechas.fin }));
    if (n.tipo === 'VAC') lines.push(linea('VAC', n.dias, ibc, { vacLr: 'X', fechaVacInicio: fechas.inicio, fechaVacFin: fechas.fin }));
    if (n.tipo === 'LR') lines.push(linea('LR', n.dias, ibc, { vacLr: 'L', fechaVacInicio: fechas.inicio, fechaVacFin: fechas.fin }));
    if (n.tipo === 'SLN') lines.push(linea('SLN', n.dias, ibc, { sln: 'X', fechaSlnInicio: fechas.inicio, fechaSlnFin: fechas.fin }));
    if (n.tipo !== 'SLN' && (!n.inicio || !n.fin)) warnings.push(`Una novedad ${n.tipo} no tiene fechas: el operador las exige.`);
  }

  // Ingreso, retiro y variación transitoria van en la primera línea.
  const fechaEnMes = (f) => f && f >= mesInicio && f <= mesFin;
  if (fechaEnMes(hire)) Object.assign(lines[0], { ing: 'X', fechaIng: hire });
  if (fechaEnMes(term)) Object.assign(lines[0], { ret: 'X', fechaRet: term });
  if (vst) lines[0].vst = 'X';

  // ── Avisos de datos faltantes ──
  const algunaArl = lines.some((l) => l.diasArl > 0);
  if (city.length !== 5) warnings.push('Falta la ciudad de trabajo (código DIVIPOLA) del empleado.');
  if (!codes.eps) warnings.push('Falta el código PILA de la EPS (Proveedores → código PILA).');
  if (lines.some((l) => l.diasAfp > 0) && !codes.afp) warnings.push('Falta el código PILA del fondo de pensión.');
  if (lines.some((l) => l.diasCcf > 0) && !codes.ccf) warnings.push('Falta el código PILA de la caja de compensación.');
  if (algunaArl && actividad.length !== 7) warnings.push('Falta la actividad económica ARL (7 dígitos) del empleado o de la empresa.');
  if (algunaArl && !(Number(e.pila_work_center) > 0)) warnings.push('Falta el centro de trabajo ARL del empleado.');
  if (!DOC_TYPES[e.document_type]) warnings.push(`Tipo de documento ${e.document_type} sin equivalente en PILA.`);
  if (['21', '42'].includes(String(e.document_type))) warnings.push('Tipo de documento aproximado en PILA (CE/PA): verifíquelo.');

  // ── Totales del cotizante ──
  const sum = (k) => lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const summary = {
    lineas: lines.length,
    ibc: sum('ibcEps'),
    dias: sum('diasEps'),
    salud: sum('cotizacionEps'),
    pension: sum('cotizacionAfp') + sum('fsp') + sum('fsps'),
    arl: sum('cotizacionArl'),
    ccf: sum('aporteCcf'),
    sena: sum('aporteSena'),
    icbf: sum('aporteIcbf'),
    novedades: [...new Set(lines.flatMap((l) => ['ing', 'ret', 'vst', 'sln', 'ige', 'lma', 'vacLr'].filter((k) => l[k]).concat(l.irl > 0 ? ['irl'] : [])))],
  };
  summary.total = summary.salud + summary.pension + summary.arl + summary.ccf + summary.sena + summary.icbf;
  return { lines, fields: lines[0], warnings, summary };
}

module.exports = { computeCotizante, diasComerciales, ARL_TARIFAS, DOC_TYPES };
