// backend/src/services/exogena/exogenaGenerator.service.js
//
// Orquestador de generación de archivo(s) de Exógena — Fase 4 del plan de
// Contabilidad Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Dado (tenant, formato, año): resuelve los registros vía el
// formatXXXX.service.js correspondiente, arma el/los XML "muisca" (uno
// solo casi siempre; varios si se supera el límite de 5000 registros por
// archivo) y los empaqueta en un .zip cuando hay más de uno, para que el
// front solo tenga que ofrecer una descarga.

const AdmZip = require('adm-zip');
const { ExogenaConceptMapping } = require('../../models');
const { EXOGENA_FORMAT_BY_CODE } = require('../../data/exogena-catalogs');
const { buildMuiscaFiles } = require('./muiscaXmlBuilder');
const FORMAT_SERVICES = require('./formatServices');

class ExogenaGenerationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExogenaGenerationError';
    this.code = code;
  }
}

/**
 * @returns {{ filename: string, buffer: Buffer, contentType: string, recordCount: number, skipped: Array }}
 */
/**
 * Mapeo de conceptos efectivo: las sugerencias oficiales (tabla de conceptos
 * de la Resolución 000227/2025, ver exogena-concept-suggestions.js) se
 * aplican por defecto, y lo que el contador haya guardado las reemplaza. Así
 * el formato sale listo sin que nadie tenga que "confirmar" lo obvio; el
 * contador solo cambia lo que no comparta.
 */
async function effectiveConceptMap(tenantId, formatCode) {
  const { SUGGESTED_CONCEPTS } = require('../../data/exogena-concept-suggestions');
  const suggested = Object.fromEntries(Object.entries(SUGGESTED_CONCEPTS[formatCode] || {}).filter(([, v]) => v));
  const mappings = await ExogenaConceptMapping.findAll({ where: { tenant_id: tenantId, format_code: formatCode } });
  return { ...suggested, ...Object.fromEntries(mappings.map((m) => [m.source_key, m.concept_code])) };
}

async function resolveRecords(tenantId, formatCode, year) {
  const meta = EXOGENA_FORMAT_BY_CODE[formatCode];
  const service = FORMAT_SERVICES[formatCode];
  if (!meta || !service) throw new ExogenaGenerationError(`Formato ${formatCode} no reconocido`, 'FORMAT_UNKNOWN');
  if (meta.dataSource === 'pending') {
    throw new ExogenaGenerationError(`El formato ${formatCode} todavía no está implementado`, 'FORMAT_PENDING');
  }

  let conceptBySourceKey = {};
  if (meta.needsConceptMapping) {
    conceptBySourceKey = await effectiveConceptMap(tenantId, formatCode);
  }

  const { records, skipped } = await service.buildRecords(tenantId, year, conceptBySourceKey);
  return { meta, service, records, skipped };
}

async function generate(tenantId, formatCode, year) {
  const { service, records, skipped } = await resolveRecords(tenantId, formatCode, year);

  const files = buildMuiscaFiles({
    formatCode,
    version: service.version,
    recordElementName: service.recordElementName,
    records,
    totalValueField: service.totalValueField,
    year,
    fecInicial: `${year}-01-01`,
    fecFinal: `${year}-12-31`,
  });

  if (files.length === 1) {
    return {
      filename: files[0].filename,
      buffer: Buffer.from(files[0].content, 'latin1'),
      contentType: 'application/xml',
      recordCount: files[0].recordCount,
      skipped,
    };
  }

  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.filename, Buffer.from(file.content, 'latin1'));
  }
  return {
    filename: `Exogena-${formatCode}-${year}.zip`,
    buffer: zip.toBuffer(),
    contentType: 'application/zip',
    recordCount: files.reduce((sum, f) => sum + f.recordCount, 0),
    skipped,
  };
}

/**
 * Misma información del XML, en Excel legible (columnas con nombre, totales
 * y hoja de registros excluidos) — para revisión con el contador o para
 * compartir sin acceso a Pitbox. No reemplaza el XML que se sube a la DIAN.
 * @returns {{ filename: string, buffer: Buffer, contentType: string, recordCount: number }}
 */
async function generateExcel(tenantId, formatCode, year, tenant) {
  const { meta, service, records, skipped } = await resolveRecords(tenantId, formatCode, year);
  const { buildExogenaWorkbook } = require('./exogenaExcel.service');
  const buffer = await buildExogenaWorkbook({
    formatCode, formatName: meta.name, version: service.version, year, records, skipped, tenant,
    totalValueField: service.totalValueField,
  });
  return {
    filename: `Exogena-${formatCode}-${year}.xlsx`,
    buffer: Buffer.from(buffer),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    recordCount: records.length,
  };
}

module.exports = { generate, generateExcel, effectiveConceptMap, ExogenaGenerationError };
