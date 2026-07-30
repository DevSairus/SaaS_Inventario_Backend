const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { Product, ProductVehicleApplication } = require('../../models/inventory');
const VehicleBrand = require('../../models/workshop/VehicleBrand');
const VehicleLine = require('../../models/workshop/VehicleLine');

// GET /products/:id/vehicle-applications
const getProductVehicleApplications = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { product_id: id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const applications = await ProductVehicleApplication.findAll({
      where: whereClause,
      order: [['brand', 'ASC'], ['line', 'ASC'], ['year_from', 'ASC']]
    });

    res.json({ success: true, data: applications });
  } catch (error) {
    console.error('Error en getProductVehicleApplications:', error);
    res.status(500).json({ success: false, message: 'Error al obtener aplicaciones vehiculares' });
  }
};

// POST /products/:id/vehicle-applications
const addVehicleApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const { vehicle_type, brand, line, year_from, year_to, engine, notes } = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;
    if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    // Verificar que el producto existe
    const product = await Product.findOne({ where: { id, tenant_id: tenantId } });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    if (!brand || !line) return res.status(400).json({ success: false, message: 'Marca y línea son requeridos' });

    const validTypes = ['automovil', 'camioneta', 'motocicleta', 'camion', 'otro'];
    const safeType = vehicle_type && validTypes.includes(vehicle_type) ? vehicle_type : null;

    // Buscar o crear en catálogo normalizado
    let brandId = null;
    let lineId = null;
    try {
      const VehicleBrand = require('../../models/workshop/VehicleBrand');
      const VehicleLine = require('../../models/workshop/VehicleLine');

      let brandRecord = await VehicleBrand.findOne({ where: { tenant_id: tenantId, name: brand.trim() } });
      if (!brandRecord) brandRecord = await VehicleBrand.create({ tenant_id: tenantId, name: brand.trim() });
      brandId = brandRecord.id;

      let lineRecord = await VehicleLine.findOne({ where: { brand_id: brandId, name: line.trim() } });
      if (!lineRecord) lineRecord = await VehicleLine.create({ tenant_id: tenantId, brand_id: brandId, name: line.trim() });
      lineId = lineRecord.id;
    } catch (e) {
      // Si falla el catálogo normalizado, continuar sin FKs
    }

    const application = await ProductVehicleApplication.create({
      tenant_id: tenantId,
      product_id: id,
      vehicle_type: safeType,
      brand: brand.trim(),
      line: line.trim(),
      brand_id: brandId,
      line_id: lineId,
      year_from: year_from ? parseInt(year_from) : null,
      year_to: year_to ? parseInt(year_to) : null,
      engine: engine?.trim() || null,
      notes: notes?.trim() || null
    });

    res.status(201).json({ success: true, message: 'Aplicación vehicular agregada', data: application });
  } catch (error) {
    console.error('Error en addVehicleApplication:', error);
    res.status(500).json({ success: false, message: 'Error al agregar aplicación vehicular' });
  }
};

// PUT /products/:id/vehicle-applications/:appId
const updateVehicleApplication = async (req, res) => {
  try {
    const { id, appId } = req.params;
    const { vehicle_type, brand, line, year_from, year_to, engine, notes } = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { id: appId, product_id: id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const application = await ProductVehicleApplication.findOne({ where: whereClause });
    if (!application) return res.status(404).json({ success: false, message: 'Aplicación no encontrada' });

    const updateData = {};
    if (brand !== undefined) updateData.brand = brand.trim();
    if (line !== undefined) updateData.line = line.trim();
    if (year_from !== undefined) updateData.year_from = year_from ? parseInt(year_from) : null;
    if (year_to !== undefined) updateData.year_to = year_to ? parseInt(year_to) : null;
    if (engine !== undefined) updateData.engine = engine?.trim() || null;
    if (notes !== undefined) updateData.notes = notes?.trim() || null;
    if (vehicle_type !== undefined) {
      const validTypes = ['automovil', 'camioneta', 'motocicleta', 'camion', 'otro'];
      updateData.vehicle_type = validTypes.includes(vehicle_type) ? vehicle_type : null;
    }

    await application.update(updateData);

    res.json({ success: true, message: 'Aplicación actualizada', data: application });
  } catch (error) {
    console.error('Error en updateVehicleApplication:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar aplicación' });
  }
};

