// Ajustes de precio de venta AJP- (ver services/inventory/priceAdjustment.service.js).
// Base: /api/inventory/price-adjustments (roles en routes/inventory/priceAdjustments.routes.js)
const svc = require('../../services/inventory/priceAdjustment.service');
const audit = require('../../utils/audit');

const tenantOf = (req) => req.user?.tenant_id || null;

const fail = (res, error, fallback) => {
  if (error instanceof svc.PriceAdjustmentError) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
};

const withTenant = (fallback, fn) => async (req, res) => {
  const tenantId = tenantOf(req);
  if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
  try {
    await fn(req, res, tenantId);
  } catch (error) {
    fail(res, error, fallback);
  }
};

// GET /  ?page&limit&search
const list = withTenant('Error al obtener los ajustes de precio', async (req, res, tenantId) => {
  res.json({ success: true, data: await svc.listPriceAdjustments(tenantId, req.query) });
});

// GET /:id
const getById = withTenant('Error al obtener el ajuste de precio', async (req, res, tenantId) => {
  res.json({ success: true, data: await svc.getPriceAdjustment(tenantId, req.params.id) });
});

// GET /product/:productId -- historial de la ficha del producto
const productHistory = withTenant('Error al obtener el historial de precios', async (req, res, tenantId) => {
  res.json({ success: true, data: await svc.getProductPriceHistory(tenantId, req.params.productId) });
});

// POST /products-info { product_ids: [] } -- costos, margen y sugerido para armar el ajuste
const productsInfo = withTenant('Error al cargar los productos', async (req, res, tenantId) => {
  res.json({ success: true, data: await svc.getProductsInfo(tenantId, req.body?.product_ids) });
});

// POST / { reason, notes, items: [{ product_id, new_price, reference_cost, margin_pct }] }
const create = withTenant('Error al guardar el ajuste de precio', async (req, res, tenantId) => {
  const result = await svc.createPriceAdjustment(tenantId, req.user.id, req.body || {});
  setImmediate(() => audit({
    tenant_id: tenantId, user_id: req.user.id, action: 'PRICE_ADJUSTMENT_CREATED',
    entity: 'price_adjustment', entity_id: result.adjustment.id,
    changes: { number: result.adjustment.adjustment_number, items: result.items_count, reason: result.adjustment.reason },
    req,
  }));
  res.status(201).json({
    success: true,
    message: `Ajuste ${result.adjustment.adjustment_number} guardado: ${result.prices_changed} precio(s)`
      + (result.margins_changed ? ` y ${result.margins_changed} margen(es)` : '') + ' actualizado(s)',
    data: result,
  });
});

module.exports = { list, getById, productHistory, productsInfo, create };
