const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Product, Category } = require('../../models/inventory');

/**
 * Obtener estadísticas de productos
 */
const getProductStats = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    let whereClause = {};

    if (req.user.role !== 'super_admin') {
      // ✅ Validar tenant_id
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const totalProducts = await Product.count({ where: whereClause });
    const activeProducts = await Product.count({ where: { ...whereClause, is_active: true } });
    const inactiveProducts = await Product.count({ where: { ...whereClause, is_active: false } });
    
    const lowStockProducts = await Product.count({
      where: {
        ...whereClause,
        current_stock: { [Op.lt]: sequelize.col('min_stock') },
        track_inventory: true,
        is_active: true
      }
    });

    const outOfStockProducts = await Product.count({
      where: {
        ...whereClause,
        current_stock: { [Op.lte]: 0 },
        track_inventory: true,
        is_active: true
      }
    });

    // Calcular valor total del inventario
    const products = await Product.findAll({
      where: { ...whereClause, is_active: true },
      attributes: ['current_stock', 'average_cost']
    });

    const totalInventoryValue = products.reduce((sum, product) => {
      const stock = parseFloat(product.current_stock) || 0;
      const cost = parseFloat(product.average_cost) || 0;
      return sum + (stock * cost);
    }, 0);

    res.json({
      success: true,
      data: {
        total: totalProducts,
        total_products: totalProducts,
        active: activeProducts,
        active_products: activeProducts,
        inactive: inactiveProducts,
        inactive_products: inactiveProducts,
        lowStock: lowStockProducts,
        low_stock_products: lowStockProducts,
        outOfStock: outOfStockProducts,
        out_of_stock_products: outOfStockProducts,
        totalInventoryValue: totalInventoryValue,
        total_inventory_value: totalInventoryValue
      }
    });
  } catch (error) {
    console.error('Error en getProductStats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener estadísticas'});
  }
};

/**
 * Obtener todos los productos
 */
const getAllProducts = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', category_id = '', is_active = '', sort_by = 'name', sort_order = 'ASC' } = req.query;
    const offset = (page - 1) * limit;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    let whereClause = {};

    if (req.user.role !== 'super_admin') {
      // ✅ Validar tenant_id
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    if (search) {
      whereClause[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { sku: { [Op.iLike]: `%${search}%` } },
        { barcode: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category_id) {
      whereClause.category_id = category_id;
    }

    if (is_active !== '') {
      whereClause.is_active = is_active === 'true';
    }

    const { count, rows } = await Product.findAndCountAll({
      where: whereClause,
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [[sort_by, sort_order.toUpperCase()]]
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error en getAllProducts:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener productos'});
  }
};

/**
 * Obtener un producto por ID
 */
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    let whereClause = { id };

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({
      where: whereClause,
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }]
    });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductById:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener producto'});
  }
};

/**
 * Crear un nuevo producto
 */
const createProduct = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) {
      console.log('❌ ERROR: Usuario sin tenant_id');
      return res.status(400).json({ 
        success: false, 
        message: 'Error: Usuario sin tenant asignado. Por favor contacte a soporte.' 
      });
    }

    const {
      sku,
      barcode,
      name,
      description,
      category_id,
      brand,
      unit_of_measure,
      average_cost,
      sale_price,
      base_price,
      profit_margin_percentage,
      current_stock = 0,
      reserved_stock = 0,
      min_stock = 0,
      max_stock,
      product_type = 'product',
      track_inventory = true,
      is_active = true,
      is_for_sale = true,
      is_for_purchase = true,
      // Campos de IVA
      has_tax = true,
      tax_percentage = 19,
      price_includes_tax = false
    } = req.body;

    if (!sku || !name) {
      return res.status(400).json({ 
        success: false, 
        message: 'SKU y nombre son requeridos' 
      });
    }

    // Determinar tenant_id a usar
    const tenantId = req.user.role === 'super_admin' 
      ? (req.body.tenant_id || null) 
      : req.user.tenant_id;

    // Verificar SKU duplicado
    const existingSku = await Product.findOne({
      where: {
        sku: sku.trim(),
        tenant_id: tenantId
      }
    });

    if (existingSku) {
      return res.status(400).json({ 
        success: false, 
        message: 'Ya existe un producto con ese SKU' 
      });
    }

    // Verificar código de barras duplicado
    if (barcode) {
      const existingBarcode = await Product.findOne({
        where: {
          barcode: barcode.trim(),
          tenant_id: tenantId
        }
      });

      if (existingBarcode) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe un producto con ese código de barras' 
        });
      }
    }

    const available_stock = parseFloat(current_stock) - parseFloat(reserved_stock);

    const product = await Product.create({
      tenant_id: tenantId,
      sku: sku.trim(),
      barcode: barcode ? barcode.trim() : null,
      name: name.trim(),
      description: description?.trim() || null,
      category_id: category_id || null,
      brand: brand?.trim() || null,
      unit_of_measure: unit_of_measure?.trim() || null,
      average_cost: average_cost || 0,
      sale_price: sale_price || 0,
      base_price: base_price || 0,
      profit_margin_percentage: profit_margin_percentage || 0,
      product_type,
      current_stock: product_type === 'service' ? 0 : current_stock,
      reserved_stock: product_type === 'service' ? 0 : reserved_stock,
      available_stock: product_type === 'service' ? 0 : available_stock,
      min_stock: product_type === 'service' ? 0 : min_stock,
      max_stock: product_type === 'service' ? null : max_stock,
      track_inventory: product_type === 'service' ? false : track_inventory,
      is_active,
      is_for_sale,
      is_for_purchase,
      // Campos de IVA
      has_tax,
      tax_percentage,
      price_includes_tax
    });

    const newProduct = await Product.findOne({
      where: { id: product.id },
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }]
    });

    res.status(201).json({
      success: true,
      message: 'Producto creado exitosamente',
      data: newProduct
    });
  } catch (error) {
    console.error('Error en createProduct:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear producto'});
  }
};

