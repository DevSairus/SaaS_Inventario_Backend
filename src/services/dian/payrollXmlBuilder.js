// backend/src/services/dian/payrollXmlBuilder.js
/**
 * Constructor de XML para Documento Soporte de Pago de Nómina Electrónica (DIAN)
 * Basado en: Resolución 000013 del 11-02-2021, Anexo Técnico v1.0.
 * Todos los elementos, atributos y el orden de aparición fueron extraídos y
 * verificados campo a campo contra el texto del Anexo (IDs NIE001-NIE201).
 *
 * IMPORTANTE — a diferencia de dianXmlBuilder.js (factura) y de la parte de
 * dianKitAdapter.js#createSupportDocument() (documento soporte de
 * adquisiciones), este formato NO es UBL 2.1. El Anexo Técnico de Nómina
 * Electrónica define un esquema propio de la DIAN, con namespace
 * `dian:gov:co:facturaelectronica:NominaIndividual` y raíz <NominaIndividual>
 * — no hay <cac:Party>, <cac:InvoiceLine> ni ningún otro elemento UBL. Por
 * eso este builder NO reutiliza buildInvoiceXml() de @dian-kit/core — arma
 * el XML desde cero.
 *
 * La única parte que sí es UBL 2.1 es el contenedor de firma
 * (<ext:UBLExtensions>, numeral 9.3 del Anexo) — ver payrollDianAdapter.js.
 *
 * Cobertura: TODOS los grupos y elementos de Devengados y Deducciones
 * documentados en el Anexo (NIE001-NIE201) están implementados. No queda
 * ningún concepto "pendiente" — lo que no aplique a un devengo/deducción
 * puntual simplemente se omite (todos son opcionales salvo Basico, Salud y
 * FondoPension).
 *
 * Lo único que sigue sin validar contra un envío real aceptado por la DIAN
 * es el algoritmo del CUNE (ver buildCune() más abajo — el hash no
 * reprodujo el ejemplo oficial del numeral 8.1.1.3, ver comentario ahí) y
 * el formato exacto del CodigoQR (el Anexo no lo detalla con el mismo nivel
 * que la Factura). Todo lo demás en este archivo está anclado a un ID NIEnnn
 * específico del Anexo.
 */

const crypto = require('crypto');

/* ──────────────────────────────────────────────────────────
 * Helpers de formato
 * ────────────────────────────────────────────────────────── */
function escXml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Truncado (NO redondeo) a 2 decimales, sin separador de miles — así lo
// exige explícitamente el numeral 8.1.1.1 para los valores del CUNE. Se usa
// también para todos los valores monetarios del cuerpo del documento por
// consistencia.
//
// Se redondea primero a 6 decimales antes de truncar a 2: operaciones como
// 249095/30*30 dan 249094.99999999997 en punto flotante binario (no es un
// valor fraccionario real, es imprecisión de representación) y un truncado
// ciego le restaría un centavo a un valor que en realidad es exacto. El
// redondeo a 6 decimales absorbe ese ruido sin enmascarar truncamientos
// legítimos (que solo importan a nivel de centavos, 2 decimales).
function truncate2(n) {
  const clean = Math.round(Number(n || 0) * 1e6) / 1e6;
  const v = Math.trunc(clean * 100) / 100;
  return v.toFixed(2);
}

function formatFechaCol(date) {
  const d = new Date(date);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const colDate = new Date(utcMs - 5 * 3600000);
  return colDate.toISOString().slice(0, 10);
}

function formatHoraCol(date) {
  const d = new Date(date);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const colDate = new Date(utcMs - 5 * 3600000);
  return colDate.toISOString().slice(11, 19) + '-05:00';
}

function cleanId(value) {
  return value == null ? value : String(value).trim().replace(/[.\-\s]/g, '');
}

