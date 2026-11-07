// backend/src/controllers/accounting/fixedAssets.controller.js
//
// Activos Fijos y Depreciación — Fase 1 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 1.
//
// Endpoints:
//   GET    /api/accounting/fixed-assets                 → list
//   GET    /api/accounting/fixed-assets/report           → report
//   POST   /api/accounting/fixed-assets/run-depreciation → runDepreciation (manual/catch-up)
//   GET    /api/accounting/fixed-assets/:id              → getById (incluye histórico de depreciación)
//   POST   /api/accounting/fixed-assets                  → create
//   PUT    /api/accounting/fixed-assets/:id              → update
//   POST   /api/accounting/fixed-assets/:id/dispose      → dispose (retiro o venta, con asiento)
//   POST   /api/accounting/fixed-assets/:id/change-estimate → changeEstimate (vida útil / valor residual hacia adelante)

const {
  FixedAsset, FixedAssetDepreciationEntry, FixedAssetImpairment, FixedAssetUsage, ChartOfAccount, JournalEntry, Tenant,
} = require('../../models');
const { FISCAL_MAX_RATES, fiscalReport } = require('../../services/accounting/fixedAssetFiscal.service');
const {
  runDepreciationForTenant, lastClosedPeriod, openingFields, openingAccumulated, changeEstimate, disposeAsset,
  registerImpairment, reverseImpairment, recordUsage,
} = require('../../services/accounting/fixedAssetDepreciation.service');
const logger = require('../../config/logger');
const { parsePagination, buildPagination } = require('../../utils/pagination');

const CATEGORIES = ['vehiculo', 'maquinaria', 'equipo_computo', 'equipo_comunicacion', 'muebles_enseres', 'construcciones', 'terrenos', 'otro'];
const METHODS = ['linea_recta', 'saldos_decrecientes', 'unidades_produccion', 'menor_cuantia', 'no_deprecia'];
const LOW_VALUE_UVT = 50; // activos de menor cuantía (art. 1.2.1.18.7 DUR 1625/2016)

// UVT vigente: la del perfil fiscal del negocio o la del año (retenciones).
async function uvtOf(tenantId) {
  const { DEFAULT_UVT_VALUE } = require('../../data/retention-concepts-default');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'tax_config'] });
  const own = Number(tenant?.tax_config?.fiscal_profile?.uvt_value);
  return own > 0 ? own : DEFAULT_UVT_VALUE;
}

// Deterioro total por activo, en un solo query.
async function getImpairedByAsset(assetIds) {
  if (!assetIds.length) return {};
  const rows = await FixedAssetImpairment.findAll({ where: { fixed_asset_id: assetIds }, attributes: ['fixed_asset_id', 'amount'] });
  const out = {};
  for (const r of rows) out[r.fixed_asset_id] = Math.round(((out[r.fixed_asset_id] || 0) + Number(r.amount)) * 100) / 100;
  return out;
}
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const ACCOUNT_INCLUDES = [
  { model: ChartOfAccount, as: 'asset_account', attributes: ['id', 'code', 'name'] },
  { model: ChartOfAccount, as: 'accumulated_depreciation_account', attributes: ['id', 'code', 'name'] },
];

function bookValue(asset, accumulatedDepreciation, impaired = 0) {
  return Number(asset.acquisition_cost) - Number(accumulatedDepreciation || 0) - Number(impaired || 0);
}

// Último accumulated_after por activo, en un solo query (evita N+1 en list/report).
async function getLatestAccumulatedByAsset(assetIds) {
  if (!assetIds.length) return {};
  const latestEntries = await FixedAssetDepreciationEntry.findAll({
    where: { fixed_asset_id: assetIds },
    order: [['period', 'DESC']],
  });
  const byAsset = {};
  for (const e of latestEntries) {
    if (!byAsset[e.fixed_asset_id]) byAsset[e.fixed_asset_id] = e; // ya viene ordenado DESC, se queda con el primero visto
  }
  return byAsset;
}