// DELETE /products/:id/vehicle-applications/:appId
const removeVehicleApplication = async (req, res) => {
  try {
    const { id, appId } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { id: appId, product_id: id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const application = await ProductVehicleApplication.findOne({ where: whereClause });
    if (!application) return res.status(404).json({ success: false, message: 'Aplicación no encontrada' });

    await application.destroy();

    res.json({ success: true, message: 'Aplicación vehicular eliminada' });
  } catch (error) {
    console.error('Error en removeVehicleApplication:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar aplicación' });
  }
};

// GET /vehicle-brands-lines
// Retorna marcas y líneas distintas (para autocompletado)
const getBrandsAndLines = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    const tenantId = req.user.tenant_id;
    if (!tenantId && req.user.role !== 'super_admin') {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    // Usar tablas normalizadas si existen datos, fallback a texto libre
    const VehicleBrand = require('../../models/workshop/VehicleBrand');
    const VehicleLine = require('../../models/workshop/VehicleLine');

    const whereClause = tenantId ? { tenant_id: tenantId } : {};

    const brands = await VehicleBrand.findAll({
      where: whereClause,
      include: [{
        model: VehicleLine,
        as: 'lines',
        attributes: ['id', 'name'],
        required: false
      }],
      order: [['name', 'ASC']]
    });

    if (brands.length > 0) {
      const data = brands.map(b => ({
        brand: b.name,
        brand_id: b.id,
        lines: (b.lines || []).map(l => l.name),
        line_ids: (b.lines || []).map(l => ({ id: l.id, name: l.name }))
      }));
      return res.json({ success: true, data });
    }

    // Fallback: DISTINCT desde product_vehicle_applications
    // Sin calificar schema, esto siempre leía "public" -- para un tenant ya
    // cortado a su propio schema, el fallback de marcas/líneas salía vacío
    // sin error visible.
    const schema = getCurrentSchema() || 'public';
    const tenantFilter = tenantId ? `WHERE pva.tenant_id = '${tenantId}'` : '';
    const results = await sequelize.query(`
      SELECT DISTINCT brand, line
      FROM "${schema}"."product_vehicle_applications" pva
      ${tenantFilter}
      ORDER BY brand ASC, line ASC
    `, { type: sequelize.QueryTypes.SELECT });

    const brandsMap = {};
    for (const row of results) {
      if (!brandsMap[row.brand]) brandsMap[row.brand] = [];
      brandsMap[row.brand].push(row.line);
    }

    const fallbackData = Object.entries(brandsMap).map(([brand, lines]) => ({ brand, lines }));
    res.json({ success: true, data: fallbackData });
  } catch (error) {
    console.error('Error en getBrandsAndLines:', error);
    res.status(500).json({ success: false, message: 'Error al obtener marcas y líneas' });
  }
};

// POST /vehicle-brands-lines
// Crear o obtener marca y línea (usado por el frontend al agregar aplicación)
const getOrCreateBrandAndLine = async (req, res) => {
  try {
    const { brand_name, line_name } = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!brand_name || !line_name) return res.status(400).json({ success: false, message: 'Marca y línea son requeridos' });

    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;
    if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const VehicleBrand = require('../../models/workshop/VehicleBrand');
    const VehicleLine = require('../../models/workshop/VehicleLine');

    // Buscar o crear marca
    let brand = await VehicleBrand.findOne({ where: { tenant_id: tenantId, name: brand_name.trim() } });
    if (!brand) {
      brand = await VehicleBrand.create({ tenant_id: tenantId, name: brand_name.trim() });
    }

    // Buscar o crear línea
    let line = await VehicleLine.findOne({ where: { brand_id: brand.id, name: line_name.trim() } });
    if (!line) {
      line = await VehicleLine.create({ tenant_id: tenantId, brand_id: brand.id, name: line_name.trim() });
    }

    res.json({ success: true, data: { brand_id: brand.id, brand_name: brand.name, line_id: line.id, line_name: line.name } });
  } catch (error) {
    console.error('Error en getOrCreateBrandAndLine:', error);
    res.status(500).json({ success: false, message: 'Error al crear marca/línea' });
  }
};

module.exports = {
  getProductVehicleApplications,
  addVehicleApplication,
  updateVehicleApplication,
  removeVehicleApplication,
  getBrandsAndLines,
  getOrCreateBrandAndLine
};
