// backend/src/services/payroll/workerTypes.js
//
// Tipo de trabajador = tipo de cotizante PILA (tabla 5.5.3 DIAN): 12
// aprendiz SENA en etapa lectiva, 19 en etapa productiva. El pensionado no
// es un tipo sino un subtipo del dependiente (tabla 5.5.4: 01 pensionado
// por vejez activo, 03 no obligado por edad, 04 requisitos cumplidos, 05
// indemnización sustitutiva/devolución de saldos, 06 régimen exceptuado):
// no cotiza pensión. '02', '03' y '04' eran los códigos que usaba Pitbox
// antes de corregir la tabla (migración 2026100701) -- se siguen
// reconociendo por si queda alguno.

const APRENDIZ_LECTIVA = ['12', '03'];
const APRENDIZ_PRODUCTIVA = ['19', '04'];
const LEGACY_PENSIONADO = '02';
const SUBTIPOS_PENSIONADO = ['01', '03', '04', '05', '06'];

const esAprendizLectiva = (e) => APRENDIZ_LECTIVA.includes(String(e?.worker_type));
const esAprendizProductiva = (e) => APRENDIZ_PRODUCTIVA.includes(String(e?.worker_type));
const esAprendiz = (e) => esAprendizLectiva(e) || esAprendizProductiva(e);
const esPensionado = (e) => String(e?.worker_type) === LEGACY_PENSIONADO
  || SUBTIPOS_PENSIONADO.includes(String(e?.worker_subtype || '00'));

module.exports = { esAprendiz, esAprendizLectiva, esAprendizProductiva, esPensionado, SUBTIPOS_PENSIONADO };