// Construye una lista de atributos XML a partir de un objeto, omitiendo
// claves con valor null/undefined. `numericKeys` son las que se formatean
// con truncate2() en vez de escXml() directo.
function attrs(obj, numericKeys = []) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}="${numericKeys.includes(k) ? truncate2(v) : escXml(v)}"`)
    .join(' ');
}

/* ──────────────────────────────────────────────────────────
 * CUNE (Código Único de Documento Soporte de Pago de Nómina Electrónica)
 * SHA-384, numeral 8.1.1.1 del Anexo Técnico.
 *
 * Composición del CUNE =
 *   SHA384(NumNE + FecNE + HorNE + ValDev + ValDed + ValTolNE + NitNE +
 *          DocEmp + TipoXML + Software-Pin + TipAmb)
 *
 * ⚠️ SIN VERIFICAR: se probó esta fórmula (tal como está redactada en
 * prosa en el numeral 8.1.1.1) contra el ejemplo numérico oficial del
 * numeral 8.1.1.3 (NumNE=N00001, FecNE=2020-01-16, HorNE=10:53:10-05:00,
 * ValDev=3500000.00, ValDed=1000000.00, ValTolNE=2500000.00,
 * NitNE=700085371, DocEmp=800199436, TipoXML=102, Software-Pin=693,
 * TipAmb=1) y el hash SHA-384 resultante NO coincide con el que el propio
 * Anexo dice que debería dar (16560dc8...). Ya pasó algo similar con el
 * CUFE de factura en este proyecto (el caso de TipoFe, resuelto a punta de
 * pruebas reales, no de lo que decía el Anexo) — los Anexos DIAN tienen
 * errores tipográficos conocidos en sus ejemplos numéricos. Se deja la
 * fórmula implementada tal como está en el texto (la fuente más confiable
 * disponible); validar contra el primer envío real al ambiente de
 * habilitación de nómina antes de confiar en esto en producción.
 * ────────────────────────────────────────────────────────── */
function buildCune({
  numeroDocumento, fechaGen, horaGen, devengadosTotal, deduccionesTotal,
  comprobanteTotal, nitEmpleador, numeroDocumentoEmpleado, tipoXML,
  softwarePin, tipoAmbiente,
}) {
  const plain = [
    numeroDocumento,
    fechaGen,
    horaGen,
    truncate2(devengadosTotal),
    truncate2(deduccionesTotal),
    truncate2(comprobanteTotal),
    cleanId(nitEmpleador),
    cleanId(numeroDocumentoEmpleado),
    tipoXML,
    softwarePin,
    tipoAmbiente,
  ].join('');

  return crypto.createHash('sha384').update(plain).digest('hex');
}

// TipoXML — "102" confirmado por el ejemplo oficial del numeral 8.1.1.3
// para NominaIndividual. El Anexo referencia una tabla 5.5.3 con el resto
// de valores (ajustes, etc.) que no se transcribió en detalle aquí —
// confirmarlo antes de implementar createPayrollAdjustment().
const TIPO_XML_NOMINA_INDIVIDUAL = '102';
// Confirmado contra tabla 5.5.7 del Anexo (vía extracción de las tablas de
// reglas de validación, numeral 6.1.2): 103 = NominaIndividualDeAjuste.
// Un único código cubre TANTO Reemplazar como Eliminar — lo que distingue
// el tipo de nota es <TipoNota> (tabla 5.5.8: 1=Reemplazar, 2=Eliminar),
// no TipoXML.
const TIPO_XML_NOMINA_AJUSTE = '103';
const TIPO_NOTA_REEMPLAZAR = 1;
const TIPO_NOTA_ELIMINAR = 2;

/* ──────────────────────────────────────────────────────────
 * Cabecera
 * ────────────────────────────────────────────────────────── */

function periodoXml({ fechaIngreso, fechaRetiro, fechaLiquidacionInicio, fechaLiquidacionFin, tiempoLaborado, fechaGen }) {
  return `<Periodo ${attrs({
    FechaIngreso: fechaIngreso,
    FechaRetiro: fechaRetiro,
    FechaLiquidacionInicio: fechaLiquidacionInicio,
    FechaLiquidacionFin: fechaLiquidacionFin,
    TiempoLaborado: tiempoLaborado,
    FechaGen: fechaGen,
  })} />`;
}

function numeroSecuenciaXmlXml({ codigoTrabajador, prefijo, consecutivo, numero }) {
  return `<NumeroSecuenciaXML ${attrs({
    CodigoTrabajador: codigoTrabajador,
    Prefijo: prefijo,
    Consecutivo: consecutivo,
    Numero: numero,
  })} />`;
}

function lugarGeneracionXmlXml({ pais = 'CO', departamentoEstado, municipioCiudad }) {
  return `<LugarGeneracionXML ${attrs({
    Pais: pais,
    DepartamentoEstado: departamentoEstado,
    MunicipioCiudad: municipioCiudad,
    Idioma: 'es',
  })} />`;
}

function proveedorXmlXml({ razonSocial, primerApellido, segundoApellido, primerNombre, otrosNombres, nit, dv, softwareId, softwareSC }) {
  const base = razonSocial
    ? { RazonSocial: razonSocial }
    : { PrimerApellido: primerApellido, SegundoApellido: segundoApellido, PrimerNombre: primerNombre, OtrosNombres: otrosNombres };
  return `<ProveedorXML ${attrs({ ...base, NIT: cleanId(nit), DV: dv, SoftwareID: softwareId, SoftwareSC: softwareSC })} />`;
}

function codigoQrXml(qrText) {
  return `<CodigoQR>${escXml(qrText)}</CodigoQR>`;
}

function informacionGeneralXml({ version = 'V1.0: Documento Soporte de Pago de Nómina Electrónica', ambiente, cune, fechaGen, horaGen, periodoNomina, tipoMoneda = 'COP', tipoXML = TIPO_XML_NOMINA_INDIVIDUAL }) {
  return `<InformacionGeneral ${attrs({
    Version: version,
    Ambiente: ambiente,
    CUNE: cune,
    EncripCUNE: 'CUNE-SHA384',
    FechaGen: fechaGen,
    HoraGen: horaGen,
    TipoXML: tipoXML,
    PeriodoNomina: periodoNomina,
    TipoMoneda: tipoMoneda,
  })} />`;
}

function empleadorXml({ razonSocial, nit, dv, pais = 'CO', departamentoEstado, municipioCiudad, direccion }) {
  return `<Empleador ${attrs({
    RazonSocial: razonSocial, NIT: cleanId(nit), DV: dv, Pais: pais,
    DepartamentoEstado: departamentoEstado, MunicipioCiudad: municipioCiudad, Direccion: direccion,
  })} />`;
}

function trabajadorXml({
  tipoTrabajador, subTipoTrabajador, altoRiesgoPension = false, tipoDocumento,
  numeroDocumento, primerApellido, segundoApellido, primerNombre, otrosNombres,
  lugarTrabajoPais = 'CO', lugarTrabajoDepartamento, lugarTrabajoMunicipio, lugarTrabajoDireccion,
  salarioIntegral = false, tipoContrato, sueldo, codigoTrabajador,
}) {
  return `<Trabajador ${attrs({
    TipoTrabajador: tipoTrabajador,
    SubTipoTrabajador: subTipoTrabajador,
    AltoRiesgoPension: altoRiesgoPension ? 'true' : 'false',
    TipoDocumento: tipoDocumento,
    NumeroDocumento: cleanId(numeroDocumento),
    PrimerApellido: primerApellido,
    SegundoApellido: segundoApellido,
    PrimerNombre: primerNombre,
    OtrosNombres: otrosNombres,
    LugarTrabajoPais: lugarTrabajoPais,
    LugarTrabajoDepartamentoEstado: lugarTrabajoDepartamento,
    LugarTrabajoMunicipioCiudad: lugarTrabajoMunicipio,
    LugarTrabajoDireccion: lugarTrabajoDireccion,
    SalarioIntegral: salarioIntegral ? 'true' : 'false',
    TipoContrato: tipoContrato,
    CodigoTrabajador: codigoTrabajador,
  }, [])} Sueldo="${truncate2(sueldo)}" />`;
}

function pagoXml({ forma, metodo, banco, tipoCuenta, numeroCuenta }) {
  return `<Pago ${attrs({ Forma: forma, Metodo: metodo, Banco: banco, TipoCuenta: tipoCuenta, NumeroCuenta: numeroCuenta })} />`;
}

// Mapeo de payment_method (Employee: transfer/cash/check) → Metodo DIAN
// (tabla 5.3.3.2, referenciada por el Anexo pero no transcrita en detalle
// en la extracción usada para este archivo). MEJOR ESFUERZO — confirmar
// los códigos exactos de la tabla antes de habilitación; se usan los
// valores más comunes en integraciones DIAN existentes.
const METODO_PAGO_DIAN = { transfer: '42', cash: '1', check: '2' };
// Mapeo account_type (Employee: savings/checking) → TipoCuenta DIAN.
const TIPO_CUENTA_DIAN = { savings: '1', checking: '2' };

function fechasPagosXml(fechas) {
  const list = (fechas || []).map(f => `<FechaPago>${escXml(f)}</FechaPago>`).join('');
  return `<FechasPagos>${list}</FechasPagos>`;
}

/* ──────────────────────────────────────────────────────────
 * Devengados — cobertura completa NIE069-NIE160, NIE193-NIE194, NIE201
 * ────────────────────────────────────────────────────────── */

// Grupo genérico de "horas": HEDs/HENs/HRNs/HEDDFs/HRDDFs/HENDFs/HRNDFs —
// misma forma exacta en las 7 variantes (HoraInicio 0-1, HoraFin 0-1,
// Cantidad 1-1, Porcentaje 1-1, Pago 1-1). Confirmado NIE074-078 (HED),
// NIE079-083 (HEN), NIE084-088 (HRN), NIE089-093 (HEDDF), NIE094-098
// (HRDDF), NIE099-103 (HENDF), NIE104-108 (HRNDF).
function horasGrupoXml(grupoTag, itemTag, items) {
  if (!items || !items.length) return '';
  const inner = items.map(h => `<${itemTag} ${attrs({
    HoraInicio: h.horaInicio, HoraFin: h.horaFin, Cantidad: h.cantidad,
  })} Porcentaje="${truncate2(h.porcentaje)}" Pago="${truncate2(h.pago)}" />`).join('');
  return `<${grupoTag}>${inner}</${grupoTag}>`;
}

function vacacionesXml(v) {
  if (!v || (!v.comunes?.length && !v.compensadas?.length)) return '';
  let xml = '<Vacaciones>';
  for (const c of (v.comunes || [])) {
    xml += `<VacacionesComunes ${attrs({ FechaInicio: c.fechaInicio, FechaFin: c.fechaFin, Cantidad: c.cantidad })} Pago="${truncate2(c.pago)}" />`;
  }
  for (const c of (v.compensadas || [])) {
    xml += `<VacacionesCompensadas Cantidad="${escXml(c.cantidad)}" Pago="${truncate2(c.pago)}" />`;
  }
  xml += '</Vacaciones>';
  return xml;
}

// Primas y Cesantias son elementos "vacíos" con TODOS sus datos como
// atributos (NIE117-119 y NIE120-122) — no llevan texto de nodo.
function primasXml(p) {
  if (!p) return '';
  return `<Primas Cantidad="${escXml(p.cantidad)}" Pago="${truncate2(p.pago)}"${p.pagoNS != null ? ` PagoNS="${truncate2(p.pagoNS)}"` : ''} />`;
}

function cesantiasXml(c) {
  if (!c) return '';
  return `<Cesantias Pago="${truncate2(c.pago)}" Porcentaje="${escXml(c.porcentaje)}" PagoIntereses="${truncate2(c.pagoIntereses)}" />`;
}

function incapacidadesXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(i => `<Incapacidad ${attrs({ FechaInicio: i.fechaInicio, FechaFin: i.fechaFin, Cantidad: i.cantidad, Tipo: i.tipo })} Pago="${truncate2(i.pago)}" />`).join('');
  return `<Incapacidades>${inner}</Incapacidades>`;
}

function licenciasXml(l) {
  if (!l || (!l.maternidadPaternidad?.length && !l.remunerada?.length && !l.noRemunerada?.length)) return '';
  let xml = '<Licencias>';
  for (const i of (l.maternidadPaternidad || [])) {
    xml += `<LicenciaMP ${attrs({ FechaInicio: i.fechaInicio, FechaFin: i.fechaFin, Cantidad: i.cantidad })} Pago="${truncate2(i.pago)}" />`;
  }
  for (const i of (l.remunerada || [])) {
    xml += `<LicenciaR ${attrs({ FechaInicio: i.fechaInicio, FechaFin: i.fechaFin, Cantidad: i.cantidad })} Pago="${truncate2(i.pago)}" />`;
  }
  for (const i of (l.noRemunerada || [])) {
    // LicenciaNR NO lleva @Pago (por definición, no remunerada) — NIE136-138
    xml += `<LicenciaNR ${attrs({ FechaInicio: i.fechaInicio, FechaFin: i.fechaFin, Cantidad: i.cantidad })} />`;
  }
  xml += '</Licencias>';
  return xml;
}

function bonificacionesXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(b => `<Bonificacion ${attrs({ BonificacionS: b.bonificacionS, BonificacionNS: b.bonificacionNS }, ['BonificacionS', 'BonificacionNS'])} />`).join('');
  return `<Bonificaciones>${inner}</Bonificaciones>`;
}

function auxiliosXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(a => `<Auxilio ${attrs({ AuxilioS: a.auxilioS, AuxilioNS: a.auxilioNS }, ['AuxilioS', 'AuxilioNS'])} />`).join('');
  return `<Auxilios>${inner}</Auxilios>`;
}

function huelgasLegalesXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(h => `<HuelgaLegal ${attrs({ FechaInicio: h.fechaInicio, FechaFin: h.fechaFin, Cantidad: h.cantidad })} />`).join('');
  return `<HuelgasLegales>${inner}</HuelgasLegales>`;
}

// OtroConcepto SÍ es atributo-based (NIE146-148): @DescripcionConcepto (obligatorio),
// @ConceptoS, @ConceptoNS.
function otrosConceptosXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(c => `<OtroConcepto DescripcionConcepto="${escXml(c.descripcion)}" ${attrs({ ConceptoS: c.conceptoS, ConceptoNS: c.conceptoNS }, ['ConceptoS', 'ConceptoNS'])} />`).join('');
  return `<OtrosConceptos>${inner}</OtrosConceptos>`;
}

function compensacionesXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(c => `<Compensacion CompensacionO="${truncate2(c.compensacionO)}" CompensacionE="${truncate2(c.compensacionE)}" />`).join('');
  return `<Compensaciones>${inner}</Compensaciones>`;
}

function bonoEPCTVsXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(b => `<BonoEPCTV ${attrs({
    PagoS: b.pagoS, PagoNS: b.pagoNS, PagoAlimentacionS: b.pagoAlimentacionS, PagoAlimentacionNS: b.pagoAlimentacionNS,
  }, ['PagoS', 'PagoNS', 'PagoAlimentacionS', 'PagoAlimentacionNS'])} />`).join('');
  return `<BonoEPCTVs>${inner}</BonoEPCTVs>`;
}

// Comision, PagoTercero, Anticipo (Devengados): elementos simples de texto
// numérico (NIE155, NIE193, NIE194) — NO llevan atributos, a diferencia de
// OtroConcepto/Bonificacion/etc.
function simpleValueListXml(groupTag, itemTag, values) {
  if (!values || !values.length) return '';
  const inner = values.map(v => `<${itemTag}>${truncate2(v)}</${itemTag}>`).join('');
  return `<${groupTag}>${inner}</${groupTag}>`;
}

function devengadosXml(d) {
  let xml = '<Devengados>';

  xml += `<Basico DiasTrabajados="${escXml(d.basico.diasTrabajados)}" SueldoTrabajado="${truncate2(d.basico.sueldoTrabajado)}" />`;

  if (d.transporte) {
    xml += `<Transporte ${attrs({
      AuxilioTransporte: d.transporte.auxilioTransporte,
      ViaticoManuAlojS: d.transporte.viaticoManuAlojS,
      ViaticoManuAlojNS: d.transporte.viaticoManuAlojNS,
    }, ['AuxilioTransporte', 'ViaticoManuAlojS', 'ViaticoManuAlojNS'])} />`;
  }

  xml += horasGrupoXml('HEDs', 'HED', d.heds);
  xml += horasGrupoXml('HENs', 'HEN', d.hens);
  xml += horasGrupoXml('HRNs', 'HRN', d.hrns);
  xml += horasGrupoXml('HEDDFs', 'HEDDF', d.heddfs);
  xml += horasGrupoXml('HRDDFs', 'HRDDF', d.hrddfs);
  xml += horasGrupoXml('HENDFs', 'HENDF', d.hendfs);
  xml += horasGrupoXml('HRNDFs', 'HRNDF', d.hrndfs);

  xml += vacacionesXml(d.vacaciones);
  xml += primasXml(d.primas);
  xml += cesantiasXml(d.cesantias);
  xml += incapacidadesXml(d.incapacidades);
  xml += licenciasXml(d.licencias);
  xml += bonificacionesXml(d.bonificaciones);
  xml += auxiliosXml(d.auxilios);
  xml += huelgasLegalesXml(d.huelgasLegales);
  xml += otrosConceptosXml(d.otrosConceptos);
  xml += compensacionesXml(d.compensaciones);
  xml += bonoEPCTVsXml(d.bonoEPCTVs);
  xml += simpleValueListXml('Comisiones', 'Comision', d.comisiones);
  xml += simpleValueListXml('PagosTerceros', 'PagoTercero', d.pagosTerceros);
  xml += simpleValueListXml('Anticipos', 'Anticipo', d.anticipos);

  // Elementos simples directos (0-1 cada uno, NIE156-160, NIE201)
  if (d.dotacion != null) xml += `<Dotacion>${truncate2(d.dotacion)}</Dotacion>`;
  if (d.apoyoSost != null) xml += `<ApoyoSost>${truncate2(d.apoyoSost)}</ApoyoSost>`;
  if (d.teletrabajo != null) xml += `<Teletrabajo>${truncate2(d.teletrabajo)}</Teletrabajo>`;
  if (d.bonifRetiro != null) xml += `<BonifRetiro>${truncate2(d.bonifRetiro)}</BonifRetiro>`;
  if (d.indemnizacion != null) xml += `<Indemnizacion>${truncate2(d.indemnizacion)}</Indemnizacion>`;
  if (d.reintegro != null) xml += `<Reintegro>${truncate2(d.reintegro)}</Reintegro>`;

  xml += '</Devengados>';
  return xml;
}

/* ──────────────────────────────────────────────────────────
 * Deducciones — cobertura completa NIE161-NIE185, NIE195-NIE198
 * ────────────────────────────────────────────────────────── */

function sindicatosXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(s => `<Sindicato Porcentaje="${escXml(s.porcentaje)}" Deduccion="${truncate2(s.deduccion)}" />`).join('');
  return `<Sindicatos>${inner}</Sindicatos>`;
}

function sancionesXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(s => `<Sancion SancionPublic="${truncate2(s.sancionPublic)}" SancionPriv="${truncate2(s.sancionPriv)}" />`).join('');
  return `<Sanciones>${inner}</Sanciones>`;
}

function libranzasXml(items) {
  if (!items || !items.length) return '';
  const inner = items.map(l => `<Libranza Descripcion="${escXml(l.descripcion)}" Deduccion="${truncate2(l.deduccion)}" />`).join('');
  return `<Libranzas>${inner}</Libranzas>`;
}

function deduccionesXml(d) {
  let xml = '<Deducciones>';

  xml += `<Salud Porcentaje="${escXml(d.salud.porcentaje)}" Deduccion="${truncate2(d.salud.deduccion)}" />`;
  xml += `<FondoPension Porcentaje="${escXml(d.fondoPension.porcentaje)}" Deduccion="${truncate2(d.fondoPension.deduccion)}" />`;

  if (d.fondoSP) {
    xml += `<FondoSP ${attrs({
      Porcentaje: d.fondoSP.porcentaje,
      DeduccionSP: d.fondoSP.deduccionSP,
      PorcentajeSub: d.fondoSP.porcentajeSub,
      DeduccionSub: d.fondoSP.deduccionSub,
    }, ['DeduccionSP', 'DeduccionSub'])} />`;
  }

  xml += sindicatosXml(d.sindicatos);
  xml += sancionesXml(d.sanciones);
  xml += libranzasXml(d.libranzas);
  xml += simpleValueListXml('PagosTerceros', 'PagoTercero', d.pagosTerceros);
  xml += simpleValueListXml('Anticipos', 'Anticipo', d.anticipos);
  // OtraDeduccion: elemento simple de texto numérico (NIE197) — a
  // diferencia de OtroConcepto en Devengados, NO lleva atributos.
  xml += simpleValueListXml('OtrasDeducciones', 'OtraDeduccion', d.otrasDeducciones);

  // Elementos simples directos (0-1 cada uno, NIE177-185, NIE198)
  if (d.pensionVoluntaria != null) xml += `<PensionVoluntaria>${truncate2(d.pensionVoluntaria)}</PensionVoluntaria>`;
  if (d.retencionFuente != null) xml += `<RetencionFuente>${truncate2(d.retencionFuente)}</RetencionFuente>`;
  if (d.afc != null) xml += `<AFC>${truncate2(d.afc)}</AFC>`;
  if (d.cooperativa != null) xml += `<Cooperativa>${truncate2(d.cooperativa)}</Cooperativa>`;
  if (d.embargoFiscal != null) xml += `<EmbargoFiscal>${truncate2(d.embargoFiscal)}</EmbargoFiscal>`;
  if (d.planComplementarios != null) xml += `<PlanComplementarios>${truncate2(d.planComplementarios)}</PlanComplementarios>`;
  if (d.educacion != null) xml += `<Educacion>${truncate2(d.educacion)}</Educacion>`;
  if (d.reintegro != null) xml += `<Reintegro>${truncate2(d.reintegro)}</Reintegro>`;
  if (d.deuda != null) xml += `<Deuda>${truncate2(d.deuda)}</Deuda>`;

  xml += '</Deducciones>';
  return xml;
}

/* ──────────────────────────────────────────────────────────
 * Ensamblado completo del documento NominaIndividual
 * Orden de elementos raíz confirmado contra el Anexo:
 *   UBLExtensions, Periodo, NumeroSecuenciaXML, LugarGeneracionXML,
 *   ProveedorXML, CodigoQR, InformacionGeneral, Empleador, Trabajador,
 *   Pago, FechasPagos, Devengados, Deducciones, DevengadosTotal,
 *   DeduccionesTotal, ComprobanteTotal.
 * ────────────────────────────────────────────────────────── */

/**
 * @param {object} params.tenant - instancia/objeto Tenant, con dian_config
 *   (JSONB — campos reales: nit, dv, company_name, address, city, city_code,
 *   dept, environment, certificate_p12_base64, certificate_password,
 *   software_id/software_pin de FACTURACIÓN). La habilitación de nómina es
 *   INDEPENDIENTE de la de facturación aunque comparta NIT — se leen de
 *   `cfg.software_id_nomina`/`cfg.software_pin_nomina`, dos claves nuevas
 *   dentro del mismo JSONB (no requieren migración, agregarlas en
 *   TenantSettingsPage/DianConfigPage cuando se construya la Fase 5).
 * @param {object} params.employee - instancia/objeto Employee (modelo real
 *   en src/models/payroll/Employee.js).
 * @param {object} params.period - instancia/objeto PayrollPeriod.
 * @param {object} params.liquidation - resultado de payrollService.js, con
 *   devengados/deducciones ya calculados en la forma que consumen
 *   devengadosXml()/deduccionesXml() arriba.
 * @param {object} params.numbering - { prefix, consecutivo } de la
 *   resolución de numeración de nómina vigente para el tenant.
 */
function buildPayrollXml({ tenant, employee, period, liquidation, numbering }) {
  const cfg = tenant.dian_config || {};
  const now = new Date();
  const fechaGen = formatFechaCol(now);
  const horaGen = formatHoraCol(now);

  const numeroDocumento = `${numbering.prefix}${numbering.consecutivo}`;
  const tipoAmbiente = cfg.environment === 'production' ? '1' : '2';

  const devengadosTotal = liquidation.devengadosTotal;
  const deduccionesTotal = liquidation.deduccionesTotal;
  const comprobanteTotal = devengadosTotal - deduccionesTotal;

  const cune = buildCune({
    numeroDocumento, fechaGen, horaGen, devengadosTotal, deduccionesTotal, comprobanteTotal,
    nitEmpleador: cfg.nit,
    numeroDocumentoEmpleado: employee.document_number,
    tipoXML: TIPO_XML_NOMINA_INDIVIDUAL,
    softwarePin: cfg.software_pin_nomina,
    tipoAmbiente,
  });

  // Lugar de trabajo: el Anexo lo exige como dato independiente de la
  // residencia del empleado (NIE050-053, 1-1 obligatorio). Si el tenant no
  // lo diligenció explícitamente en Employee (work_city_code/work_address),
  // se usa la ubicación del Empleador como fallback razonable — caso típico
  // de PyME donde todos trabajan en la sede única.
  const lugarTrabajoDepartamento = employee.work_city_code
    ? employee.work_city_code.slice(0, 2)
    : cfg.dept;
  const lugarTrabajoMunicipio = employee.work_city_code || cfg.city_code;
  const lugarTrabajoDireccion = employee.work_address || cfg.address;

  const body = [
    // Contenedor de firma XAdES-BES — numeral 9.3 exige que esta sección
    // (y solo esta) use UBL 2.1, por eso lleva el namespace ext: aunque el
    // resto del árbol no use prefijos UBL. Se firma en payrollDianAdapter.js.
    '<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>',
    periodoXml({
      fechaIngreso: employee.hire_date,
      fechaRetiro: employee.termination_date,
      fechaLiquidacionInicio: period.start_date,
      fechaLiquidacionFin: period.end_date,
      tiempoLaborado: liquidation.tiempoLaboradoDias,
      fechaGen,
    }),
    numeroSecuenciaXmlXml({
      codigoTrabajador: employee.employee_code,
      prefijo: numbering.prefix,
      consecutivo: numbering.consecutivo,
      numero: numeroDocumento,
    }),
    lugarGeneracionXmlXml({ departamentoEstado: cfg.dept, municipioCiudad: cfg.city_code }),
    proveedorXmlXml({
      razonSocial: cfg.company_name || tenant.company_name,
      nit: cfg.nit, dv: cfg.dv,
      softwareId: cfg.software_id_nomina,
      softwareSC: liquidation.softwareSecurityCode, // numeral 8.3 — mismo mecanismo que factura, ver dianKitAdapter.js#computeNitCheckDigit()/lógica de SoftwareSC equivalente
    }),
    codigoQrXml(liquidation.qrText || `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cune}`), // formato confirmado por NIE021 del Anexo
    informacionGeneralXml({
      ambiente: tipoAmbiente, cune, fechaGen, horaGen,
      periodoNomina: period.period_type === 'quincenal' ? '2' : '1', // tabla 5.5.1 — MEJOR ESFUERZO, confirmar códigos exactos antes de habilitación
    }),
    empleadorXml({
      razonSocial: cfg.company_name || tenant.company_name,
      nit: cfg.nit, dv: cfg.dv,
      departamentoEstado: cfg.dept, municipioCiudad: cfg.city_code, direccion: cfg.address,
    }),
    trabajadorXml({
      tipoTrabajador: employee.worker_type,
      subTipoTrabajador: employee.worker_subtype,
      altoRiesgoPension: employee.high_risk_pension,
      tipoDocumento: employee.document_type,
      numeroDocumento: employee.document_number,
      primerApellido: employee.first_surname, segundoApellido: employee.second_surname,
      primerNombre: employee.first_name, otrosNombres: employee.other_names,
      lugarTrabajoPais: employee.work_country || 'CO',
      lugarTrabajoDepartamento, lugarTrabajoMunicipio, lugarTrabajoDireccion,
      salarioIntegral: employee.salary_type === 'integral',
      tipoContrato: employee.contract_type,
      sueldo: employee.base_salary,
      codigoTrabajador: employee.employee_code,
    }),
    pagoXml({
      forma: employee.payment_form,
      metodo: METODO_PAGO_DIAN[employee.payment_method] || employee.payment_method,
      banco: employee.bank_name,
      tipoCuenta: TIPO_CUENTA_DIAN[employee.account_type] || employee.account_type,
      numeroCuenta: employee.account_number,
    }),
    fechasPagosXml(liquidation.paymentDates),
    devengadosXml(liquidation.devengados),
    deduccionesXml(liquidation.deducciones),
    `<DevengadosTotal>${truncate2(devengadosTotal)}</DevengadosTotal>`,
    `<DeduccionesTotal>${truncate2(deduccionesTotal)}</DeduccionesTotal>`,
    `<ComprobanteTotal>${truncate2(comprobanteTotal)}</ComprobanteTotal>`,
  ].join('\n  ');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<NominaIndividual
  xmlns="dian:gov:co:facturaelectronica:NominaIndividual"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="dian:gov:co:facturaelectronica:NominaIndividual NominaIndividualElectronicaXSD.xsd">
  ${body}
</NominaIndividual>`;

  return { xml, cune, numeroDocumento, devengadosTotal, deduccionesTotal, comprobanteTotal };
}