// GET /fixed-assets
exports.list = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.status) where.status = req.query.status;
    if (req.query.branch_id) where.branch_id = req.query.branch_id;
    if (req.query.category) where.category = req.query.category;

    const pg = parsePagination(req.query);
    const { rows: assets, count } = await FixedAsset.findAndCountAll({
      where,
      include: ACCOUNT_INCLUDES,
      order: [['acquisition_date', 'DESC'], ['id', 'DESC']],
      limit: pg.limit,
      offset: pg.offset,
      distinct: true,
    });

    const latestByAsset = await getLatestAccumulatedByAsset(assets.map((a) => a.id));
    const impairedByAsset = await getImpairedByAsset(assets.map((a) => a.id));
    const data = assets.map((a) => {
      const accumulated = latestByAsset[a.id] ? Number(latestByAsset[a.id].accumulated_after) : openingAccumulated(a);
      const impaired = impairedByAsset[a.id] || 0;
      return { ...a.toJSON(), accumulated_depreciation: accumulated, impaired, book_value: bookValue(a, accumulated, impaired) };
    });

    res.json({ success: true, data, pagination: buildPagination(pg, count) });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar activos fijos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /fixed-assets/report — costo histórico, depreciación acumulada y valor
// en libros, agrupado por categoría (y totales generales).
exports.report = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.branch_id) where.branch_id = req.query.branch_id;

    const assets = await FixedAsset.findAll({ where });
    const latestByAsset = await getLatestAccumulatedByAsset(assets.map((a) => a.id));
    const impairedByAsset = await getImpairedByAsset(assets.map((a) => a.id));

    const byCategory = {};
    const totals = { acquisition_cost: 0, accumulated_depreciation: 0, book_value: 0 };

    for (const a of assets) {
      const accumulated = latestByAsset[a.id] ? Number(latestByAsset[a.id].accumulated_after) : openingAccumulated(a);
      const value = bookValue(a, accumulated, impairedByAsset[a.id] || 0);
      const cost = Number(a.acquisition_cost);

      if (!byCategory[a.category]) {
        byCategory[a.category] = {
          category: a.category, count: 0, acquisition_cost: 0, accumulated_depreciation: 0, book_value: 0,
        };
      }
      byCategory[a.category].count += 1;
      byCategory[a.category].acquisition_cost += cost;
      byCategory[a.category].accumulated_depreciation += accumulated;
      byCategory[a.category].book_value += value;

      totals.acquisition_cost += cost;
      totals.accumulated_depreciation += accumulated;
      totals.book_value += value;
    }

    res.json({ success: true, data: { by_category: Object.values(byCategory), totals } });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al generar el reporte de activos fijos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /fixed-assets/run-depreciation — generación manual/catch-up (además
// del job automático del día 1). Útil si el job no corrió, o para adelantar
// la depreciación del mes en curso sin esperar al día 1 del siguiente.
exports.runDepreciation = async (req, res) => {
  try {
    const period = req.body?.period || lastClosedPeriod();
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'Período inválido, formato esperado YYYY-MM' });
    }

    const userId = req.user_id || req.user?.id || null;
    const created = await runDepreciationForTenant(req.tenant_id, { targetPeriod: period, userId });
    const blocked = created.blocked || [];
    const note = blocked.length
      ? ` ${blocked.length} activo(s) se detuvieron en un período contable cerrado (${blocked.slice(0, 3).map((b) => `${b.name}: ${b.period}`).join(', ')}): no se depreció ese mes. Si ya está depreciado por fuera, registra su saldo inicial.`
      : '';

    res.json({
      success: true,
      data: created,
      blocked,
      message: (created.length
        ? `Se generaron ${created.length} entradas de depreciación hasta ${period}.`
        : `No había depreciación pendiente hasta ${period}.`) + note,
    });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al generar la depreciación', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /fixed-assets/:id
exports.getById = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: [...ACCOUNT_INCLUDES,
        { model: ChartOfAccount, as: 'sale_account', attributes: ['id', 'code', 'name'], required: false },
        { model: JournalEntry, as: 'disposal_entry', attributes: ['id', 'entry_number', 'status'], required: false }],
    });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });

    const entries = await FixedAssetDepreciationEntry.findAll({
      where: { fixed_asset_id: asset.id },
      include: [{ model: JournalEntry, as: 'journal_entry', attributes: ['id', 'entry_number', 'status'] }],
      order: [['period', 'ASC']],
    });

    const accumulated = entries.length ? Number(entries[entries.length - 1].accumulated_after) : openingAccumulated(asset);
    const impairments = await FixedAssetImpairment.findAll({
      where: { fixed_asset_id: asset.id },
      include: [{ model: JournalEntry, as: 'journal_entry', attributes: ['id', 'entry_number', 'status'] }],
      order: [['impairment_date', 'ASC']],
    });
    const impaired = impairments.reduce((s, i) => s + Number(i.amount), 0);
    const usage = await FixedAssetUsage.findAll({ where: { fixed_asset_id: asset.id }, order: [['period', 'ASC']] });

    res.json({
      success: true,
      data: {
        ...asset.toJSON(),
        accumulated_depreciation: accumulated,
        impaired,
        book_value: bookValue(asset, accumulated, impaired),
        depreciation_entries: entries,
        impairments,
        usage,
      },
    });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el activo fijo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /fixed-assets
