// backend/src/controllers/accounting/ica.controller.js
//
// ICA por municipio: configuración (municipios, actividades CIIU, sede →
// municipio), pre-liquidación y causación contable. Ver
// services/tax/ica.service.js.
const { IcaMunicipality, IcaActivity, IcaSettlement, Branch } = require('../../models');
const { computeIcaReport, causeIca, causeAutoIca, voidSettlement } = require('../../services/tax/ica.service');
const audit = require('../../utils/audit');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  return res.status(400).json({ success: false, message: error.message || message });
};

const cleanPrefixes = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
  .map((p) => String(p).trim())
  .filter((p) => /^\d+$/.test(p));

const MUNICIPALITY_FIELDS = ['city_code', 'city_name', 'periodicity', 'avisos_tableros', 'avisos_pct', 'bomberil_pct', 'autoica_enabled', 'round_thousands', 'is_active'];

function municipalityData(body) {
  const data = {};
  for (const f of MUNICIPALITY_FIELDS) if (body[f] !== undefined) data[f] = body[f];
  if (body.excluded_account_prefixes !== undefined) data.excluded_account_prefixes = cleanPrefixes(body.excluded_account_prefixes);
  return data;
}

function activityData(body) {
  return {
    ciiu_code: body.ciiu_code || null,
    description: String(body.description || '').trim(),
    rate: Number(body.rate) || 0,
    autoica_rate: body.autoica_rate === '' || body.autoica_rate == null ? null : Number(body.autoica_rate),
    account_prefixes: cleanPrefixes(body.account_prefixes),
    is_default: !!body.is_default,
  };
}

// GET /api/accounting/ica/config
exports.getConfig = async (req, res) => {
  try {
    const [municipalities, branches] = await Promise.all([
      IcaMunicipality.findAll({
        where: { tenant_id: req.tenant_id },
        include: [{ model: IcaActivity, as: 'activities' }],
        order: [['city_name', 'ASC'], [{ model: IcaActivity, as: 'activities' }, 'ciiu_code', 'ASC']],
      }),
      Branch.findAll({ where: { tenant_id: req.tenant_id }, attributes: ['id', 'name', 'city', 'is_main', 'is_active', 'ica_municipality_id'], order: [['name', 'ASC']] }),
    ]);
    res.json({ success: true, data: { municipalities, branches } });
  } catch (error) {
    logger.error('Error obteniendo configuración ICA:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo la configuración de ICA' });
  }
};

// POST /api/accounting/ica/municipalities
exports.createMunicipality = async (req, res) => {
  try {
    const data = municipalityData(req.body);
    if (!data.city_name) return res.status(400).json({ success: false, message: 'El municipio es obligatorio' });
    const mun = await IcaMunicipality.create({ ...data, tenant_id: req.tenant_id });
    res.status(201).json({ success: true, data: mun });
  } catch (error) {
    fail(res, error, 'Error creando municipio');
  }
};

// PUT /api/accounting/ica/municipalities/:id
exports.updateMunicipality = async (req, res) => {
  try {
    const mun = await IcaMunicipality.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!mun) return res.status(404).json({ success: false, message: 'Municipio no encontrado' });
    await mun.update(municipalityData(req.body));
    res.json({ success: true, data: mun });
  } catch (error) {
    fail(res, error, 'Error actualizando municipio');
  }
};

// DELETE /api/accounting/ica/municipalities/:id
exports.deleteMunicipality = async (req, res) => {
  try {
    const mun = await IcaMunicipality.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!mun) return res.status(404).json({ success: false, message: 'Municipio no encontrado' });
    const used = await IcaSettlement.count({ where: { tenant_id: req.tenant_id, municipality_id: mun.id } });
    if (used) return res.status(409).json({ success: false, message: 'El municipio tiene causaciones registradas: desactívelo en lugar de eliminarlo' });
    await mun.destroy();
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 'Error eliminando municipio');
  }
};