/**
 * Actualizar un producto
 */
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Error: Usuario sin tenant asignado. Por favor contacte a soporte.' 
      });
    }

    let whereClause = { id };

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({ where: whereClause });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    // Determinar tenant_id para validaciones
    const tenantId = req.user.role === 'super_admin' 
      ? product.tenant_id 
      : req.user.tenant_id;

    // Verificar SKU duplicado
    if (updateData.sku && updateData.sku !== product.sku) {
      const existingSku = await Product.findOne({
        where: {
          sku: updateData.sku.trim(),
          tenant_id: tenantId,
          id: { [Op.ne]: id }
        }
      });

      if (existingSku) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe un producto con ese SKU' 
        });
      }
    }

    // Verificar código de barras duplicado
    if (updateData.barcode && updateData.barcode !== product.barcode) {
      const existingBarcode = await Product.findOne({
        where: {
          barcode: updateData.barcode.trim(),
          tenant_id: tenantId,
          id: { [Op.ne]: id }
        }
      });

      if (existingBarcode) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe un producto con ese código de barras' 
        });
      }
    }

    // Calcular stock disponible si se actualizan stocks
    if (updateData.current_stock !== undefined || updateData.reserved_stock !== undefined) {
      const current = updateData.current_stock !== undefined 
        ? parseFloat(updateData.current_stock) 
        : parseFloat(product.current_stock);
      const reserved = updateData.reserved_stock !== undefined 
        ? parseFloat(updateData.reserved_stock) 
        : parseFloat(product.reserved_stock);
      updateData.available_stock = current - reserved;
    }

    // Convertir strings vacíos a null para campos UUID y opcionales
    const fieldsToSanitize = [
      'category_id',
      'barcode',
      'description',
      'brand',
      'unit_of_measure',
      'max_stock'
    ];

    fieldsToSanitize.forEach(field => {
      if (updateData[field] === '' || updateData[field] === undefined) {
        updateData[field] = null;
      }
    });

    await product.update(updateData);

    const updatedProduct = await Product.findOne({
      where: { id },
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }]
    });

    res.json({
      success: true,
      message: 'Producto actualizado exitosamente',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Error en updateProduct:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar producto'});
  }
};

/**
 * Desactivar un producto (soft delete)
 */
const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    let whereClause = { id };

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({ where: whereClause });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    await product.update({ is_active: false });

    res.json({
      success: true,
      message: 'Producto desactivado exitosamente'
    });
  } catch (error) {
    console.error('Error en deactivateProduct:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al desactivar producto'});
  }
};

/**
 * Eliminar un producto permanentemente (hard delete)
 */
const deleteProductPermanently = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    let whereClause = { id };

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({ where: whereClause });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    await product.destroy();

    res.json({
      success: true,
      message: 'Producto eliminado permanentemente'
    });
  } catch (error) {
    console.error('Error en deleteProductPermanently:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar producto'});
  }
};

/**
 * Buscar un producto por código de barras
 */
const getProductByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    if (!barcode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Código de barras requerido' 
      });
    }

    let whereClause = { barcode: barcode.trim() };

    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({
      where: whereClause,
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }]
    });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductByBarcode:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al buscar producto por código de barras'});
  }
};

/**
 * Verificar si existe un código de barras
 */