exports.create = async (req, res) => {
  try {
    const {
      name, category, branch_id, acquisition_cost, acquisition_date, useful_life_months,
      salvage_value, asset_account_id, accumulated_depreciation_account_id,
      opening_accumulated_depreciation, opening_period, remaining_months,
      depreciation_method, project_id, total_units, unit_label, fiscal_max_rate, fiscal_opening_accumulated,
      fiscal_cost, fiscal_salvage_value,
    } = req.body;
    const cat = category || 'otro';
    const method = cat === 'terrenos' ? 'no_deprecia' : (depreciation_method || 'linea_recta');
    if (!METHODS.includes(method)) return res.status(400).json({ success: false, message: 'Método de depreciación inválido' });

    if (!name) return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `Categoría inválida. Debe ser una de: ${CATEGORIES.join(', ')}` });
    }
    if (!acquisition_cost || parseFloat(acquisition_cost) <= 0) {
      return res.status(400).json({ success: false, message: 'El costo de adquisición debe ser mayor a 0' });
    }
    if (!acquisition_date) return res.status(400).json({ success: false, message: 'La fecha de adquisición es obligatoria' });
    const needsLife = !['no_deprecia', 'menor_cuantia', 'unidades_produccion'].includes(method);
    if (needsLife && (!useful_life_months || parseInt(useful_life_months, 10) <= 0)) {
      return res.status(400).json({ success: false, message: 'La vida útil (en meses) debe ser mayor a 0' });
    }
    if (method === 'unidades_produccion' && !(Number(total_units) > 0)) {
      return res.status(400).json({ success: false, message: 'Indica las unidades totales que producirá el activo (horas, km o unidades)' });
    }
    if (method === 'menor_cuantia') {
      const limit = LOW_VALUE_UVT * await uvtOf(req.tenant_id);
      if (parseFloat(acquisition_cost) > limit) {
        return res.status(400).json({ success: false, message: `Menor cuantía solo aplica a activos de hasta 50 UVT ($ ${Math.round(limit).toLocaleString('es-CO')})` });
      }
    }
    if (fiscal_max_rate !== undefined && fiscal_max_rate !== null && fiscal_max_rate !== '' && !(Number(fiscal_max_rate) >= 0 && Number(fiscal_max_rate) <= 100)) {
      return res.status(400).json({ success: false, message: 'La tasa fiscal debe estar entre 0 y 100 %' });
    }
    if (!asset_account_id || !accumulated_depreciation_account_id) {
      return res.status(400).json({ success: false, message: 'Debes seleccionar la cuenta del activo y la cuenta de depreciación acumulada' });
    }

    const salvage = salvage_value ? parseFloat(salvage_value) : 0;
    if (salvage < 0 || salvage >= parseFloat(acquisition_cost)) {
      return res.status(400).json({ success: false, message: 'El valor residual debe ser menor al costo de adquisición' });
    }

    const [assetAccount, accumAccount] = await Promise.all([
      ChartOfAccount.findOne({ where: { id: asset_account_id, tenant_id: req.tenant_id } }),
      ChartOfAccount.findOne({ where: { id: accumulated_depreciation_account_id, tenant_id: req.tenant_id } }),
    ]);
    if (!assetAccount) return res.status(404).json({ success: false, message: 'Cuenta del activo no encontrada' });
    if (!accumAccount) return res.status(404).json({ success: false, message: 'Cuenta de depreciación acumulada no encontrada' });

    // Saldo inicial: activo que ya venía depreciándose (otro sistema).
    const lifeMonths = needsLife ? parseInt(useful_life_months, 10) : (parseInt(useful_life_months, 10) || 1);
    const opening = method === 'linea_recta' || method === 'saldos_decrecientes'
      ? openingFields({
        acquisition_cost, salvage_value: salvage, acquisition_date, useful_life_months: lifeMonths,
        opening_accumulated_depreciation, opening_period, remaining_months,
      })
      : {};

    const asset = await FixedAsset.create({
      tenant_id: req.tenant_id,
      branch_id: branch_id || null,
      name,
      category: cat,
      acquisition_cost: parseFloat(acquisition_cost),
      acquisition_date,
      useful_life_months: lifeMonths,
      salvage_value: salvage,
      depreciation_method: method,
      project_id: project_id || null,
      total_units: method === 'unidades_produccion' ? Number(total_units) : null,
      unit_label: method === 'unidades_produccion' ? (unit_label || 'unidades') : null,
      fiscal_max_rate: fiscal_max_rate === undefined || fiscal_max_rate === '' || fiscal_max_rate === null ? null : Number(fiscal_max_rate),
      fiscal_opening_accumulated: fiscal_opening_accumulated === undefined || fiscal_opening_accumulated === '' || fiscal_opening_accumulated === null ? null : Number(fiscal_opening_accumulated),
      fiscal_cost: fiscal_cost === undefined || fiscal_cost === '' || fiscal_cost === null ? null : Number(fiscal_cost),
      fiscal_salvage_value: fiscal_salvage_value === undefined || fiscal_salvage_value === '' || fiscal_salvage_value === null ? null : Number(fiscal_salvage_value),
      asset_account_id,
      accumulated_depreciation_account_id,
      status: 'activo',
      created_by: req.user_id || req.user?.id || null,
      ...opening,
    });

    res.status(201).json({ success: true, data: asset });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    res.status(500).json({ success: false, message: 'Error al crear el activo fijo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /fixed-assets/:id
exports.update = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });
    if (asset.status === 'dado_de_baja') {
      return res.status(409).json({ success: false, message: 'El activo está dado de baja, no se puede editar' });
    }

    const hasDepreciation = await FixedAssetDepreciationEntry.count({ where: { fixed_asset_id: asset.id } });

    const { name, category, branch_id, asset_account_id, accumulated_depreciation_account_id } = req.body;
    const updates = {};

    if (name !== undefined) updates.name = name;
    if (req.body.project_id !== undefined) updates.project_id = req.body.project_id || null;
    if (req.body.fiscal_max_rate !== undefined) updates.fiscal_max_rate = req.body.fiscal_max_rate === '' || req.body.fiscal_max_rate === null ? null : Number(req.body.fiscal_max_rate);
    if (req.body.fiscal_opening_accumulated !== undefined) updates.fiscal_opening_accumulated = req.body.fiscal_opening_accumulated === '' || req.body.fiscal_opening_accumulated === null ? null : Number(req.body.fiscal_opening_accumulated);
    if (req.body.unit_label !== undefined) updates.unit_label = req.body.unit_label || null;
    for (const f of ['fiscal_cost', 'fiscal_salvage_value']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f] === '' || req.body[f] === null ? null : Number(req.body[f]);
    }
    if (branch_id !== undefined) updates.branch_id = branch_id || null;
    if (category !== undefined) {
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: `Categoría inválida. Debe ser una de: ${CATEGORIES.join(', ')}` });
      }
      updates.category = category;
    }
    if (asset_account_id !== undefined) {
      const acc = await ChartOfAccount.findOne({ where: { id: asset_account_id, tenant_id: req.tenant_id } });
      if (!acc) return res.status(404).json({ success: false, message: 'Cuenta del activo no encontrada' });
      updates.asset_account_id = asset_account_id;
    }
    if (accumulated_depreciation_account_id !== undefined) {
      const acc = await ChartOfAccount.findOne({ where: { id: accumulated_depreciation_account_id, tenant_id: req.tenant_id } });
      if (!acc) return res.status(404).json({ success: false, message: 'Cuenta de depreciación acumulada no encontrada' });
      updates.accumulated_depreciation_account_id = accumulated_depreciation_account_id;
    }

    // acquisition_cost/date, useful_life_months y salvage_value solo se
    // pueden tocar mientras no exista NINGUNA depreciación generada -- ya
    // corrida, cambiar la base rompería accumulated_after y el valor en
    // libros de todos los períodos ya contabilizados.
    const touchesBase = req.body.acquisition_cost !== undefined || req.body.acquisition_date !== undefined
      || req.body.useful_life_months !== undefined || req.body.salvage_value !== undefined;

    if (touchesBase && hasDepreciation) {
      return res.status(409).json({
        success: false,
        message: 'Este activo ya tiene depreciación generada: el costo y la fecha de compra no se pueden cambiar. Para cambiar la vida útil o el valor residual usa "Cambiar vida útil" (se aplica hacia adelante).',
      });
    }
    if (touchesBase && !hasDepreciation) {
      const { acquisition_cost, acquisition_date, useful_life_months, salvage_value } = req.body;
      if (acquisition_cost !== undefined) updates.acquisition_cost = parseFloat(acquisition_cost);
      if (acquisition_date !== undefined) updates.acquisition_date = acquisition_date;
      if (useful_life_months !== undefined) updates.useful_life_months = parseInt(useful_life_months, 10);
      if (salvage_value !== undefined) updates.salvage_value = parseFloat(salvage_value);
    }

    await asset.update(updates);
    res.json({ success: true, data: asset });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el activo fijo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /fixed-assets/:id/dispose
