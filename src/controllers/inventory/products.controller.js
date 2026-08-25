const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { Product, Category } = require('../../models/inventory');
const Vehicle = require('../../models/workshop/Vehicle');
const { markForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

// Debe reflejar exactamente el CHECK constraint de la tabla products
// (ver 20260101000000-baseline-core-inventory-tables.js) -- si diverge,
// un insert/update con una unidad fuera de esta lista pasa la validación
// de acá pero igual rebota como un 500 crudo de Postgres.
const VALID_UNITS_OF_MEASURE = ['unit', 'kg', 'g', 'lb', 'oz', 'l', 'ml', 'gal', 'm', 'cm', 'ft', 'box', 'pack', 'dozen'];

const getProductStats = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = {};
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    // Una sola query agrupada reemplaza 6 queries independientes + findAll en memoria
    const tenantFilter = whereClause.tenant_id
      ? 'AND tenant_id = :tenantId'
      : '';
    // Sin calificar schema, esto siempre leía "public" -- para un tenant ya
    // cortado a su propio schema las estadísticas salían en cero sin error
    // visible. NOTA: para super_admin (sin tenant_id, estadísticas globales)
    // esto sigue siendo una limitación real -- solo cuenta lo que haya en
    // `schema`, no agrega across todos los schemas de tenant; agregar de
    // verdad requiere iterar todos los schemas, que queda fuera de este fix.
    const schema = getCurrentSchema() || 'public';
    const [agg] = await sequelize.query(
      `SELECT
         COUNT(*)                                                              AS total,
         COUNT(*) FILTER (WHERE is_active)                                    AS active,
         COUNT(*) FILTER (WHERE NOT is_active)                                AS inactive,
         COUNT(*) FILTER (WHERE track_inventory AND is_active
                          AND current_stock < min_stock
                          AND current_stock > 0)                              AS low_stock,
         COUNT(*) FILTER (WHERE track_inventory AND is_active
                          AND current_stock <= 0)                             AS out_of_stock,
         COALESCE(SUM(CASE WHEN is_active
                      THEN current_stock * average_cost ELSE 0 END), 0)      AS inventory_value
       FROM "${schema}"."products"
       WHERE 1=1 ${tenantFilter}`,
      {
        replacements: whereClause.tenant_id ? { tenantId: whereClause.tenant_id } : {},
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const totalProducts       = parseInt(agg.total);
    const activeProducts      = parseInt(agg.active);
    const inactiveProducts    = parseInt(agg.inactive);
    const lowStockProducts    = parseInt(agg.low_stock);
    const outOfStockProducts  = parseInt(agg.out_of_stock);
    const totalInventoryValue = parseFloat(agg.inventory_value);

    res.json({ success: true, data: { total: totalProducts, total_products: totalProducts, active: activeProducts, active_products: activeProducts, inactive: inactiveProducts, inactive_products: inactiveProducts, lowStock: lowStockProducts, low_stock_products: lowStockProducts, outOfStock: outOfStockProducts, out_of_stock_products: outOfStockProducts, totalInventoryValue, total_inventory_value: totalInventoryValue } });
  } catch (error) {
    console.error('Error en getProductStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const {
      page = 1, limit = 10, search = '', category_id = '', is_active = '',
      sort_by = 'name', sort_order = 'ASC',
      applies_to_vehicle_id, applies_to_brand, applies_to_line, applies_to_year
    } = req.query;

    // ── Seguridad: whitelist ORDER BY — Sequelize NO parametriza ORDER BY ────
    const ALLOWED_SORT_FIELDS = ['name', 'sku', 'base_price', 'current_stock', 'average_cost', 'created_at', 'updated_at'];
    const safeSortBy    = ALLOWED_SORT_FIELDS.includes(sort_by) ? sort_by : 'name';
    const safeSortOrder = sort_order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    // ── Cap de paginación: máximo 200 por request ─────────────────────────────
    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 10), 200);
    const safePage   = Math.max(1, parseInt(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = {};
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    if (search) {
      // Búsqueda por múltiples palabras: cada palabra debe aparecer en
      // alguno de los campos (AND de ORs), no la frase completa como una
      // sola subcadena -- así "filtro aceite" encuentra "Filtro de aceite
      // Mann" y también funciona con el orden invertido ("aceite filtro").
      const searchWords = search.trim().split(/\s+/).filter(Boolean);
      whereClause[Op.and] = [
        ...(whereClause[Op.and] || []),
        ...searchWords.map(word => ({
          [Op.or]: [
            { name: { [Op.iLike]: `%${word}%` } },
            { sku: { [Op.iLike]: `%${word}%` } },
            { barcode: { [Op.iLike]: `%${word}%` } },
            { description: { [Op.iLike]: `%${word}%` } }
          ]
        }))
      ];
    }
    if (category_id) whereClause.category_id = category_id;
    if (is_active !== '') whereClause.is_active = is_active === 'true';

    // ── Filtro por sede/bodega activa ─────────────────────────────────────────
    // Solo se ven productos de las bodegas de la sede activa del usuario
    // (req.branch_id, resuelto por branchMiddleware), o sin bodega asignada
    // (catálogo compartido / servicios). super_admin no tiene sede (branch_id
    // null) y ve todo.
    if (req.branch_id) {
      const { Warehouse } = require('../../models/inventory');
      const branchWarehouses = await Warehouse.findAll({
        where: { branch_id: req.branch_id },
        attributes: ['id'],
      });
      const warehouseIds = branchWarehouses.map(w => w.id);
      whereClause[Op.and] = [
        ...(whereClause[Op.and] || []),
        { [Op.or]: [{ warehouse_id: null }, { warehouse_id: { [Op.in]: warehouseIds } }] },
      ];
    }

    // ── Filtro por aplicación vehicular ──────────────────────────────────────
    let vehicleBrand = applies_to_brand;
    let vehicleLine = applies_to_line;
    let vehicleYear = applies_to_year ? parseInt(applies_to_year) : null;

    // Si se proporciona vehicle_id, resolver brand/line/year desde la tabla vehicles
    if (applies_to_vehicle_id && !vehicleBrand) {
      try {
        const Vehicle = require('../../models/workshop/Vehicle');
        const vehicle = await Vehicle.findByPk(applies_to_vehicle_id);
        if (vehicle) {
          vehicleBrand = vehicle.brand;
          vehicleLine = vehicle.model;
          // Intentar extraer el año del campo year o de la matrícula
          if (vehicle.year) vehicleYear = parseInt(vehicle.year);
        }
      } catch (e) {
        // Si falla la resolución, continuar sin filtro vehicular
      }
    }

    // Aplicar filtro vehicular como subquery.
    // Si el usuario además escribió un término de búsqueda, el filtro vehicular
    // NO debe excluir resultados (la mayoría de tenants no tiene cargada la
    // tabla product_vehicle_applications) — en ese caso solo se usa para marcar
    // _vehicleMatch. Sin término de búsqueda, sí se filtra estrictamente (uso:
    // "ver repuestos compatibles con este vehículo").
    let vehicleMatchIds = null;
    if (vehicleBrand && vehicleLine) {
      const { ProductVehicleApplication } = require('../../models/inventory');
      const subqueryWhere = {
        tenant_id: whereClause.tenant_id || { [Op.ne]: null },
        brand: { [Op.iLike]: vehicleBrand.trim() },
        line: { [Op.iLike]: vehicleLine.trim() }
      };

      // Filtrar por año: el producto aplica si year_from es null O year_from <= año
      // Y year_to es null O year_to >= año
      if (vehicleYear) {
        subqueryWhere[Op.and] = [
          { [Op.or]: [{ year_from: null }, { year_from: { [Op.lte]: vehicleYear } }] },
          { [Op.or]: [{ year_to: null }, { year_to: { [Op.gte]: vehicleYear } }] }
        ];
      }

      const matchingProductIds = await ProductVehicleApplication.findAll({
        where: subqueryWhere,
        attributes: ['product_id'],
        group: ['product_id']
      });

      const ids = matchingProductIds.map(m => m.product_id);
      vehicleMatchIds = new Set(ids);

      if (!search) {
        if (ids.length > 0) {
          whereClause.id = { [Op.in]: ids };
        } else {
          // No hay productos que apliquen a este vehículo — retornar vacío
          return res.json({ success: true, data: [], pagination: { total: 0, page: safePage, limit: safeLimit, totalPages: 0 } });
        }
      }
    }

    const { count, rows } = await Product.findAndCountAll({
      where: whereClause,
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
      limit: safeLimit,
      offset: offset,
      order: [[safeSortBy, safeSortOrder]]
    });

    // Si hay filtro vehicular, anotar qué productos tienen aplicación confirmada
    let data = rows.map(r => r.toJSON());
    if (vehicleMatchIds) {
      data = data.map(p => ({ ...p, _vehicleMatch: vehicleMatchIds.has(p.id) }));
    }

    res.json({ success: true, data, pagination: { total: count, page: safePage, limit: safeLimit, totalPages: Math.ceil(count / safeLimit) } });
  } catch (error) {
    console.error('Error en getAllProducts:', error);
    res.status(500).json({ success: false, message: 'Error al obtener productos' });
  }
};

const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = { id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: whereClause, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }, { model: Vehicle, as: 'vehicle' }] });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener producto' });
  }
};

