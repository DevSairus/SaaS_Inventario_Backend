// backend/src/data/exogena-concept-suggestions.js
//
// Sugerencias de código de concepto DIAN para Formato 1001/1007 — Fase 4
// del plan de Contabilidad Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md
// §Fase 4.
//
// A diferencia del resto del catálogo (que se deja 100% a criterio del
// contador, ver ExogenaConceptMapping), estos valores SÍ se pueden sugerir
// con confianza porque salen del texto literal de la Resolución 000227 de
// 23-09-2025 (Artículo 1.3.5.2.1 —tabla de conceptos Formato 1001, ítems
// 1-81— y Artículo 1.3.5.4.1 —tabla de conceptos Formato 1007—), no de una
// suposición. Aun así son solo SUGERENCIAS precargadas y editables en la UI
// (ExogenaPage.jsx): el contador del tenant debe confirmarlas antes de
// generar el archivo real, ya que la naturaleza exacta de cada categoría de
// gasto puede variar entre tenants.
const SUGGESTED_CONCEPTS = {
  1001: {
    purchase: '5007', // Compra de activos movibles (inventario para reventa) -- ítem 9
    // Compras separadas por concepto de retención del ítem (catálogo por
    // defecto, data/retention-concepts-default.js). Conceptos propios del
    // tenant no tienen sugerencia: los asigna el contador.
    'purchase:compras': '5007', // Compra de activos movibles -- ítem 9
    'purchase:combustibles': '5007', // Compra de activos movibles -- ítem 9
    'purchase:servicios': '5004', // Servicios -- ítem 5
    'purchase:transporte_carga': '5004', // Servicios -- ítem 5
    'purchase:aseo_vigilancia': '5004', // Servicios -- ítem 5
    'purchase:hoteles_restaurantes': '5004', // Servicios -- ítem 5
    'purchase:honorarios': '5002', // Honorarios -- ítem 3
    'purchase:arrendamiento_inmuebles': '5005', // Arrendamientos -- ítem 6
    'purchase:arrendamiento_muebles': '5005', // Arrendamientos -- ítem 6
    'expense:arriendo': '5005', // Arrendamientos -- ítem 6
    'expense:honorarios': '5002', // Honorarios -- ítem 3
    'expense:comisiones_tecnicos': '5003', // Comisiones -- ítem 4
    'expense:servicios_publicos': '5004', // Servicios -- ítem 5
    'expense:mantenimiento': '5004', // Servicios -- ítem 5
    'expense:transporte': '5004', // Servicios -- ítem 5
    'expense:marketing': '5004', // Servicios -- ítem 5
    'expense:seguros': '5004', // Servicios -- ítem 5 (no hay concepto específico de primas para tomador no asegurador)
    'expense:insumos_oficina': '5007', // Compra de activos movibles -- ítem 9
    'expense:impuestos': '5015', // Impuestos solicitados como deducción -- ítem 16
    // 'expense:nomina' NO se sugiere: por el Parágrafo 12 del Art. 1.3.5.2.1,
    // los pagos por rentas de trabajo y pensiones NUNCA van en el 1001 --
    // van exclusivamente en el Formato 2276. Ver exclusión explícita en
    // format1001.service.js.
    'expense:otro': null,
  },
  1007: {
    sale: '4001', // Ingresos brutos de actividades ordinarias -- tabla Art. 1.3.5.4.1
  },
};

module.exports = { SUGGESTED_CONCEPTS };