exports.dispose = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });
    if (req.body.sale_account_id) {
      const acc = await ChartOfAccount.findOne({ where: { id: req.body.sale_account_id, tenant_id: req.tenant_id } });
      if (!acc) return res.status(404).json({ success: false, message: 'Cuenta de la venta no encontrada' });
    }
    // Deprecia hasta el día de la baja y genera el asiento de retiro o venta.
    const result = await disposeAsset(asset, req.body || {}, req.tenant_id, req.user_id || req.user?.id || null);
    const r = result.result;
    res.json({
      success: true,
      data: { asset, ...result },
      message: asset.disposal_type === 'venta'
        ? `Activo vendido. ${r >= 0 ? 'Utilidad' : 'Pérdida'} de $ ${Math.abs(Math.round(r)).toLocaleString('es-CO')}; asiento ${result.entry?.entry_number || 'en borrador'}.`
        : `Activo retirado. Pérdida por el valor en libros de $ ${Math.round(result.book_value).toLocaleString('es-CO')}; asiento ${result.entry?.entry_number || 'en borrador'}.`,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: `Error al dar de baja el activo fijo: ${error.message}` });
  }
};

// GET /fixed-assets/config — UVT, límite de menor cuantía y tasas fiscales por categoría.
exports.config = async (req, res) => {
  try {
    const uvt = await uvtOf(req.tenant_id);
    res.json({ success: true, data: { uvt, low_value_limit: LOW_VALUE_UVT * uvt, fiscal_max_rates: FISCAL_MAX_RATES, categories: CATEGORIES, methods: METHODS } });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la configuración' });
  }
};

