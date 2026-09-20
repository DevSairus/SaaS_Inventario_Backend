// backend/src/controllers/accounting/exogena.controller.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Endpoints:
//   GET    /api/accounting/exogena/formats                    → list (catálogo + config del tenant)
//   PUT    /api/accounting/exogena/formats/:code               → toggle (habilitar/deshabilitar)
//   GET    /api/accounting/exogena/formats/:code/concepts      → getConcepts
//   PUT    /api/accounting/exogena/formats/:code/concepts      → saveConcepts
//   GET    /api/accounting/exogena/formats/:code/readiness     → readiness
//   GET    /api/accounting/exogena/formats/:code/generate      → generateFile (descarga)
//   GET    /api/accounting/exogena/manual-records              → listManualRecords
//   POST   /api/accounting/exogena/manual-records               → createManualRecord
//   PUT    /api/accounting/exogena/manual-records/:id            → updateManualRecord
//   DELETE /api/accounting/exogena/manual-records/:id            → deleteManualRecord
//   GET    /api/accounting/exogena/shareholders                  → listShareholders
//   POST   /api/accounting/exogena/shareholders                  → createShareholder
//   PUT    /api/accounting/exogena/shareholders/:id               → updateShareholder
//   DELETE /api/accounting/exogena/shareholders/:id               → deleteShareholder

const { ExogenaFormatConfig, ExogenaConceptMapping, ExogenaManualRecord, ExogenaShareholder } = require('../../models');
const { EXOGENA_FORMATS, EXOGENA_FORMAT_BY_CODE, EXOGENA_DOCUMENT_TYPES } = require('../../data/exogena-catalogs');
const { SUGGESTED_CONCEPTS } = require('../../data/exogena-concept-suggestions');
const { checkReadiness } = require('../../services/exogena/exogenaReadiness.service');
const { generate, ExogenaGenerationError } = require('../../services/exogena/exogenaGenerator.service');
const FORMAT_SERVICES = require('../../services/exogena/formatServices');
const logger = require('../../config/logger');

function requireKnownFormat(code, res) {
  const meta = EXOGENA_FORMAT_BY_CODE[code];
  if (!meta) {
    res.status(404).json({ success: false, message: `Formato ${code} no existe en el catálogo de Exógena` });
    return null;
  }
  return meta;
}

