// backend/src/services/payroll/pila/pilaFieldCatalog.js
//
// Nombre visible y variantes de encabezado de cada campo de la PILA (los
// mismos de pilaLayout.js), para reconocer las columnas de un Excel de
// muestra (pilaExcel.service.js). `label` es el encabezado del Excel
// estándar que exportan los operadores; `aliases`, otras formas comunes.

const R1_LABELS = {
  tipoRegistro: ['Tipo de registro'],
  modalidad: ['Modalidad de la Planilla', 'modalidad'],
  secuencia: ['Secuencia'],
  razonSocial: ['Nombre o Razón Social del Aportante', 'razon social', 'nombre aportante', 'aportante', 'empresa'],
  tipoDoc: ['Tipo Documento', 'tipo documento aportante', 'tipo de documento'],
  nit: ['Nº de Identificación', 'nit', 'numero de identificacion aportante', 'identificacion aportante', 'numero identificacion'],
  dv: ['Digito de Verificación', 'dv', 'digito verificacion'],
  tipoPlanilla: ['Tipo Planilla', 'tipo de planilla'],
  planillaAsociada: ['Número Planilla Asociada a esta planilla', 'planilla asociada'],
  fechaPlanillaAsociada: ['Fecha de Pago Planilla Asociada a esta planilla', 'fecha planilla asociada'],
  formaPresentacion: ['Forma Presentación', 'forma de presentacion'],
  codigoSucursal: ['Código Sucursal Aportante', 'codigo sucursal'],
  nombreSucursal: ['Nombre Sucursal'],
  codigoArl: ['Código ARL', 'arl', 'codigo administradora riesgos'],
  periodoPension: ['Periodo Pago a Sistemas Diferentes a Salud', 'periodo pension', 'periodo de pago pension'],
  periodoSalud: ['Periodo Pago al Sistema de Salud', 'periodo salud', 'periodo de pago salud'],
  numeroRadicacion: ['Número  de Planilla', 'numero planilla', 'numero de radicacion'],
  fechaPago: ['Fecha de Pago'],
  numeroCotizantes: ['Número total de cotizantes', 'total cotizantes', 'numero de empleados', 'total empleados'],
  valorNomina: ['Valor Total Nómina', 'total nomina', 'valor nomina'],
  tipoAportante: ['Tipo de Aportante'],
  codigoOperador: ['Código del Operador de Información', 'operador', 'codigo operador'],
};

