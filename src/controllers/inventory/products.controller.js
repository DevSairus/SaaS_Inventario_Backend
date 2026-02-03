const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Product, Category } = require('../../models/inventory');

/**
 * Obtener estadísticas de productos
 */
const getProductStats = async (req, res) => {
  try {
    let whereClause = {};

    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id || null;
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
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas', error: error.message });
  }
};

/**
 * Obtener todos los productos
 */
const getAllProducts = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', category_id = '', is_active = '', sort_by = 'name', sort_order = 'ASC' } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = {};

    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id || null;
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
    res.status(500).json({ success: false, message: 'Error al obtener productos', error: error.message });
  }
};

/**
 * Obtener un producto por ID
 */
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findOne({
      where: { id },
      include: [{
        model: Category,
        as: 'category',
        attributes: ['id', 'name']
      }]
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener producto', error: error.message });
  }
};

/**
 * Crear un nuevo producto
 */
const createProduct = async (req, res) => {
  try {
    // Debug: Ver qué llega en req.user
    console.log('🔍 DEBUG createProduct:');
    console.log('   req.user:', req.user);
    console.log('   req.user.tenant_id:', req.user?.tenant_id);
    console.log('   req.body:', JSON.stringify(req.body, null, 2));

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
      track_inventory = true,
      is_active = true,
      is_for_sale = true,
      is_for_purchase = true
    } = req.body;

    // Validación de tenant_id
    if (!req.user || !req.user.tenant_id) {
      console.log('❌ ERROR: Usuario sin tenant_id');
      return res.status(400).json({ 
        success: false, 
        message: 'Error: Usuario sin tenant_id. Por favor, cierra sesión y vuelve a iniciar sesión.' 
      });
    }

    if (!sku || !name) {
      return res.status(400).json({ success: false, message: 'SKU y nombre son requeridos' });
    }

    const existingSku = await Product.findOne({
      where: {
        sku: sku.trim(),
        tenant_id: req.user.tenant_id || null
      }
    });

    if (existingSku) {
      return res.status(400).json({ success: false, message: 'Ya existe un producto con ese SKU' });
    }

    if (barcode) {
      const existingBarcode = await Product.findOne({
        where: {
          barcode: barcode.trim(),
          tenant_id: req.user.tenant_id || null
        }
      });

      if (existingBarcode) {
        return res.status(400).json({ success: false, message: 'Ya existe un producto con ese código de barras' });
      }
    }

    const available_stock = parseFloat(current_stock) - parseFloat(reserved_stock);

    const product = await Product.create({
      tenant_id: req.user.tenant_id || null,
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
      current_stock,
      reserved_stock,
      available_stock,
      min_stock,
      max_stock,
      track_inventory,
      is_active,
      is_for_sale,
      is_for_purchase
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
    res.status(500).json({ success: false, message: 'Error al crear producto', error: error.message });
  }
};

/**
 * Actualizar un producto
 */
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Validación de tenant_id
    if (!req.user || !req.user.tenant_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Error: Usuario sin tenant_id. Por favor, contacte al administrador del sistema.' 
      });
    }

    const product = await Product.findOne({ where: { id } });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    if (updateData.sku && updateData.sku !== product.sku) {
      const existingSku = await Product.findOne({
        where: {
          sku: updateData.sku.trim(),
          tenant_id: req.user.tenant_id || null,
          id: { [Op.ne]: id }
        }
      });

      if (existingSku) {
        return res.status(400).json({ success: false, message: 'Ya existe un producto con ese SKU' });
      }
    }

    if (updateData.barcode && updateData.barcode !== product.barcode) {
      const existingBarcode = await Product.findOne({
        where: {
          barcode: updateData.barcode.trim(),
          tenant_id: req.user.tenant_id || null,
          id: { [Op.ne]: id }
        }
      });

      if (existingBarcode) {
        return res.status(400).json({ success: false, message: 'Ya existe un producto con ese código de barras' });
      }
    }

    if (updateData.current_stock !== undefined || updateData.reserved_stock !== undefined) {
      const current = updateData.current_stock !== undefined ? parseFloat(updateData.current_stock) : parseFloat(product.current_stock);
      const reserved = updateData.reserved_stock !== undefined ? parseFloat(updateData.reserved_stock) : parseFloat(product.reserved_stock);
      updateData.available_stock = current - reserved;
    }

    // CRÍTICO: Convertir strings vacíos a null para campos UUID y opcionales
    // PostgreSQL no acepta '' como UUID, debe ser null
    const fieldsToSanitize = [
      'category_id',    // UUID
      'barcode',        // string opcional
      'description',    // text opcional
      'brand',          // string opcional
      'unit_of_measure',// string opcional
      'max_stock'       // número opcional
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
    res.status(500).json({ success: false, message: 'Error al actualizar producto', error: error.message });
  }
};

/**
 * Desactivar un producto (soft delete)
 */
const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findOne({ where: { id } });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    await product.update({ is_active: false });

    res.json({
      success: true,
      message: 'Producto desactivado exitosamente'
    });
  } catch (error) {
    console.error('Error en deactivateProduct:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar producto', error: error.message });
  }
};

/**
 * Eliminar un producto permanentemente (hard delete)
 */
const deleteProductPermanently = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findOne({ where: { id } });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    await product.destroy();

    res.json({
      success: true,
      message: 'Producto eliminado permanentemente'
    });
  } catch (error) {
    console.error('Error en deleteProductPermanently:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar producto', error: error.message });
  }
};

/**
 * Buscar un producto por código de barras
 */
const getProductByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.status(400).json({ success: false, message: 'Código de barras requerido' });
    }

    let whereClause = { barcode: barcode.trim() };

    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id || null;
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
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error en getProductByBarcode:', error);
    res.status(500).json({ success: false, message: 'Error al buscar producto por código de barras', error: error.message });
  }
};

/**
 * Verificar si existe un código de barras
 */
const checkBarcodeExists = async (req, res) => {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.status(400).json({ success: false, message: 'Código de barras requerido' });
    }

    let whereClause = { barcode: barcode.trim() };

    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id || null;
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
    res.status(500).json({ success: false, message: 'Error al verificar código de barras', error: error.message });
  }
};

/**
 * Obtener proveedores de un producto
 */
const getProductSuppliers = async (req, res) => {
  try {
    const { id } = req.params;
    const Supplier = require('../../models/inventory/Supplier');
    const ProductSupplier = require('../../models/inventory/ProductSupplier');

    const product = await Product.findOne({
      where: { id },
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
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    // Transformar los datos para incluir la información de la tabla pivote
    const suppliersData = product.suppliers.map(supplier => ({
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

    res.json({ 
      success: true, 
      data: suppliersData
    });
  } catch (error) {
    console.error('Error en getProductSuppliers:', error);
    res.status(500).json({ success: false, message: 'Error al obtener proveedores del producto', error: error.message });
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