// GET /exogena/formats
exports.list = async (req, res) => {
  try {
    const configs = await ExogenaFormatConfig.findAll({ where: { tenant_id: req.tenant_id } });
    const configByCode = Object.fromEntries(configs.map((c) => [c.format_code, c]));

    const data = EXOGENA_FORMATS.map((f) => ({
      ...f,
      is_enabled: configByCode[f.code]?.is_enabled || false,
    }));

    res.json({ success: true, data, document_types: EXOGENA_DOCUMENT_TYPES });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar formatos de Exógena', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /exogena/formats/:code  { is_enabled }
exports.toggle = async (req, res) => {
  try {
    const meta = requireKnownFormat(req.params.code, res);
    if (!meta) return;

    const [config] = await ExogenaFormatConfig.findOrCreate({
      where: { tenant_id: req.tenant_id, format_code: req.params.code },
      defaults: { is_enabled: false },
    });
    await config.update({ is_enabled: Boolean(req.body.is_enabled) });

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el formato', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /exogena/formats/:code/concepts?year=
exports.getConcepts = async (req, res) => {
  try {
    const meta = requireKnownFormat(req.params.code, res);
    if (!meta) return;
    if (!meta.needsConceptMapping) {
      return res.json({ success: true, data: { needs_mapping: false, source_keys: [], mappings: [] } });
    }

    const service = FORMAT_SERVICES[req.params.code];
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const sourceKeys = await service.fetchSourceKeys(req.tenant_id, year);
    const mappings = await ExogenaConceptMapping.findAll({ where: { tenant_id: req.tenant_id, format_code: req.params.code } });

    res.json({
      success: true,
      data: {
        needs_mapping: true,
        source_keys: sourceKeys,
        mappings,
        // Sugerencias tomadas literalmente de la tabla de conceptos de la
        // Resolución 000227/2025 (ver exogena-concept-suggestions.js) --
        // el front las precarga como valor editable, no las aplica solo.
        suggestions: SUGGESTED_CONCEPTS[req.params.code] || {},
      },
    });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los conceptos del formato', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /exogena/formats/:code/concepts  { mappings: [{ source_key, concept_code }] }
exports.saveConcepts = async (req, res) => {
  try {
    const meta = requireKnownFormat(req.params.code, res);
    if (!meta) return;

    const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];
    for (const m of mappings) {
      if (!m.source_key || !m.concept_code) continue;
      await ExogenaConceptMapping.upsert({
        tenant_id: req.tenant_id,
        format_code: req.params.code,
        source_key: m.source_key,
        concept_code: String(m.concept_code).trim(),
      }, { conflictFields: ['tenant_id', 'format_code', 'source_key'] });
    }

    const saved = await ExogenaConceptMapping.findAll({ where: { tenant_id: req.tenant_id, format_code: req.params.code } });
    res.json({ success: true, data: saved });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al guardar los conceptos del formato', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /exogena/formats/:code/readiness?year=
exports.readiness = async (req, res) => {
  try {
    const meta = requireKnownFormat(req.params.code, res);
    if (!meta) return;

    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const data = await checkReadiness(req.tenant_id, req.params.code, year);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al validar el formato', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /exogena/formats/:code/generate?year=
exports.generateFile = async (req, res) => {
  try {
    const meta = requireKnownFormat(req.params.code, res);
    if (!meta) return;

    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { filename, buffer, contentType } = await generate(req.tenant_id, req.params.code, year);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    if (error instanceof ExogenaGenerationError) {
      return res.status(400).json({ success: false, message: error.message, code: error.code });
    }
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al generar el archivo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// ── Registros manuales (hoy solo Formato 1004) ──────────────────────

// GET /exogena/manual-records?format_code=1004&year=2025
exports.listManualRecords = async (req, res) => {
  try {
    const { format_code, year } = req.query;
    if (!format_code || !year) {
      return res.status(400).json({ success: false, message: 'format_code y year son obligatorios' });
    }
    const rows = await ExogenaManualRecord.findAll({
      where: { tenant_id: req.tenant_id, format_code, fiscal_year: parseInt(year, 10) },
      order: [['created_at', 'ASC']],
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar los registros manuales', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /exogena/manual-records
exports.createManualRecord = async (req, res) => {
  try {
    const { format_code, fiscal_year, third_party_document_type, third_party_tax_id, payload } = req.body;
    if (!format_code || !fiscal_year || !third_party_document_type || !third_party_tax_id) {
      return res.status(400).json({ success: false, message: 'format_code, fiscal_year, third_party_document_type y third_party_tax_id son obligatorios' });
    }
    const row = await ExogenaManualRecord.create({
      tenant_id: req.tenant_id,
      format_code,
      fiscal_year: parseInt(fiscal_year, 10),
      third_party_document_type,
      third_party_tax_id,
      payload: payload || {},
      created_by: req.user_id || req.user?.id || null,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe un registro para este tercero, formato y año' });
    }
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear el registro manual', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /exogena/manual-records/:id
exports.updateManualRecord = async (req, res) => {
  try {
    const row = await ExogenaManualRecord.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!row) return res.status(404).json({ success: false, message: 'Registro no encontrado' });

    const { third_party_document_type, third_party_tax_id, payload } = req.body;
    await row.update({
      ...(third_party_document_type !== undefined ? { third_party_document_type } : {}),
      ...(third_party_tax_id !== undefined ? { third_party_tax_id } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el registro manual', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// DELETE /exogena/manual-records/:id
exports.deleteManualRecord = async (req, res) => {
  try {
    const row = await ExogenaManualRecord.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!row) return res.status(404).json({ success: false, message: 'Registro no encontrado' });
    await row.destroy();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el registro manual', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// ── Composición societaria (Formato 1010) ───────────────────────────

// GET /exogena/shareholders?year=2025
exports.listShareholders = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    if (!year) return res.status(400).json({ success: false, message: 'year es obligatorio' });
    const rows = await ExogenaShareholder.findAll({
      where: { tenant_id: req.tenant_id, fiscal_year: year },
      order: [['created_at', 'ASC']],
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar los socios/accionistas', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /exogena/shareholders
exports.createShareholder = async (req, res) => {
  try {
    const {
      fiscal_year, document_type, tax_id, first_name, last_name, business_name,
      address, city_code, country_code, nominal_value, premium_value, participation_percentage,
    } = req.body;

    if (!fiscal_year || !document_type || !tax_id || participation_percentage === undefined) {
      return res.status(400).json({ success: false, message: 'fiscal_year, document_type, tax_id y participation_percentage son obligatorios' });
    }

    const row = await ExogenaShareholder.create({
      tenant_id: req.tenant_id,
      fiscal_year: parseInt(fiscal_year, 10),
      document_type,
      tax_id,
      first_name: first_name || null,
      last_name: last_name || null,
      business_name: business_name || null,
      address: address || null,
      city_code: city_code || null,
      country_code: country_code || '169',
      nominal_value: nominal_value || 0,
      premium_value: premium_value || 0,
      participation_percentage,
      created_by: req.user_id || req.user?.id || null,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe un socio con esta identificación para este año' });
    }
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear el socio/accionista', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /exogena/shareholders/:id
exports.updateShareholder = async (req, res) => {
  try {
    const row = await ExogenaShareholder.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!row) return res.status(404).json({ success: false, message: 'Socio/accionista no encontrado' });

    const fields = [
      'document_type', 'tax_id', 'first_name', 'last_name', 'business_name',
      'address', 'city_code', 'country_code', 'nominal_value', 'premium_value', 'participation_percentage',
    ];
    const updates = {};
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    await row.update(updates);
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el socio/accionista', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// DELETE /exogena/shareholders/:id
exports.deleteShareholder = async (req, res) => {
  try {
    const row = await ExogenaShareholder.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!row) return res.status(404).json({ success: false, message: 'Socio/accionista no encontrado' });
    await row.destroy();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error en exogena.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el socio/accionista', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