const R2_LABELS = {
  tipoRegistro: ['Tipo de registro'],
  secuencia: ['Secuencia', 'consecutivo', 'no', 'item'],
  tipoDoc: ['Tipo documento cotizante', 'tipo documento', 'tipo de documento', 'tipo identificacion', 'tipo doc'],
  documento: ['Documento cotizante', 'numero de identificacion', 'numero documento', 'documento', 'identificacion', 'cedula', 'numero identificacion cotizante'],
  tipoCotizante: ['Tipo de cotizante', 'tipo cotizante'],
  subtipoCotizante: ['Subtipo de cotizante', 'subtipo cotizante'],
  extranjero: ['Extranjero', 'extranjero no obligado a cotizar pension'],
  colombianoExterior: ['Colombiano en el exterior'],
  departamento: ['Departamento', 'codigo departamento', 'departamento ubicacion laboral'],
  municipio: ['Municipio', 'codigo municipio', 'municipio ubicacion laboral', 'ciudad'],
  primerApellido: ['Primer apellido', 'apellido 1'],
  segundoApellido: ['Segundo apellido', 'apellido 2'],
  primerNombre: ['Primer nombre', 'nombre 1'],
  segundoNombre: ['Segundo nombre', 'nombre 2', 'otros nombres'],
  ing: ['ING', 'ingreso'],
  ret: ['RET', 'retiro'],
  tde: ['TDE'], tae: ['TAE'], tdp: ['TDP'], tap: ['TAP'],
  vsp: ['VSP', 'variacion permanente de salario'],
  correcciones: ['Línea', 'correcciones', 'correccion'],
  vst: ['VST', 'variacion transitoria de salario'],
  sln: ['SLN', 'suspension temporal', 'licencia no remunerada'],
  ige: ['IGE', 'incapacidad general'],
  lma: ['LMA', 'licencia de maternidad'],
  vacLr: ['VAC-LR', 'vacaciones', 'vac lr'],
  avp: ['AVP', 'aporte voluntario'],
  vct: ['VCT', 'variacion centros de trabajo'],
  irl: ['IRL', 'dias incapacidad riesgos laborales'],
  afp: ['AFP', 'codigo afp', 'codigo administradora pension', 'administradora pension', 'fondo de pension', 'codigo pension'],
  afpTraslado: ['AFP Traslado', 'afp a la que se traslada'],
  eps: ['EPS', 'codigo eps', 'codigo administradora salud', 'administradora salud'],
  epsTraslado: ['EPS Traslado', 'eps a la que se traslada'],
  ccf: ['CCF', 'codigo ccf', 'caja de compensacion', 'codigo caja', 'caja'],
  diasAfp: ['Días AFP', 'dias pension', 'dias cotizados pension'],
  diasEps: ['Días EPS', 'dias salud', 'dias cotizados salud'],
  diasArl: ['Días ARL', 'dias riesgos', 'dias cotizados riesgos'],
  diasCcf: ['Días CCF', 'dias caja', 'dias cotizados caja'],
  salarioBasico: ['Salario básico', 'salario', 'sueldo', 'salario basico'],
  salarioIntegral: ['Salario integral', 'tipo de salario'],
  ibcAfp: ['IBC AFP', 'ibc pension'],
  ibcEps: ['IBC EPS', 'ibc salud'],
  ibcArl: ['IBC ARL', 'ibc riesgos'],
  ibcCcf: ['IBC CCF', 'ibc caja'],
  tarifaAfp: ['Tarifa AFP', 'tarifa pension'],
  cotizacionAfp: ['Cotización AFP', 'cotizacion pension', 'aporte pension', 'valor pension'],
  avpAfiliado: ['AVP afiliado', 'aporte voluntario afiliado'],
  avpAportante: ['AVP aportante', 'aporte voluntario aportante'],
  totalAfp: ['Total AFP', 'total pension', 'total cotizacion pension'],
  fsp: ['Aporte FSP', 'fondo solidaridad pensional', 'fsp solidaridad'],
  fsps: ['Aporte FSPS', 'fondo de subsistencia', 'fsp subsistencia'],
  valorNoRetenido: ['Valor no retenido', 'valor no retenido aportes voluntarios'],
  tarifaEps: ['Tarifa EPS', 'tarifa salud'],
  cotizacionEps: ['Cotización EPS', 'cotizacion salud', 'aporte salud', 'valor salud'],
  valorUpc: ['Valor UPC', 'upc adicional'],
  autorizacionIge: ['Número IGE', 'autorizacion incapacidad'],
  valorIge: ['Valor IGE', 'valor incapacidad'],
  autorizacionLma: ['Número LMA', 'autorizacion licencia maternidad'],
  valorLma: ['Valor LMA', 'valor licencia maternidad'],
  tarifaArl: ['Tarifa ARL', 'tarifa riesgos'],
  centroTrabajo: ['Centro de trabajo', 'centro trabajo'],
  cotizacionArl: ['Cotización ARL', 'cotizacion riesgos', 'aporte arl', 'valor arl', 'aporte riesgos'],
  tarifaCcf: ['Tarifa CCF', 'tarifa caja'],
  aporteCcf: ['Aporte CCF', 'aporte caja', 'valor caja', 'valor ccf'],
  tarifaSena: ['Tarifa SENA'],
  aporteSena: ['Aporte SENA', 'valor sena'],
  tarifaIcbf: ['Tarifa ICBF'],
  aporteIcbf: ['Aporte ICBF', 'valor icbf'],
  tarifaEsap: ['Tarifa ESAP'],
  aporteEsap: ['Aporte ESAP', 'valor esap'],
  tarifaMen: ['Tarifa MEN'],
  aporteMen: ['Aporte MEN', 'valor men'],
  tipoDocUpc: ['Tipo documento UPC', 'tipo documento cotizante principal'],
  documentoUpc: ['Documento UPC', 'documento cotizante principal'],
  exonerado: ['Exonerado', 'exonerado de aportes', 'exonerado salud sena icbf'],
  codigoArl: ['ARL', 'codigo arl', 'administradora riesgos'],
  claseRiesgo: ['Clase riesgo', 'clase de riesgo', 'riesgo'],
  tarifaEspecialPension: ['Tarifa especial AFP', 'indicador tarifa especial pensiones', 'tarifa especial pension'],
  fechaIng: ['Fecha ING', 'fecha ingreso'],
  fechaRet: ['Fecha RET', 'fecha retiro'],
  fechaVsp: ['Fecha inicio VSP'],
  fechaSlnInicio: ['Fecha inicio SLN'],
  fechaSlnFin: ['Fecha final SLN', 'fecha fin sln'],
  fechaIgeInicio: ['Fecha inicio IGE'],
  fechaIgeFin: ['Fecha final IGE', 'fecha fin ige'],
  fechaLmaInicio: ['Fecha inicio LMA'],
  fechaLmaFin: ['Fecha final LMA', 'fecha fin lma'],
  fechaVacInicio: ['Fecha inicio VAC-LR', 'fecha inicio vacaciones'],
  fechaVacFin: ['Fecha final VAC-LR', 'fecha fin vacaciones'],
  fechaVctInicio: ['Fecha inicio VCT'],
  fechaVctFin: ['Fecha final VCT', 'fecha fin vct'],
  fechaIrlInicio: ['Fecha inicio IRL'],
  fechaIrlFin: ['Fecha final IRL', 'fecha fin irl'],
  ibcOtrosParafiscales: ['IBC otros parafiscales', 'ibc parafiscales'],
  horasLaboradas: ['Número horas laboradas', 'horas laboradas', 'horas'],
  fechaRadicacionExterior: ['Fecha radicación exterior'],
  actividadArl: ['Actividad económica para ARL', 'actividad economica', 'actividad economica arl', 'codigo actividad economica'],
};

