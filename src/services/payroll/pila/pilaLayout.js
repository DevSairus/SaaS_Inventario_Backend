// backend/src/services/payroll/pila/pilaLayout.js
//
// Archivo plano PILA "para importar a operador" (Resolución 2388 de 2016,
// archivo tipo 2): ancho fijo, un registro tipo 01 de 359 posiciones
// (encabezado del aportante) y un registro tipo 02 de 693 por cotizante. Es
// el mismo para todos los operadores (SOI, Aportes en Línea, Mi Planilla,
// Asopagos, Simple...). Posiciones validadas campo por campo contra una
// planilla real de septiembre de 2026 (TXT + su Excel equivalente).
//
// Tipos: A alfanumérico (izquierda, relleno con espacios), N numérico
// (derecha, relleno con ceros), R tarifa con `dec` decimales ("0.16000";
// una tarifa 0 va en ceros: "0000000"), D fecha AAAA-MM-DD o en blanco.

const R1 = [
  ['tipoRegistro', 2, 'N'], ['modalidad', 1, 'N'], ['secuencia', 4, 'N'], ['razonSocial', 200, 'A'],
  ['tipoDoc', 2, 'A'], ['nit', 16, 'A'], ['dv', 1, 'N'], ['tipoPlanilla', 1, 'A'],
  ['planillaAsociada', 10, 'A'], ['fechaPlanillaAsociada', 10, 'A'], ['formaPresentacion', 1, 'A'],
  ['codigoSucursal', 10, 'A'], ['nombreSucursal', 40, 'A'], ['codigoArl', 6, 'A'],
  ['periodoPension', 7, 'A'], ['periodoSalud', 7, 'A'], ['numeroRadicacion', 10, 'A'], ['fechaPago', 10, 'A'],
  ['numeroCotizantes', 5, 'N'], ['valorNomina', 12, 'N'], ['tipoAportante', 2, 'N'], ['codigoOperador', 2, 'N'],
];

const R2 = [
  ['tipoRegistro', 2, 'N'], ['secuencia', 5, 'N'], ['tipoDoc', 2, 'A'], ['documento', 16, 'A'],
  ['tipoCotizante', 2, 'N'], ['subtipoCotizante', 2, 'N'], ['extranjero', 1, 'A'], ['colombianoExterior', 1, 'A'],
  ['departamento', 2, 'A'], ['municipio', 3, 'A'],
  ['primerApellido', 20, 'A'], ['segundoApellido', 30, 'A'], ['primerNombre', 20, 'A'], ['segundoNombre', 30, 'A'],
  ['ing', 1, 'A'], ['ret', 1, 'A'], ['tde', 1, 'A'], ['tae', 1, 'A'], ['tdp', 1, 'A'], ['tap', 1, 'A'],
  ['vsp', 1, 'A'], ['correcciones', 1, 'A'], ['vst', 1, 'A'], ['sln', 1, 'A'], ['ige', 1, 'A'], ['lma', 1, 'A'],
  ['vacLr', 1, 'A'], ['avp', 1, 'A'], ['vct', 1, 'A'], ['irl', 2, 'N'],
  ['afp', 6, 'A'], ['afpTraslado', 6, 'A'], ['eps', 6, 'A'], ['epsTraslado', 6, 'A'], ['ccf', 6, 'A'],
  ['diasAfp', 2, 'N'], ['diasEps', 2, 'N'], ['diasArl', 2, 'N'], ['diasCcf', 2, 'N'],
  ['salarioBasico', 9, 'N'], ['salarioIntegral', 1, 'A'],
  ['ibcAfp', 9, 'N'], ['ibcEps', 9, 'N'], ['ibcArl', 9, 'N'], ['ibcCcf', 9, 'N'],
  ['tarifaAfp', 7, 'R', 5], ['cotizacionAfp', 9, 'N'], ['avpAfiliado', 9, 'N'], ['avpAportante', 9, 'N'],
  ['totalAfp', 9, 'N'], ['fsp', 9, 'N'], ['fsps', 9, 'N'], ['valorNoRetenido', 9, 'N'],
  ['tarifaEps', 7, 'R', 5], ['cotizacionEps', 9, 'N'], ['valorUpc', 9, 'N'],
  ['autorizacionIge', 15, 'A'], ['valorIge', 9, 'N'], ['autorizacionLma', 15, 'A'], ['valorLma', 9, 'N'],
  ['tarifaArl', 9, 'R', 7], ['centroTrabajo', 9, 'N'], ['cotizacionArl', 9, 'N'],
  ['tarifaCcf', 7, 'R', 5], ['aporteCcf', 9, 'N'], ['tarifaSena', 7, 'R', 5], ['aporteSena', 9, 'N'],
  ['tarifaIcbf', 7, 'R', 5], ['aporteIcbf', 9, 'N'], ['tarifaEsap', 7, 'R', 5], ['aporteEsap', 9, 'N'],
  ['tarifaMen', 7, 'R', 5], ['aporteMen', 9, 'N'],
  ['tipoDocUpc', 2, 'A'], ['documentoUpc', 16, 'A'], ['exonerado', 1, 'A'], ['codigoArl', 6, 'A'],
  ['claseRiesgo', 1, 'N'], ['tarifaEspecialPension', 1, 'A'],
  ['fechaIng', 10, 'D'], ['fechaRet', 10, 'D'], ['fechaVsp', 10, 'D'],
  ['fechaSlnInicio', 10, 'D'], ['fechaSlnFin', 10, 'D'], ['fechaIgeInicio', 10, 'D'], ['fechaIgeFin', 10, 'D'],
  ['fechaLmaInicio', 10, 'D'], ['fechaLmaFin', 10, 'D'], ['fechaVacInicio', 10, 'D'], ['fechaVacFin', 10, 'D'],
  ['fechaVctInicio', 10, 'D'], ['fechaVctFin', 10, 'D'], ['fechaIrlInicio', 10, 'D'], ['fechaIrlFin', 10, 'D'],
  ['ibcOtrosParafiscales', 9, 'N'], ['horasLaboradas', 3, 'N'], ['fechaRadicacionExterior', 10, 'D'],
  ['actividadArl', 7, 'N'],
];

