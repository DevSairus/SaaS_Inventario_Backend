// Márgenes de ganancia por categoría y global (ver
// services/inventory/productMargin.service.js).
const {
  MarginError, getMarginOverview, previewMarginChange, applyMarginChange,
} = require('../../services/inventory/productMargin.service');

const tenantOf = (req) => req.user?.tenant_id || null;

const fail = (res, error, fallback) => {
  if (error instanceof MarginError) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
};

const marginParams = (body = {}) => ({
  scope: body.scope,
  category_id: body.category_id || null,
  margin: body.margin,
  force: body.force === true,
  recalc_prices: body.recalc_prices !== false,
  allow_decrease: body.allow_decrease === true,
});

const getMargins = async (req, res) => {
  const tenantId = tenantOf(req);
  if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
  try {
    res.json({ success: true, data: await getMarginOverview(tenantId) });
  } catch (error) {
    fail(res, error, 'Error al obtener los márgenes de ganancia');
  }
};

const previewMargin = async (req, res) => {
  const tenantId = tenantOf(req);
  if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
  try {
    res.json({ success: true, data: await previewMarginChange(tenantId, marginParams(req.body)) });
  } catch (error) {
    fail(res, error, 'Error al calcular la vista previa del margen');
  }
};

const applyMargin = async (req, res) => {
  const tenantId = tenantOf(req);
  if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
  try {
    const result = await applyMarginChange(tenantId, marginParams(req.body));
    res.json({ success: true, message: 'Margen aplicado', data: result });
  } catch (error) {
    fail(res, error, 'Error al aplicar el margen');
  }
};

module.exports = { getMargins, previewMargin, applyMargin };