// GET /fixed-assets/fiscal-report?year=YYYY — conciliación contable-fiscal.
exports.fiscalReport = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    res.json({ success: true, data: await fiscalReport(req.tenant_id, year) });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al generar el reporte fiscal' });
  }
};

// POST /fixed-assets/:id/impairments — deterioro de valor con su asiento.
exports.impair = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });
    const userId = req.user_id || req.user?.id || null;
    // reverse=true: reversión (el valor recuperable volvió a subir).
    const reverse = req.body?.reverse === true || req.body?.reverse === 'true';
    const result = reverse
      ? await reverseImpairment(asset, req.body || {}, req.tenant_id, userId)
      : await registerImpairment(asset, req.body || {}, req.tenant_id, userId);
    res.status(201).json({
      success: true,
      data: result,
      message: `${reverse ? 'Reversión' : 'Deterioro'} registrado. Nuevo valor en libros: $ ${Math.round(result.book_value).toLocaleString('es-CO')}; asiento ${result.entry?.entry_number || 'en borrador'}.`,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: `Error al registrar el deterioro: ${error.message}` });
  }
};

// POST /fixed-assets/:id/usage — uso del mes (unidades de producción).
exports.usage = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });
    const row = await recordUsage(asset, req.body || {}, req.tenant_id, req.user_id || req.user?.id || null);
    res.json({ success: true, data: row, message: 'Uso registrado: se depreciará con el cierre del mes' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al registrar el uso' });
  }
};

// POST /fixed-assets/:id/change-estimate — vida útil restante y/o valor
// residual, aplicados hacia adelante (lo ya depreciado no cambia).
exports.changeEstimate = async (req, res) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });
    const result = await changeEstimate(asset, req.body || {}, req.user_id || req.user?.id || null);
    res.json({
      success: true,
      data: { asset, ...result },
      message: result.pending > 0
        ? `Desde ${result.effective_period} se depreciarán $ ${Math.round(result.monthly).toLocaleString('es-CO')} al mes.`
        : 'El activo queda totalmente depreciado.',
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al cambiar la estimación' });
  }
};