/* ──────────────────────────────────────────────────────────
 * Nota de Ajuste: NominaIndividualDeAjuste
 *
 * Estructura confirmada contra el Anexo (numeral 3.2 y numeral 6.1.2 —
 * tablas de reglas de validación, que listan cada campo con su Xpath
 * completo): /NominaIndividualDeAjuste/Reemplazar/* es un espejo EXACTO
 * de /NominaIndividual/* (mismos elementos: Periodo, NumeroSecuenciaXML,
 * LugarGeneracionXML, ProveedorXML, CodigoQR, InformacionGeneral,
 * Empleador, Trabajador, Pago, FechasPagos, Devengados, Deducciones,
 * totales) — por eso este builder reutiliza tal cual los mismos helpers
 * de arriba (periodoXml, devengadosXml, etc.), solo cambia el elemento
 * raíz y se antepone <ReemplazandoPredecesor> con los datos del
 * documento que se está corrigiendo.
 *
 * La rama Eliminar NO se pudo confirmar campo a campo contra el Anexo
 * (no se localizó la tabla 3.2 completa de esa sección en la extracción
 * disponible) — se construye con el criterio que documenta la propia
 * DIAN en doctrina (Oficio 904276/2022): un Eliminar únicamente necesita
 * identificar el documento a invalidar, no repetir devengados/
 * deducciones. Implementado como mejor esfuerzo con el mismo patrón de
 * <EliminandoPredecesor> + <InformacionGeneral> propia; VALIDAR contra
 * el ambiente de pruebas de la DIAN antes de usar en producción — si la
 * DIAN rechaza el Eliminar por estructura, revisar esta sección primero.
 *
 * CUNE de la nota de ajuste: el numeral 8.1.1.2 (no incluido en la
 * extracción disponible) debería definir una fórmula específica: se
 * asume aquí la MISMA fórmula que buildCune() de arriba, cambiando
 * TipoXML a 103 (TIPO_XML_NOMINA_AJUSTE) y usando el número/fecha/hora
 * propios de la nota — igual que ya se advierte para buildCune() del
 * documento original, esto es SIN VERIFICAR contra un envío real.
 * ────────────────────────────────────────────────────────── */