const checkBarcodeExists = async (req, res) => {
  try {
    const { barcode } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    if (!barcode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Código de barras requerido' 
      });
    }

    let whereClause = { barcode: barcode.trim() };

    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({
      where: whereClause,
      attributes: ['id', 'sku', 'name', 'barcode']
    });

    res.json({ 
      success: true, 
      exists: !!product,
      product: product || null
    });
  } catch (error) {
    console.error('Error en checkBarcodeExists:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al verificar código de barras'});
  }
};

/**
 * Obtener proveedores de un producto
 */
const getProductSuppliers = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    const Supplier = require('../../models/inventory/Supplier');
    const ProductSupplier = require('../../models/inventory/ProductSupplier');
    const { Purchase, PurchaseItem } = require('../../models/inventory');

    let whereClause = { id };
    const tenant_id = req.user.tenant_id;

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      if (!tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'Usuario sin tenant asignado'
        });
      }
      whereClause.tenant_id = tenant_id;
    }

    const product = await Product.findOne({
      where: whereClause,
      include: [{
        model: Supplier,
        as: 'suppliers',
        through: {
          model: ProductSupplier,
          attributes: ['last_price', 'last_purchase_date', 'lead_time_days']
        },
        attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active']
      }]
    });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Producto no encontrado' 
      });
    }

    // Transformar los datos de la tabla pivote
    const suppliersFromPivot = product.suppliers.map(supplier => ({
      id: supplier.id,
      name: supplier.name,
      business_name: supplier.business_name,
      contact_name: supplier.contact_name,
      phone: supplier.phone,
      email: supplier.email,
      is_active: supplier.is_active,
      last_price: supplier.ProductSupplier?.last_price || null,
      last_purchase_date: supplier.ProductSupplier?.last_purchase_date || null,
      lead_time_days: supplier.ProductSupplier?.lead_time_days || null
    }));

    // ✅ Fallback: buscar proveedores en historial de compras recibidas
    // si no hay proveedores en la tabla pivote o no tienen precio
    const needsEnrichment = suppliersFromPivot.length === 0 || 
      suppliersFromPivot.every(s => !s.last_price);

    let suppliersData = suppliersFromPivot;

    if (needsEnrichment && tenant_id) {
      try {
        const purchaseItems = await PurchaseItem.findAll({
          where: { product_id: id },
          include: [{
            model: Purchase,
            as: 'purchase',
            where: { tenant_id, status: 'received' },
            include: [{
              model: Supplier,
              as: 'supplier',
              attributes: ['id', 'name', 'business_name', 'contact_name', 'phone', 'email', 'is_active']
            }],
            attributes: ['id', 'purchase_date', 'supplier_id']
          }],
          attributes: ['unit_cost'],
          order: [[{ model: Purchase, as: 'purchase' }, 'purchase_date', 'DESC']]
        });

        // Agrupar por proveedor, quedarnos con el más reciente
        const supplierMap = {};
        for (const item of purchaseItems) {
          const sup = item.purchase?.supplier;
          if (!sup) continue;
          if (!supplierMap[sup.id]) {
            supplierMap[sup.id] = {
              id: sup.id,
              name: sup.name,
              business_name: sup.business_name,
              contact_name: sup.contact_name,
              phone: sup.phone,
              email: sup.email,
              is_active: sup.is_active,
              last_price: parseFloat(item.unit_cost) || null,
              last_purchase_date: item.purchase.purchase_date || null,
              lead_time_days: null
            };
          }
        }

        const suppliersFromHistory = Object.values(supplierMap);

        if (suppliersFromHistory.length > 0) {
          // Mezclar: priorizar datos de tabla pivote, completar con historial
          const pivotIds = new Set(suppliersFromPivot.map(s => s.id));
          const onlyInHistory = suppliersFromHistory.filter(s => !pivotIds.has(s.id));
          
          // Enriquecer los de pivote sin precio con datos de historial
          const enrichedPivot = suppliersFromPivot.map(s => {
            if (!s.last_price) {
              const hist = supplierMap[s.id];
              if (hist) return { ...s, last_price: hist.last_price, last_purchase_date: hist.last_purchase_date };
            }
            return s;
          });

          suppliersData = [...enrichedPivot, ...onlyInHistory];
        }
      } catch (histErr) {
        console.error('Error buscando historial de compras para enriquecer proveedores:', histErr);
        // No fallar, usar lo que tenemos
      }
    }

    res.json({ 
      success: true, 
      data: suppliersData
    });
  } catch (error) {
    console.error('Error en getProductSuppliers:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener proveedores del producto'});
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
  checkBarcodeExists
};