const createProduct = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) return res.status(400).json({ success: false, message: 'Error: Usuario sin tenant asignado. Por favor contacte a soporte.' });

    const {
      sku, barcode, name, description, category_id, warehouse_id = null,
      brand, unit_of_measure, average_cost, sale_price, base_price,
      profit_margin_percentage, current_stock = 0, reserved_stock = 0,
      min_stock = 0, max_stock, product_type = 'simple',
      track_inventory = true, is_active = true, is_for_sale = true,
      is_for_purchase = true, has_tax = true, tax_percentage = 19, price_includes_tax = false,
      tax_config, is_labor = false, vehicle
    } = req.body;

    const VALID_PRODUCT_TYPES = ['simple', 'variant', 'service', 'bundle', 'raw_material', 'vehicle'];
    const safeProductType = VALID_PRODUCT_TYPES.includes(product_type) ? product_type : 'simple';

    if (!sku || !name) return res.status(400).json({ success: false, message: 'SKU y nombre son requeridos' });

    // El check constraint de la BD solo acepta estos valores (ver migración
    // baseline de inventario) -- validar acá da un 400 claro en vez de dejar
    // que rebote como un 500 crudo de Postgres cuando llega algo como "unidad".
    if (unit_of_measure && !VALID_UNITS_OF_MEASURE.includes(unit_of_measure.trim())) {
      return res.status(400).json({
        success: false,
        message: `Unidad de medida inválida: "${unit_of_measure}". Valores permitidos: ${VALID_UNITS_OF_MEASURE.join(', ')}`,
      });
    }

    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;

    const existingSku = await Product.findOne({ where: { sku: sku.trim(), tenant_id: tenantId } });
    if (existingSku) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese SKU' });

    if (barcode) {
      const existingBarcode = await Product.findOne({ where: { barcode: barcode.trim(), tenant_id: tenantId } });
      if (existingBarcode) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese código de barras' });
    }

    // Construir tax_config si no viene del frontend
    const finalTaxConfig = tax_config || {
      iva: { enabled: has_tax && tax_percentage > 0, rate: tax_percentage || 19 },
      inc: { enabled: false, rate: 0 },
      ica: { enabled: false, rate: 0 },
    };

    // Un vehículo en stock es una unidad única (no una cantidad de piezas
    // intercambiables) -- se fuerza a 1 en vez de tomar lo que venga del form.
    const effectiveCurrentStock = safeProductType === 'vehicle' ? 1 : current_stock;
    const available_stock = parseFloat(effectiveCurrentStock) - parseFloat(reserved_stock);

    const transaction = await sequelize.transaction();
    try {
      // Se crea primero el Vehicle real (para que el producto pueda
      // apuntarle por vehicle_id) -- así el vehículo queda registrado como
      // tal en el sistema, no solo como una línea de inventario genérica.
      let vehicleRecord = null;
      if (safeProductType === 'vehicle') {
        const v = vehicle || {};
        // vehicles.plate es NOT NULL a nivel de BD (columna compartida con
        // todo el módulo Taller) -- para un vehículo nuevo que aún no tiene
        // matrícula se genera un identificador temporal, fácil de distinguir
        // de una placa real, que se reemplaza luego editando el Vehicle.
        const plate = v.plate?.trim()
          ? v.plate.trim().toUpperCase()
          : `PEND-${require('crypto').randomUUID().slice(0, 6).toUpperCase()}`;

        vehicleRecord = await Vehicle.create({
          tenant_id: tenantId,
          customer_id: null, // sin dueño todavía: es stock del concesionario
          plate,
          vehicle_type: v.vehicle_type || 'automovil',
          brand: v.brand?.trim() || brand?.trim() || null,
          model: v.model?.trim() || null,
          year: v.year ? parseInt(v.year) : null,
          color: v.color?.trim() || null,
          vin: v.vin?.trim() || null,
          engine_number: v.engine_number?.trim() || null,
          fuel_type: v.fuel_type || 'gasolina',
          current_mileage: v.current_mileage ? parseInt(v.current_mileage) : null,
          notes: 'Vehículo en stock -- registrado desde Inventario',
        }, { transaction });
      }

      const product = await Product.create({
        tenant_id: tenantId,
        sku: sku.trim(),
        barcode: barcode ? barcode.trim() : null,
        name: name.trim(),
        description: description?.trim() || null,
        category_id: category_id || null,
        warehouse_id: warehouse_id || null,
        brand: brand?.trim() || null,
        vehicle_id: vehicleRecord?.id || null,
        unit_of_measure: unit_of_measure?.trim() || null,
        average_cost: average_cost || 0,
        sale_price: sale_price || 0,
        base_price: base_price || 0,
        profit_margin_percentage: profit_margin_percentage || 0,
        product_type: safeProductType,
        current_stock: safeProductType === 'service' ? 0 : effectiveCurrentStock,
        reserved_stock: safeProductType === 'service' ? 0 : reserved_stock,
        available_stock: safeProductType === 'service' ? 0 : available_stock,
        min_stock: (safeProductType === 'service' || safeProductType === 'vehicle') ? 0 : min_stock,
        max_stock: (safeProductType === 'service' || safeProductType === 'vehicle') ? null : max_stock,
        track_inventory: safeProductType === 'service' ? false : track_inventory,
        is_active, is_for_sale, is_for_purchase, has_tax, tax_percentage, price_includes_tax,
        tax_config: finalTaxConfig,
        is_labor: safeProductType === 'service' ? !!is_labor : false,
      }, { transaction });

      await transaction.commit();

      const newProduct = await Product.findOne({
        where: { id: product.id },
        include: [
          { model: Category, as: 'category', attributes: ['id', 'name'] },
          { model: Vehicle, as: 'vehicle' },
        ],
      });
      if (tenantId) markForAlertCheck(res, product.id, tenantId);
      return res.status(201).json({ success: true, message: 'Producto creado exitosamente', data: newProduct });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error en createProduct:', error);
    res.status(500).json({ success: false, message: 'Error al crear producto' });
  }
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) return res.status(400).json({ success: false, message: 'Error: Usuario sin tenant asignado. Por favor contacte a soporte.' });

    let whereClause = { id };
    if (req.user.role !== 'super_admin') whereClause.tenant_id = req.user.tenant_id;

    const product = await Product.findOne({ where: whereClause });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const tenantId = req.user.role === 'super_admin' ? product.tenant_id : req.user.tenant_id;

    if (updateData.sku && updateData.sku !== product.sku) {
      const existingSku = await Product.findOne({ where: { sku: updateData.sku.trim(), tenant_id: tenantId, id: { [Op.ne]: id } } });
      if (existingSku) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese SKU' });
    }

    if (updateData.barcode && updateData.barcode !== product.barcode) {
      const existingBarcode = await Product.findOne({ where: { barcode: updateData.barcode.trim(), tenant_id: tenantId, id: { [Op.ne]: id } } });
      if (existingBarcode) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese código de barras' });
    }

    if (updateData.unit_of_measure && !VALID_UNITS_OF_MEASURE.includes(updateData.unit_of_measure.trim())) {
      return res.status(400).json({
        success: false,
        message: `Unidad de medida inválida: "${updateData.unit_of_measure}". Valores permitidos: ${VALID_UNITS_OF_MEASURE.join(', ')}`,
      });
    }

    if (updateData.current_stock !== undefined || updateData.reserved_stock !== undefined) {
      const current = updateData.current_stock !== undefined ? parseFloat(updateData.current_stock) : parseFloat(product.current_stock);
      const reserved = updateData.reserved_stock !== undefined ? parseFloat(updateData.reserved_stock) : parseFloat(product.reserved_stock);
      updateData.available_stock = current - reserved;
    }

    const nullableFields = ['category_id', 'warehouse_id', 'barcode', 'description', 'brand', 'max_stock'];
    nullableFields.forEach(field => {
      if (updateData[field] === '' || updateData[field] === undefined) updateData[field] = null;
    });

    const notNullFields = ['unit_of_measure', 'sku', 'name'];
    notNullFields.forEach(field => {
      if (updateData[field] === '' || updateData[field] === undefined || updateData[field] === null) delete updateData[field];
    });

    Object.keys(updateData).forEach(key => { if (updateData[key] === undefined) delete updateData[key]; });

    if (updateData.product_type) {
      const VALID_PRODUCT_TYPES = ['simple', 'variant', 'service', 'bundle', 'raw_material', 'vehicle'];
      if (!VALID_PRODUCT_TYPES.includes(updateData.product_type)) {
        updateData.product_type = 'simple';
      }
    }

    // Los campos propios del vehículo (placa, VIN, etc.) se editan desde el
    // módulo Vehículos, no desde acá -- este objeto solo se usa al crear.
    delete updateData.vehicle;

    await product.update(updateData);
    const updatedProduct = await Product.findOne({ where: { id }, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }, { model: Vehicle, as: 'vehicle' }] });
    if (updateData.current_stock !== undefined || updateData.min_stock !== undefined || updateData.max_stock !== undefined) {
      markForAlertCheck(res, id, tenantId);
    }
    res.json({ success: true, message: 'Producto actualizado exitosamente', data: updatedProduct });
  } catch (error) {
    console.error('Error en updateProduct:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar producto' });
  }
};