// Solo A-Z, dígitos y signos básicos: sin tildes ni Ñ (la Ñ pasa a N), que
// varios operadores rechazan en el archivo plano.
const asciiText = (v) => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
  .replace(/[^\x20-\x7E]/g, ' ');

function formatField(value, len, type, dec) {
  if (type === 'N') {
    const n = Math.max(0, Math.round(Number(value) || 0));
    const s = String(value != null && typeof value === 'string' && /^\d+$/.test(value) ? value : n);
    return s.padStart(len, '0').slice(-len);
  }
  if (type === 'R') {
    const n = Number(value) || 0;
    if (n === 0) return '0'.repeat(len);
    return n.toFixed(dec).padStart(len, '0').slice(0, len);
  }
  if (type === 'D') return (value ? String(value).slice(0, 10) : '').padEnd(len, ' ');
  return asciiText(value).slice(0, len).padEnd(len, ' ');
}

function buildRecord(layout, values) {
  const line = layout.map(([name, len, type, dec]) => formatField(values[name], len, type, dec)).join('');
  const expected = layout.reduce((s, [, len]) => s + len, 0);
  if (line.length !== expected) throw new Error(`Registro PILA de ${line.length} posiciones (se esperaban ${expected})`);
  return line;
}

// Inverso: separa una línea en sus campos (para leer una planilla existente).
function parseRecord(layout, line) {
  const out = {};
  let p = 0;
  for (const [name, len] of layout) {
    out[name] = line.substr(p, len);
    p += len;
  }
  return out;
}

module.exports = {
  R1,
  R2,
  R1_LENGTH: R1.reduce((s, [, l]) => s + l, 0),
  R2_LENGTH: R2.reduce((s, [, l]) => s + l, 0),
  buildHeader: (values) => buildRecord(R1, { tipoRegistro: '01', ...values }),
  buildDetail: (values) => buildRecord(R2, { tipoRegistro: '02', ...values }),
  parseRecord,
  formatField,
};
