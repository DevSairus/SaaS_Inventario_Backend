const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema, runWithTenantSchema } = require('../../config/tenantContext');
const { Product, Category } = require('../../models/inventory');
const Vehicle = require('../../models/workshop/Vehicle');
const { markForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { getInProcessMap } = require('../../services/inventory/stockInProcess.service');
const { createMovement } = require('./movements.controller');

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
      applies_to_vehicle_id, applies_to_brand, applies_to_line, applies_to_year,
      exclude_sale_id, exclude_work_order_id,
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
    // ── Relevancia de búsqueda ──────────────────────────────────────────────
    // Cuando hay término de búsqueda, el ORDER BY normal (name ASC) puede
    // enterrar el resultado que el usuario realmente busca al final del
    // listado -- y como hay LIMIT, ni siquiera llega a mostrarse. El score
    // se calcula POR PALABRA (igual que el WHERE de abajo, que también es
    // por palabra y no exige que estén juntas ni en orden) y se suman los
    // puntajes: coincidencia como palabra completa en `name` pesa más que
    // una coincidencia parcial, que a su vez pesa más que un match solo en
    // sku/barcode/description. Así "tijera mazda" prioriza "TIJERA SUP IZQ
    // MAZDA 6" (tiene ambas palabras completas en el nombre, aunque no
    // estén juntas) por encima de "BUJE TIJERA MAZDA 626" (palabras juntas
    // pero el nombre no empieza con lo buscado).
    let relevanceOrderLiteral = null;
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

      // Escapes para insertar de forma segura en el literal SQL / regex POSIX.
      // Se escapan primero los metacaracteres de regex y luego las comillas.
      const escapeRegexPg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapeSqlLiteral = (s) => s.replace(/'/g, "''");

      const perWordScores = searchWords.map(word => {
        const wRegex = escapeSqlLiteral(escapeRegexPg(word));
        const wLike = escapeSqlLiteral(word);
        return `CASE
          WHEN "Product"."name" ~* '\\m${wRegex}\\M' THEN 0
          WHEN "Product"."name" ILIKE '%${wLike}%' THEN 2
          WHEN "Product"."sku" ILIKE '${wLike}' OR "Product"."barcode" ILIKE '${wLike}' THEN 3
          WHEN "Product"."sku" ILIKE '%${wLike}%' OR "Product"."barcode" ILIKE '%${wLike}%' THEN 4
          ELSE 5
        END`;
      });

      const fullTerm  = escapeSqlLiteral(search.trim());
      const firstWord = escapeSqlLiteral(searchWords[0] || '');

      relevanceOrderLiteral = sequelize.literal(`(
        (${perWordScores.join(' + ')})
        + CASE WHEN "Product"."name" ILIKE '${fullTerm}' THEN -100 ELSE 0 END
        + CASE WHEN "Product"."name" ILIKE '${firstWord}%' THEN -1 ELSE 0 END
      )`);
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

    // Si el usuario pidió explícitamente otro orden (sort_by distinto del
    // default), respetarlo tal cual -- la relevancia solo aplica cuando se
    // está usando el orden por defecto (name ASC), que es el caso del
    // buscador de referencias en ventas/OT.
    const isDefaultSort = sort_by === 'name' && (sort_order || '').toUpperCase() !== 'DESC';
    const orderClause = (relevanceOrderLiteral && isDefaultSort)
      ? [[relevanceOrderLiteral, 'ASC'], [safeSortBy, safeSortOrder]]
      : [[safeSortBy, safeSortOrder]];

    const { count, rows } = await Product.findAndCountAll({
      where: whereClause,
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
      limit: safeLimit,
      offset: offset,
      order: orderClause,
      subQuery: false
    });

    // Si hay filtro vehicular, anotar qué productos tienen aplicación confirmada
    let data = rows.map(r => r.toJSON());
    if (vehicleMatchIds) {
      data = data.map(p => ({ ...p, _vehicleMatch: vehicleMatchIds.has(p.id) }));
    }

    // ── Cantidad en trámite (Sprint 3) ────────────────────────────────────
    // Una sola consulta agrupada por dimensión (ventas / OT) para todos los
    // ids de la página actual (máx. 200 por el cap de paginación de arriba)
    // -- no N+1. `exclude_sale_id`/`exclude_work_order_id` permiten que el
    // documento que se está editando no se cuente a sí mismo.
    if (data.length > 0) {
      const tenantIdForInProcess = req.user.role === 'super_admin' ? null : req.user.tenant_id;
      if (tenantIdForInProcess) {
        const inProcessMap = await getInProcessMap(tenantIdForInProcess, data.map(p => p.id), {
          excludeSaleId: exclude_sale_id || undefined,
          excludeWorkOrderId: exclude_work_order_id || undefined,
        });
        data = data.map(p => {
          const inProcess = inProcessMap[p.id] || { sales: 0, work_orders: 0, total: 0 };
          return {
            ...p,
            in_process_qty: inProcess.total,
            in_process_sales: inProcess.sales,
            in_process_work_orders: inProcess.work_orders,
            available_real: parseFloat(p.current_stock || 0) - inProcess.total,
          };
        });
      }
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

    // ── Cantidad en trámite (Sprint 3) ────────────────────────────────────
    const tenantIdForInProcess = req.user.role === 'super_admin' ? product.tenant_id : req.user.tenant_id;
    const { exclude_sale_id, exclude_work_order_id } = req.query;
    let data = product.toJSON();
    if (tenantIdForInProcess) {
      const inProcessMap = await getInProcessMap(tenantIdForInProcess, [product.id], {
        excludeSaleId: exclude_sale_id || undefined,
        excludeWorkOrderId: exclude_work_order_id || undefined,
      });
      const inProcess = inProcessMap[product.id] || { sales: 0, work_orders: 0, total: 0 };
      data = {
        ...data,
        in_process_qty: inProcess.total,
        in_process_sales: inProcess.sales,
        in_process_work_orders: inProcess.work_orders,
        available_real: parseFloat(data.current_stock || 0) - inProcess.total,
      };
    }

    res.json({ success: true, data });
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
      tax_config, is_labor = false, vehicle, retention_concept
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

      const effectiveTrackInventory = safeProductType === 'service' ? false : track_inventory;

      // El producto se crea SIEMPRE en cero -- si trae stock inicial, ese
      // stock entra por un InventoryMovement real (igual que una compra),
      // no escrito directo en la fila. Sin esto, el 143501 nunca se debitaba
      // por ese stock y, al venderlo, se acreditaba por algo que jamás se
      // había registrado como entrada (ver openingBalance.service.js, que ya
      // sigue este mismo patrón para la carga inicial de un tenant nuevo).
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
        average_cost: 0,
        sale_price: sale_price || 0,
        base_price: base_price || 0,
        profit_margin_percentage: profit_margin_percentage || 0,
        product_type: safeProductType,
        current_stock: 0,
        reserved_stock: safeProductType === 'service' ? 0 : reserved_stock,
        available_stock: safeProductType === 'service' ? 0 : (0 - parseFloat(reserved_stock || 0)),
        min_stock: (safeProductType === 'service' || safeProductType === 'vehicle') ? 0 : min_stock,
        max_stock: (safeProductType === 'service' || safeProductType === 'vehicle') ? null : max_stock,
        track_inventory: effectiveTrackInventory,
        is_active, is_for_sale, is_for_purchase, has_tax, tax_percentage, price_includes_tax,
        tax_config: finalTaxConfig,
        is_labor: safeProductType === 'service' ? !!is_labor : false,
        retention_concept: retention_concept || null,
      }, { transaction });

      const initialQuantity = effectiveTrackInventory ? parseFloat(effectiveCurrentStock) || 0 : 0;
      const initialCost = parseFloat(average_cost) || 0;
      if (initialQuantity > 0) {
        // Igual que en un vehículo la bodega no siempre es obligatoria en el
        // formulario (ver ProductFormModal), se cae a una bodega por defecto
        // del tenant antes de bloquear la creación del producto -- mismo
        // criterio que ya usa physicalCounts.controller.js para su propio
        // fallback de bodega.
        let initialWarehouseId = warehouse_id || null;
        if (!initialWarehouseId) {
          const { Warehouse } = require('../../models/inventory');
          const fallbackWarehouse = await Warehouse.findOne({
            where: { tenant_id: tenantId },
            order: [['is_default', 'DESC'], ['is_main', 'DESC'], ['created_at', 'ASC']],
            transaction,
          });
          initialWarehouseId = fallbackWarehouse ? fallbackWarehouse.id : null;
        }
        if (!initialWarehouseId) {
          throw Object.assign(new Error('Este producto tiene stock inicial: indica una bodega para registrarlo'), { statusCode: 400 });
        }
        await createMovement({
          tenant_id: tenantId,
          movement_type: 'entrada',
          movement_reason: 'initial_stock',
          reference_type: 'product',
          reference_id: product.id,
          product_id: product.id,
          warehouse_id: initialWarehouseId,
          quantity: initialQuantity,
          unit_cost: initialCost,
          user_id: req.user.id,
          movement_date: new Date().toISOString().split('T')[0],
          notes: 'Stock inicial al crear el producto',
        }, transaction);
      }

      await transaction.commit();

      // Asiento contable en borrador del stock inicial (no bloqueante: si
      // falla, solo se loguea -- igual que el resto de generadores).
      if (initialQuantity > 0 && initialCost > 0) {
        setImmediate(async () => {
          try {
            const { generateInitialStockEntry } = require('../../services/accounting/autoEntries.service');
            await generateInitialStockEntry(product, initialQuantity, initialCost, tenantId, req.user.id);
          } catch (err) {
            console.error(`[accounting] Error generando asiento de stock inicial del producto ${product.id}: ${err.message}`);
          }
        });
      }

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
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
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

    // El stock y el costo promedio solo deben cambiar a través de un
    // movimiento real (venta, compra, ajuste, saldo inicial) -- cada uno dejó
    // su propio rastro en el kardex y, cada vez más, su propio asiento
    // contable (ver generateAdjustmentEntry, generatePurchaseEntry, etc.).
    // Editar el producto directamente aquí movía el valor del inventario sin
    // ningún movimiento ni asiento que lo explique, y alteraba el costo
    // promedio que usará el próximo CMV sin dejar rastro de por qué cambió.
    // Se descartan en silencio (no se rechaza el request completo) porque el
    // formulario de edición reenvía el objeto completo del producto,
    // incluyendo estos campos sin cambios.
    delete updateData.current_stock;
    delete updateData.reserved_stock;
    delete updateData.available_stock;
    delete updateData.average_cost;

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

/**
 * Comparativo de proveedores de un producto para decidir a quién comprar:
 * por proveedor, último precio (con el descuento de línea aplicado), fecha y
 * compra, precio anterior (tendencia), mínimo, promedio y cantidad de
 * compras. Fuente: compras confirmadas o recibidas (no borradores ni
 * anuladas) + proveedores asociados en product_suppliers aunque aún no
 * tengan compras (se muestran sin precio).
 */
async function buildSupplierPriceComparison(product, tenant_id) {
  const Supplier = require('../../models/inventory/Supplier');
  const { Purchase, PurchaseItem } = require('../../models/inventory');

  const items = await PurchaseItem.findAll({
    where: { product_id: product.id },
    attributes: ['unit_cost', 'quantity', 'discount_percentage', 'tax_rate'],
    include: [{
      model: Purchase,
      as: 'purchase',
      where: { tenant_id, status: { [Op.in]: ['confirmed', 'partially_received', 'received'] } },
      attributes: ['id', 'purchase_number', 'purchase_date', 'invoice_number', 'status', 'supplier_id'],
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active'] }],
    }],
    order: [[{ model: Purchase, as: 'purchase' }, 'purchase_date', 'DESC'], [{ model: Purchase, as: 'purchase' }, 'created_at', 'DESC']],
  });

  const pivotBySupplier = new Map((product.suppliers || []).map((s) => [s.id, s]));
  const bySupplier = new Map();
  for (const item of items) {
    const sup = item.purchase?.supplier;
    if (!sup) continue;
    const unit = parseFloat(item.unit_cost) || 0;
    const disc = parseFloat(item.discount_percentage) || 0;
    const net = Math.round(unit * (1 - disc / 100) * 100) / 100;
    if (!bySupplier.has(sup.id)) {
      bySupplier.set(sup.id, { supplier: sup, purchases: [] });
    }
    bySupplier.get(sup.id).purchases.push({
      purchase_id: item.purchase.id,
      purchase_number: item.purchase.purchase_number,
      invoice_number: item.purchase.invoice_number,
      purchase_date: item.purchase.purchase_date,
      status: item.purchase.status,
      quantity: parseFloat(item.quantity) || 0,
      unit_cost: unit,
      discount_percentage: disc,
      net_cost: net,
      tax_rate: parseFloat(item.tax_rate) || 0,
    });
  }

  const rows = [];
  for (const { supplier, purchases } of bySupplier.values()) {
    const prices = purchases.map((p) => p.net_cost).filter((n) => n > 0);
    const last = purchases[0];
    const previous = purchases.find((p, i) => i > 0 && p.net_cost > 0) || null;
    const totalQty = purchases.reduce((s, p) => s + p.quantity, 0);
    const weightedAvg = totalQty > 0
      ? purchases.reduce((s, p) => s + p.net_cost * p.quantity, 0) / totalQty
      : (prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null);
    const pivot = pivotBySupplier.get(supplier.id);
    rows.push({
      id: supplier.id,
      name: supplier.name,
      business_name: supplier.business_name,
      contact_name: supplier.contact_name,
      phone: supplier.phone,
      email: supplier.email,
      is_active: supplier.is_active,
      supplier_code: pivot?.ProductSupplier?.supplier_code || null,
      lead_time_days: pivot?.ProductSupplier?.lead_time_days || null,
      last_price: last.net_cost || null,
      last_unit_cost: last.unit_cost,
      last_discount_percentage: last.discount_percentage,
      last_purchase_date: last.purchase_date,
      last_purchase_id: last.purchase_id,
      last_purchase_number: last.purchase_number,
      last_invoice_number: last.invoice_number,
      last_quantity: last.quantity,
      previous_price: previous?.net_cost ?? null,
      price_change_pct: previous?.net_cost ? Math.round(((last.net_cost - previous.net_cost) / previous.net_cost) * 1000) / 10 : null,
      min_price: prices.length ? Math.min(...prices) : null,
      avg_price: weightedAvg !== null ? Math.round(weightedAvg * 100) / 100 : null,
      purchases_count: purchases.length,
      total_quantity: totalQty,
      history: purchases.slice(0, 10),
    });
  }

  // Proveedores asociados al producto que aún no tienen compras registradas.
  for (const [sid, s] of pivotBySupplier) {
    if (bySupplier.has(sid)) continue;
    rows.push({
      id: s.id, name: s.name, business_name: s.business_name, contact_name: s.contact_name,
      phone: s.phone, email: s.email, is_active: s.is_active,
      supplier_code: s.ProductSupplier?.supplier_code || null,
      lead_time_days: s.ProductSupplier?.lead_time_days || null,
      last_price: s.ProductSupplier?.last_price ? parseFloat(s.ProductSupplier.last_price) : null,
      last_purchase_date: s.ProductSupplier?.last_purchase_date || null,
      purchases_count: 0, history: [],
    });
  }

  // Mejor precio = menor último precio entre proveedores activos con precio.
  const priced = rows.filter((r) => r.last_price > 0 && r.is_active !== false);
  const best = priced.length ? Math.min(...priced.map((r) => r.last_price)) : null;
  for (const r of rows) {
    r.is_best_price = best !== null && r.last_price === best && r.is_active !== false;
    r.diff_vs_best_pct = best && r.last_price > 0 ? Math.round(((r.last_price - best) / best) * 1000) / 10 : null;
  }
  rows.sort((a, b) => {
    if (!!a.last_price !== !!b.last_price) return a.last_price ? -1 : 1;
    if (a.last_price && b.last_price && a.last_price !== b.last_price) return a.last_price - b.last_price;
    return String(b.last_purchase_date || '').localeCompare(String(a.last_purchase_date || ''));
  });

  const latest = rows.filter((r) => r.last_purchase_date).sort((a, b) => String(b.last_purchase_date).localeCompare(String(a.last_purchase_date)))[0];
  return {
    suppliers: rows,
    summary: {
      suppliers_count: rows.length,
      best_price: best,
      best_supplier_id: rows.find((r) => r.is_best_price)?.id || null,
      last_purchase: latest ? { supplier_id: latest.id, price: latest.last_price, date: latest.last_purchase_date } : null,
      current_cost: parseFloat(product.average_cost ?? 0) || null,
    },
  };
}

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
      include: [{ model: Supplier, as: 'suppliers', through: { model: ProductSupplier, attributes: ['last_price', 'last_purchase_date', 'lead_time_days', 'supplier_code'] }, attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active'] }]
    });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    // ?detail=1 (ficha del producto): comparativo por proveedor armado desde
    // el historial real de compras, no solo el precio guardado en el pivote.
    // La alerta de stock sigue usando la respuesta simple de abajo.
    if (req.query.detail === '1' || req.query.detail === 'true') {
      const data = await buildSupplierPriceComparison(product, tenant_id || product.tenant_id);
      return res.json({ success: true, data });
    }

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
          include: [{ model: Purchase, as: 'purchase', where: { tenant_id, status: { [Op.in]: ['partially_received', 'received'] } }, include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active'] }], attributes: ['id', 'purchase_date', 'supplier_id'] }],
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
// El upload de archivo (multer/busboy, ver uploadProductImage.js) corre entre
// tenantMiddleware y este controller, y rompe la propagación del
// AsyncLocalStorage que tenantMiddleware usa para fijar el schema del tenant
// (ver tenantContext.js y el mismo problema ya resuelto en
// productsBulkImport.controller.js) -- para cuando este handler arranca,
// getCurrentSchema() ya da undefined y la query de Product cae silenciosamente
// a `public` en vez del schema real del tenant. Fix: re-fijar el contexto acá
// mismo con el schema_name que tenantMiddleware ya dejó en req.tenant.
const uploadProductImage = (req, res) => {
  if (req.tenant?.schema_name) {
    return runWithTenantSchema(req.tenant.schema_name, () => uploadProductImageInner(req, res));
  }
  return uploadProductImageInner(req, res);
};

const uploadProductImageInner = async (req, res) => {
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

// ── Documentos "en trámite" que comprometen este producto ─────────────────
// GET /products/:id/in-process — lista de ventas en borrador y de ítems de
// OT aprobados sin aplicar que comprometen este producto, para que el
// usuario pueda navegar y cerrar esos documentos (ver services/inventory/
// stockInProcess.service.js para la definición exacta de "en trámite").
const getProductInProcess = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let productWhere = { id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      productWhere.tenant_id = req.user.tenant_id;
    }
    const product = await Product.findOne({ where: productWhere });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const tenantId = req.user.role === 'super_admin' ? product.tenant_id : req.user.tenant_id;
    const { exclude_sale_id, exclude_work_order_id } = req.query;

    const { Sale, SaleItem, WorkOrder, WorkOrderItem, Customer } = require('../../models');

    // ── Ventas en borrador ───────────────────────────────────────────────
    const saleItemWhere = {
      product_id: id,
      item_type: { [Op.notIn]: ['service', 'free_line'] },
      approval_status: { [Op.ne]: 'rechazado' },
    };
    if (exclude_sale_id) saleItemWhere.sale_id = { [Op.ne]: exclude_sale_id };

    const saleItems = await SaleItem.findAll({
      where: saleItemWhere,
      include: [{
        model: Sale,
        as: 'sale',
        required: true,
        where: { tenant_id: tenantId, status: 'draft', document_type: null },
        attributes: ['id', 'sale_number', 'customer_name', 'status', 'sale_date', 'created_at'],
      }],
    });

    const ventas = saleItems.map(item => ({
      tipo: 'venta',
      id: item.sale.id,
      numero: item.sale.sale_number,
      cliente: item.sale.customer_name,
      cantidad: parseFloat(item.quantity),
      estado: item.sale.status,
      fecha: item.sale.sale_date || item.sale.created_at,
    }));

    // ── Ítems de OT aprobados, aún sin aplicar ────────────────────────────
    const woItemWhere = {
      product_id: id,
      item_type: 'repuesto',
      approval_status: 'aprobado',
      inventory_movement_id: null,
    };
    if (exclude_work_order_id) woItemWhere.work_order_id = { [Op.ne]: exclude_work_order_id };

    const woItems = await WorkOrderItem.findAll({
      where: woItemWhere,
      include: [{
        model: WorkOrder,
        as: 'work_order',
        required: true,
        where: {
          tenant_id: tenantId,
          status: { [Op.notIn]: ['cancelado', 'entregado'] },
          sale_id: null,
        },
        attributes: ['id', 'order_number', 'status', 'created_at'],
        include: [{ model: Customer, as: 'customer', attributes: ['first_name', 'last_name', 'business_name'] }],
      }],
    });

    const workOrders = woItems.map(item => {
      const wo = item.work_order;
      const customer = wo.customer;
      const clienteName = customer
        ? (customer.business_name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim())
        : null;
      return {
        tipo: 'work_order',
        id: wo.id,
        numero: wo.order_number,
        cliente: clienteName,
        cantidad: parseFloat(item.quantity),
        estado: wo.status,
        fecha: wo.created_at,
      };
    });

    const data = [...ventas, ...workOrders].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en getProductInProcess:', error);
    res.status(500).json({ success: false, message: 'Error al obtener documentos en trámite' });
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  getProductInProcess,
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