const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = { id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: whereClause });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    await product.update({ is_active: false });
    res.json({ success: true, message: 'Producto desactivado exitosamente' });
  } catch (error) {
    console.error('Error en deactivateProduct:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar producto' });
  }
};

const deleteProductPermanently = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = { id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: whereClause });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    await product.destroy();
    res.json({ success: true, message: 'Producto eliminado permanentemente' });
  } catch (error) {
    console.error('Error en deleteProductPermanently:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar producto' });
  }
};

const getProductByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!barcode) return res.status(400).json({ success: false, message: 'Código de barras requerido' });
    let whereClause = { barcode: barcode.trim() };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: whereClause, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }, { model: Vehicle, as: 'vehicle' }] });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductByBarcode:', error);
    res.status(500).json({ success: false, message: 'Error al buscar producto por código de barras' });
  }
};

const checkBarcodeExists = async (req, res) => {
  try {
    const { barcode } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!barcode) return res.status(400).json({ success: false, message: 'Código de barras requerido' });
    let whereClause = { barcode: barcode.trim() };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: whereClause, attributes: ['id', 'sku', 'name', 'barcode'] });
    res.json({ success: true, exists: !!product, product: product || null });
  } catch (error) {
    console.error('Error en checkBarcodeExists:', error);
    res.status(500).json({ success: false, message: 'Error al verificar código de barras' });
  }
};

