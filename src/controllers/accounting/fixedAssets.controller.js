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
//   POST   /api/accounting/fixed-assets/:id/dispose      → dispose (dar de baja)

const { FixedAsset, FixedAssetDepreciationEntry, ChartOfAccount, JournalEntry } = require('../../models');
const { runDepreciationForTenant, lastClosedPeriod } = require('../../services/accounting/fixedAssetDepreciation.service');
const logger = require('../../config/logger');

const CATEGORIES = ['vehiculo', 'maquinaria', 'equipo_computo', 'muebles_enseres', 'otro'];
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const ACCOUNT_INCLUDES = [
  { model: ChartOfAccount, as: 'asset_account', attributes: ['id', 'code', 'name'] },
  { model: ChartOfAccount, as: 'accumulated_depreciation_account', attributes: ['id', 'code', 'name'] },
];

function bookValue(asset, accumulatedDepreciation) {
  return Number(asset.acquisition_cost) - Number(accumulatedDepreciation || 0);
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

    const assets = await FixedAsset.findAll({
      where,
      include: ACCOUNT_INCLUDES,
      order: [['acquisition_date', 'DESC']],
    });

    const latestByAsset = await getLatestAccumulatedByAsset(assets.map((a) => a.id));

    const data = assets.map((a) => {
      const accumulated = Number(latestByAsset[a.id]?.accumulated_after || 0);
      return { ...a.toJSON(), accumulated_depreciation: accumulated, book_value: bookValue(a, accumulated) };
    });

    res.json({ success: true, data });
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

    const byCategory = {};
    const totals = { acquisition_cost: 0, accumulated_depreciation: 0, book_value: 0 };

    for (const a of assets) {
      const accumulated = Number(latestByAsset[a.id]?.accumulated_after || 0);
      const value = bookValue(a, accumulated);
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

    res.json({
      success: true,
      data: created,
      message: created.length
        ? `Se generaron ${created.length} entradas de depreciación hasta ${period}.`
        : `No había depreciación pendiente hasta ${period}.`,
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
      include: ACCOUNT_INCLUDES,
    });
    if (!asset) return res.status(404).json({ success: false, message: 'Activo fijo no encontrado' });

    const entries = await FixedAssetDepreciationEntry.findAll({
      where: { fixed_asset_id: asset.id },
      include: [{ model: JournalEntry, as: 'journal_entry', attributes: ['id', 'entry_number', 'status'] }],
      order: [['period', 'ASC']],
    });

    const accumulated = entries.length ? Number(entries[entries.length - 1].accumulated_after) : 0;

    res.json({
      success: true,
      data: {
        ...asset.toJSON(),
        accumulated_depreciation: accumulated,
        book_value: bookValue(asset, accumulated),
        depreciation_entries: entries,
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
    } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `Categoría inválida. Debe ser una de: ${CATEGORIES.join(', ')}` });
    }
    if (!acquisition_cost || parseFloat(acquisition_cost) <= 0) {
      return res.status(400).json({ success: false, message: 'El costo de adquisición debe ser mayor a 0' });
    }
    if (!acquisition_date) return res.status(400).json({ success: false, message: 'La fecha de adquisición es obligatoria' });
    if (!useful_life_months || parseInt(useful_life_months, 10) <= 0) {
      return res.status(400).json({ success: false, message: 'La vida útil (en meses) debe ser mayor a 0' });
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

    const asset = await FixedAsset.create({
      tenant_id: req.tenant_id,
      branch_id: branch_id || null,
      name,
      category: category || 'otro',
      acquisition_cost: parseFloat(acquisition_cost),
      acquisition_date,
      useful_life_months: parseInt(useful_life_months, 10),
      salvage_value: salvage,
      depreciation_method: 'linea_recta',
      asset_account_id,
      accumulated_depreciation_account_id,
      status: 'activo',
      created_by: req.user_id || req.user?.id || null,
    });

    res.status(201).json({ success: true, data: asset });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
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
        message: 'Este activo ya tiene depreciación generada: no se puede cambiar el costo, la fecha de compra, la vida útil ni el valor residual.',
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
    if (asset.status === 'dado_de_baja') {
      return res.status(409).json({ success: false, message: 'El activo ya está dado de baja' });
    }

    const { disposal_date, disposal_reason } = req.body;
    if (!disposal_date) return res.status(400).json({ success: false, message: 'La fecha de baja es obligatoria' });

    // Solo detiene la depreciación futura (el job mensual solo toma
    // status='activo') -- NO genera el asiento de baja del activo. Ver nota
    // del plan de Fase 1: se deja como caso aparte a implementar si se
    // necesita (retiro de activo bruto + depreciación acumulada del
    // balance, reconocimiento de utilidad/pérdida en venta si aplica).
    await asset.update({ status: 'dado_de_baja', disposal_date, disposal_reason: disposal_reason || null });

    res.json({
      success: true,
      data: asset,
      message: 'Activo dado de baja. La depreciación futura queda detenida; el asiento de retiro contable, si se necesita, debe registrarse manualmente.',
    });
  } catch (error) {
    logger.error('Error en fixedAssets.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al dar de baja el activo fijo', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