// PUT /api/accounting/ica/municipalities/:id/activities -- reemplaza la lista
exports.setActivities = async (req, res) => {
  try {
    const mun = await IcaMunicipality.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!mun) return res.status(404).json({ success: false, message: 'Municipio no encontrado' });
    const list = (Array.isArray(req.body.activities) ? req.body.activities : []).map(activityData);
    if (list.some((a) => !a.description)) return res.status(400).json({ success: false, message: 'Cada actividad necesita una descripción' });
    if (list.some((a) => a.rate < 0 || a.rate > 100)) return res.status(400).json({ success: false, message: 'La tarifa (‰) debe estar entre 0 y 100' });
    if (list.filter((a) => a.is_default).length > 1) return res.status(400).json({ success: false, message: 'Solo una actividad puede ser la de por defecto' });

    await IcaActivity.destroy({ where: { tenant_id: req.tenant_id, municipality_id: mun.id } });
    const created = await IcaActivity.bulkCreate(list.map((a) => ({ ...a, tenant_id: req.tenant_id, municipality_id: mun.id })));
    res.json({ success: true, data: created });
  } catch (error) {
    fail(res, error, 'Error guardando actividades');
  }
};

// PUT /api/accounting/ica/branches -- { assignments: [{ branch_id, municipality_id }] }
exports.assignBranches = async (req, res) => {
  try {
    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : [];
    for (const a of assignments) {
      if (a.municipality_id) {
        const mun = await IcaMunicipality.findOne({ where: { id: a.municipality_id, tenant_id: req.tenant_id } });
        if (!mun) return res.status(400).json({ success: false, message: 'Municipio no encontrado' });
      }
      await Branch.update({ ica_municipality_id: a.municipality_id || null }, { where: { id: a.branch_id, tenant_id: req.tenant_id } });
    }
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 'Error asignando sedes');
  }
};

const reportParams = (src) => ({ municipalityId: src.municipality_id, dateFrom: src.date_from, dateTo: src.date_to });

// GET /api/accounting/ica/report?municipality_id=&date_from=&date_to=
exports.report = async (req, res) => {
  try {
    const data = await computeIcaReport(req.tenant_id, reportParams(req.query));
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error calculando el ICA');
  }
};

// GET /api/accounting/ica/settlements?municipality_id=
exports.listSettlements = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.municipality_id) where.municipality_id = req.query.municipality_id;
    const rows = await IcaSettlement.findAll({
      where,
      include: [{ model: IcaMunicipality, as: 'municipality', attributes: ['id', 'city_name'] }],
      order: [['date_from', 'DESC'], ['created_at', 'DESC']],
      limit: 100,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('Error listando causaciones ICA:', error);
    res.status(500).json({ success: false, message: 'Error listando causaciones de ICA' });
  }
};

// POST /api/accounting/ica/settlements -- { kind: 'ica'|'autoica', municipality_id, date_from, date_to }
exports.createSettlement = async (req, res) => {
  try {
    const params = reportParams(req.body);
    const settlement = req.body.kind === 'autoica'
      ? await causeAutoIca(req.tenant_id, params, req.user?.id)
      : await causeIca(req.tenant_id, params, req.user?.id);
    setImmediate(() => audit({
      tenant_id: req.tenant_id, user_id: req.user?.id, action: settlement.kind === 'autoica' ? 'ICA_AUTORETENTION' : 'ICA_SETTLEMENT',
      entity: 'ica_settlement', entity_id: settlement.id,
      changes: { municipality_id: settlement.municipality_id, date_from: settlement.date_from, date_to: settlement.date_to, tax_amount: settlement.tax_amount },
      req,
    }));
    res.status(201).json({ success: true, message: settlement.kind === 'autoica' ? 'Autorretención contabilizada' : 'ICA causado y contabilizado', data: settlement });
  } catch (error) {
    fail(res, error, 'Error causando ICA');
  }
};

// PATCH /api/accounting/ica/settlements/:id/void -- { reason }
exports.voidSettlement = async (req, res) => {
  try {
    const settlement = await voidSettlement(req.tenant_id, req.params.id, req.user?.id, req.body.reason);
    res.json({ success: true, message: 'Causación anulada', data: settlement });
  } catch (error) {
    fail(res, error, 'Error anulando la causación');
  }
};
