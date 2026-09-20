// backend/src/services/exogena/exogenaReadiness.service.js
//
// Gate de completitud antes de generar un archivo de Exógena — mismo
// principio que customerDianReadiness.js: si falta un dato indispensable,
// NO se genera el archivo (evita transmitir a la DIAN con datos
// incompletos o inventados), y se lista exactamente qué falta para que el
// usuario lo complete.
//
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.

const { ExogenaConceptMapping } = require('../../models');
const { EXOGENA_FORMAT_BY_CODE } = require('../../data/exogena-catalogs');
const FORMAT_SERVICES = require('./formatServices');

async function checkReadiness(tenantId, formatCode, year) {
  const meta = EXOGENA_FORMAT_BY_CODE[formatCode];
  const service = FORMAT_SERVICES[formatCode];
  if (!meta || !service) {
    return { ready: false, reason: 'formato_no_soportado', missingConcepts: [], skipped: [] };
  }
  if (meta.dataSource === 'pending') {
    return { ready: false, reason: 'formato_no_implementado', missingConcepts: [], skipped: [] };
  }

  const missingConcepts = [];
  if (meta.needsConceptMapping && service.fetchSourceKeys) {
    const sourceKeys = await service.fetchSourceKeys(tenantId, year);
    const mappings = await ExogenaConceptMapping.findAll({ where: { tenant_id: tenantId, format_code: formatCode } });
    const mappedKeys = new Set(mappings.map((m) => m.source_key));
    for (const key of sourceKeys) {
      if (!mappedKeys.has(key)) missingConcepts.push(key);
    }
  }

  // buildRecords ya excluye (en `skipped`) terceros sin NIT u otras
  // filas no reportables -- se corre igual aquí para poder mostrarle al
  // usuario cuántas filas quedarían fuera ANTES de descargar el archivo.
  const conceptBySourceKey = {};
  if (meta.needsConceptMapping) {
    const mappings = await ExogenaConceptMapping.findAll({ where: { tenant_id: tenantId, format_code: formatCode } });
    for (const m of mappings) conceptBySourceKey[m.source_key] = m.concept_code;
  }
  const { records, skipped } = await service.buildRecords(tenantId, year, conceptBySourceKey);

  return {
    ready: missingConcepts.length === 0,
    reason: missingConcepts.length ? 'faltan_conceptos_por_mapear' : null,
    missingConcepts,
    recordCount: records.length,
    skipped,
  };
}

module.exports = { checkReadiness };