const STOP = new Set(['de', 'la', 'del', 'a', 'al', 'el', 'en', 'para', 'n', 'no', 'nº', 'o', 'y', 'esta', 'los', 'las']);

const normalize = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/º/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const tokens = (s) => normalize(s).split(' ').filter((t) => t && !STOP.has(t));

const catalog = (labels) => Object.entries(labels).map(([field, names]) => ({
  field,
  label: names[0],
  forms: names.map(normalize),
  tokenSets: names.map((n) => new Set(tokens(n))),
}));

const R1_CATALOG = catalog(R1_LABELS);
const R2_CATALOG = catalog(R2_LABELS);

/**
 * Campo que corresponde a un encabezado: coincidencia exacta (normalizada)
 * con el nombre o una variante; si no, el de mayor similitud por palabras
 * (>= 0.6 y sin empate).
 */
function matchHeader(text, kind, taken = new Set()) {
  const cat = kind === 'r1' ? R1_CATALOG : R2_CATALOG;
  const n = normalize(text);
  if (!n) return null;
  const exact = cat.find((c) => !taken.has(c.field) && c.forms.includes(n));
  if (exact) return exact.field;
  const t = new Set(tokens(text));
  if (!t.size) return null;
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const c of cat) {
    if (taken.has(c.field)) continue;
    for (const ts of c.tokenSets) {
      const inter = [...t].filter((x) => ts.has(x)).length;
      const score = inter / new Set([...t, ...ts]).size;
      if (score > bestScore) { best = c.field; bestScore = score; tie = false; } else if (score === bestScore && c.field !== best) tie = true;
    }
  }
  return bestScore >= 0.6 && !tie ? best : null;
}

// Cuántos encabezados de la fila son campos conocidos de cada sección.
function countMatches(texts, kind) {
  const cat = kind === 'r1' ? R1_CATALOG : R2_CATALOG;
  return texts.filter((tx) => {
    const n = normalize(tx);
    return n && cat.some((c) => c.forms.includes(n));
  }).length;
}

const labelOf = (kind, field) => (kind === 'r1' ? R1_LABELS : R2_LABELS)[field]?.[0] || field;

// Opciones para elegir a mano el campo de una columna (pantalla de plantilla).
const FIELD_OPTIONS = {
  r1: Object.entries(R1_LABELS).map(([field, names]) => ({ field, label: names[0] })),
  r2: Object.entries(R2_LABELS).map(([field, names]) => ({ field, label: names[0] })),
};

module.exports = { R1_LABELS, R2_LABELS, FIELD_OPTIONS, matchHeader, countMatches, labelOf, normalize };