const getProductSuppliers = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    const Supplier = require('../../models/inventory/Supplier');
    const ProductSupplier = require('../../models/inventory/ProductSupplier');
    const { Purchase, PurchaseItem } = require('../../models/inventory');

    let whereClause = { id };
    const tenant_id = req.user.tenant_id;
    if (req.user.role !== 'super_admin') {
      if (!tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = tenant_id;
    }

    const product = await Product.findOne({
      where: whereClause,
      include: [{ model: Supplier, as: 'suppliers', through: { model: ProductSupplier, attributes: ['last_price', 'last_purchase_date', 'lead_time_days'] }, attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active'] }]
    });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const suppliersFromPivot = product.suppliers.map(s => ({
      id: s.id, name: s.name, business_name: s.business_name, contact_name: s.contact_name,
      phone: s.phone, email: s.email, is_active: s.is_active,
      last_price: s.ProductSupplier?.last_price || null,
      last_purchase_date: s.ProductSupplier?.last_purchase_date || null,
      lead_time_days: s.ProductSupplier?.lead_time_days || null
    }));

    const needsEnrichment = suppliersFromPivot.length === 0 || suppliersFromPivot.every(s => !s.last_price);
    let suppliersData = suppliersFromPivot;

    if (needsEnrichment && tenant_id) {
      try {
        const purchaseItems = await PurchaseItem.findAll({
          where: { product_id: id },
          include: [{ model: Purchase, as: 'purchase', where: { tenant_id, status: 'received' }, include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active'] }], attributes: ['id', 'purchase_date', 'supplier_id'] }],
          attributes: ['unit_cost'],
          order: [[{ model: Purchase, as: 'purchase' }, 'purchase_date', 'DESC']]
        });

        const supplierMap = {};
        for (const item of purchaseItems) {
          const sup = item.purchase?.supplier;
          if (!sup || supplierMap[sup.id]) continue;
          supplierMap[sup.id] = { id: sup.id, name: sup.name, business_name: sup.business_name, contact_name: sup.contact_name, phone: sup.phone, email: sup.email, is_active: sup.is_active, last_price: parseFloat(item.unit_cost) || null, last_purchase_date: item.purchase.purchase_date || null, lead_time_days: null };
        }

        const suppliersFromHistory = Object.values(supplierMap);
        if (suppliersFromHistory.length > 0) {
          const pivotIds = new Set(suppliersFromPivot.map(s => s.id));
          const onlyInHistory = suppliersFromHistory.filter(s => !pivotIds.has(s.id));
          const enrichedPivot = suppliersFromPivot.map(s => {
            if (!s.last_price && supplierMap[s.id]) return { ...s, last_price: supplierMap[s.id].last_price, last_purchase_date: supplierMap[s.id].last_purchase_date };
            return s;
          });
          suppliersData = [...enrichedPivot, ...onlyInHistory];
        }
      } catch (histErr) {
        console.error('Error buscando historial:', histErr);
      }
    }

    res.json({ success: true, data: suppliersData });
  } catch (error) {
    console.error('Error en getProductSuppliers:', error);
    res.status(500).json({ success: false, message: 'Error al obtener proveedores del producto' });
  }
};


// ── Helpers Cloudinary ───────────────────────────────────────────────────────
const getCloudinary = () => {
  const { v2 } = require('cloudinary');
  v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });
  return v2;
};

/** Sube un buffer a Cloudinary y devuelve la URL segura */
const uploadBufferToCloudinary = (buffer, publicId) =>
  new Promise((resolve, reject) => {
    const cloudinary = getCloudinary();
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'products', public_id: publicId, overwrite: true, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });

/** Extrae el public_id de Cloudinary desde una URL */
const extractPublicId = (url) => {
  // URL format: https://res.cloudinary.com/<cloud>/image/upload/v123/products/<name>.ext
  const match = url?.match(/\/products\/([^.]+)/);
  return match ? `products/${match[1]}` : null;
};

// ── Subir imagen de producto ──────────────────────────────────────────────────
const uploadProductImage = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const product = await Product.findOne({ where: { id, ...(tenantId ? { tenant_id: tenantId } : {}) } });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    if (!req.file?.buffer) return res.status(400).json({ success: false, message: 'No se recibió ningún archivo' });

    // Eliminar imagen anterior de Cloudinary si existe
    if (product.image_url) {
      try {
        const oldPublicId = extractPublicId(product.image_url);
        if (oldPublicId) await getCloudinary().uploader.destroy(oldPublicId);
      } catch { /* no bloquear si falla el borrado */ }
    }

    // Subir nuevo archivo desde buffer (sin tocar disco)
    const publicId = `product-${id}-${Date.now()}`;
    const result = await uploadBufferToCloudinary(req.file.buffer, publicId);

    await product.update({ image_url: result.secure_url });

    res.json({ success: true, message: 'Imagen actualizada', data: { image_url: result.secure_url } });
  } catch (error) {
    console.error('Error en uploadProductImage:', error);
    res.status(500).json({ success: false, message: 'Error al subir imagen' });
  }
};

// ── Eliminar imagen de producto ───────────────────────────────────────────────
const deleteProductImage = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const product = await Product.findOne({ where: { id, ...(tenantId ? { tenant_id: tenantId } : {}) } });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    if (product.image_url) {
      try {
        const publicId = extractPublicId(product.image_url);
        if (publicId) await getCloudinary().uploader.destroy(publicId);
      } catch { /* no bloquear si falla */ }
      await product.update({ image_url: null });
    }

    res.json({ success: true, message: 'Imagen eliminada' });
  } catch (error) {
    console.error('Error en deleteProductImage:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar imagen' });
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  getProductSuppliers,
  createProduct,
  updateProduct,
  deactivateProduct,
  deleteProductPermanently,
  getProductStats,
  getProductByBarcode,
  checkBarcodeExists,
  uploadProductImage,
  deleteProductImage
};