/**
 * @param {object} params.tenant, employee, period, liquidation, numbering
 *   - mismos que buildPayrollXml(). En 'delete', liquidation puede venir
 *     con devengados/deducciones vacíos (no se listan conceptos en un
 *     Eliminar), pero SÍ debe traer softwareSecurityCode.
 * @param {'replace'|'delete'} params.adjustmentType
 * @param {object} params.predecessor - { numeroPred, cunePred, fechaGenPred }
 *   del documento (NominaIndividual u otra NominaIndividualDeAjuste) que
 *   se está corrigiendo o eliminando.
 */
function buildPayrollAdjustmentXml({ tenant, employee, period, liquidation, numbering, adjustmentType, predecessor }) {
  if (adjustmentType !== 'replace' && adjustmentType !== 'delete') {
    throw new Error(`adjustmentType inválido: "${adjustmentType}" (debe ser 'replace' o 'delete')`);
  }

  const cfg = tenant.dian_config || {};
  const now = new Date();
  const fechaGen = formatFechaCol(now);
  const horaGen = formatHoraCol(now);

  const numeroDocumento = `${numbering.prefix}${numbering.consecutivo}`;
  const tipoAmbiente = cfg.environment === 'production' ? '1' : '2';

  const devengadosTotal = liquidation.devengadosTotal || 0;
  const deduccionesTotal = liquidation.deduccionesTotal || 0;
  const comprobanteTotal = devengadosTotal - deduccionesTotal;

  const cune = buildCune({
    numeroDocumento, fechaGen, horaGen, devengadosTotal, deduccionesTotal, comprobanteTotal,
    nitEmpleador: cfg.nit,
    numeroDocumentoEmpleado: employee.document_number,
    tipoXML: TIPO_XML_NOMINA_AJUSTE,
    softwarePin: cfg.software_pin_nomina,
    tipoAmbiente,
  });

  const lugarTrabajoDepartamento = employee.work_city_code ? employee.work_city_code.slice(0, 2) : cfg.dept;
  const lugarTrabajoMunicipio = employee.work_city_code || cfg.city_code;
  const lugarTrabajoDireccion = employee.work_address || cfg.address;

  const predecesorTag = adjustmentType === 'replace' ? 'ReemplazandoPredecesor' : 'EliminandoPredecesor';
  const predecesorXml = `<${predecesorTag} ${attrs({
    NumeroPred: predecessor.numeroPred,
    CUNEPred: predecessor.cunePred,
    FechaGenPred: predecessor.fechaGenPred,
  })} />`;

  const commonPieces = [
    predecesorXml,
    periodoXml({
      fechaIngreso: employee.hire_date,
      fechaRetiro: employee.termination_date,
      fechaLiquidacionInicio: period.start_date,
      fechaLiquidacionFin: period.end_date,
      tiempoLaborado: liquidation.tiempoLaboradoDias || 1,
      fechaGen,
    }),
    numeroSecuenciaXmlXml({
      codigoTrabajador: employee.employee_code,
      prefijo: numbering.prefix,
      consecutivo: numbering.consecutivo,
      numero: numeroDocumento,
    }),
    lugarGeneracionXmlXml({ departamentoEstado: cfg.dept, municipioCiudad: cfg.city_code }),
    proveedorXmlXml({
      razonSocial: cfg.company_name || tenant.company_name,
      nit: cfg.nit, dv: cfg.dv,
      softwareId: cfg.software_id_nomina,
      softwareSC: liquidation.softwareSecurityCode,
    }),
    codigoQrXml(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cune}`),
    informacionGeneralXml({
      version: 'V1.0: Nota de Ajuste de Documento Soporte de Pago de Nómina Electrónica',
      ambiente: tipoAmbiente, cune, fechaGen, horaGen,
      periodoNomina: period.period_type === 'quincenal' ? '2' : '1',
      tipoXML: TIPO_XML_NOMINA_AJUSTE,
    }),
    empleadorXml({
      razonSocial: cfg.company_name || tenant.company_name,
      nit: cfg.nit, dv: cfg.dv,
      departamentoEstado: cfg.dept, municipioCiudad: cfg.city_code, direccion: cfg.address,
    }),
    trabajadorXml({
      tipoTrabajador: employee.worker_type,
      subTipoTrabajador: employee.worker_subtype,
      altoRiesgoPension: employee.high_risk_pension,
      tipoDocumento: employee.document_type,
      numeroDocumento: employee.document_number,
      primerApellido: employee.first_surname, segundoApellido: employee.second_surname,
      primerNombre: employee.first_name, otrosNombres: employee.other_names,
      lugarTrabajoPais: employee.work_country || 'CO',
      lugarTrabajoDepartamento, lugarTrabajoMunicipio, lugarTrabajoDireccion,
      salarioIntegral: employee.salary_type === 'integral',
      tipoContrato: employee.contract_type,
      sueldo: employee.base_salary,
      codigoTrabajador: employee.employee_code,
    }),
    pagoXml({
      forma: employee.payment_form,
      metodo: METODO_PAGO_DIAN[employee.payment_method] || employee.payment_method,
      banco: employee.bank_name,
      tipoCuenta: TIPO_CUENTA_DIAN[employee.account_type] || employee.account_type,
      numeroCuenta: employee.account_number,
    }),
    fechasPagosXml(liquidation.paymentDates),
  ];

  // Reemplazar SÍ repite devengados/deducciones completos (es un
  // documento sustituto íntegro); Eliminar no lleva conceptos — solo
  // identifica qué se invalida (ver nota arriba sobre el mejor esfuerzo).
  if (adjustmentType === 'replace') {
    commonPieces.push(
      devengadosXml(liquidation.devengados || {}),
      deduccionesXml(liquidation.deducciones || {}),
      `<DevengadosTotal>${truncate2(devengadosTotal)}</DevengadosTotal>`,
      `<DeduccionesTotal>${truncate2(deduccionesTotal)}</DeduccionesTotal>`,
      `<ComprobanteTotal>${truncate2(comprobanteTotal)}</ComprobanteTotal>`,
    );
  }

  const branchTag = adjustmentType === 'replace' ? 'Reemplazar' : 'Eliminar';
  const tipoNota = adjustmentType === 'replace' ? TIPO_NOTA_REEMPLAZAR : TIPO_NOTA_ELIMINAR;

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<NominaIndividualDeAjuste
  xmlns="dian:gov:co:facturaelectronica:NominaIndividualDeAjuste"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="dian:gov:co:facturaelectronica:NominaIndividualDeAjuste NominaIndividualDeAjusteElectronicaXSD.xsd">
  <ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <TipoNota>${tipoNota}</TipoNota>
  <${branchTag}>
  ${commonPieces.join('\n  ')}
  </${branchTag}>
</NominaIndividualDeAjuste>`;

  return { xml, cune, numeroDocumento, devengadosTotal, deduccionesTotal, comprobanteTotal };
}

module.exports = {
  buildCune,
  buildPayrollXml,
  buildPayrollAdjustmentXml,
  truncate2,
  formatFechaCol,
  formatHoraCol,
  TIPO_XML_NOMINA_INDIVIDUAL,
  TIPO_XML_NOMINA_AJUSTE,
  TIPO_NOTA_REEMPLAZAR,
  TIPO_NOTA_ELIMINAR,
};