const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Product, Category } = require('../../models/inventory');

const getProductStats = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = {};
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
      whereClause.tenant_id = req.user.tenant_id;
    }
    const totalProducts = await Product.count({ where: whereClause });
    const activeProducts = await Product.count({ where: { ...whereClause, is_active: true } });
    const inactiveProducts = await Product.count({ where: { ...whereClause, is_active: false } });
    const lowStockProducts = await Product.count({ where: { ...whereClause, current_stock: { [Op.lt]: sequelize.col('min_stock') }, track_inventory: true, is_active: true } });
    const outOfStockProducts = await Product.count({ where: { ...whereClause, current_stock: { [Op.lte]: 0 }, track_inventory: true, is_active: true } });
    const products = await Product.findAll({ where: { ...whereClause, is_active: true }, attributes: ['current_stock', 'average_cost'] });
    const totalInventoryValue = products.reduce((sum, p) => sum + (parseFloat(p.current_stock) || 0) * (parseFloat(p.average_cost) || 0), 0);
    res.json({ success: true, data: { total: totalProducts, total_products: totalProducts, active: activeProducts, active_products: activeProducts, inactive: inactiveProducts, inactive_products: inactiveProducts, lowStock: lowStockProducts, low_stock_products: lowStockProducts, outOfStock: outOfStockProducts, out_of_stock_products: outOfStockProducts, totalInventoryValue, total_inventory_value: totalInventoryValue } });
  } catch (error) {
    console.error('Error en getProductStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', category_id = '', is_active = '', sort_by = 'name', sort_order = 'ASC' } = req.query;
    const offset = (page - 1) * limit;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    let whereClause = {};
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
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
    if (category_id) whereClause.category_id = category_id;
    if (is_active !== '') whereClause.is_active = is_active === 'true';
    const { count, rows } = await Product.findAndCountAll({
      where: whereClause,
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [[sort_by, sort_order.toUpperCase()]]
    });
    res.json({ success: true, data: rows, pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / limit) } });
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
    const product = await Product.findOne({ where: whereClause, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }] });
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
      min_stock = 0, max_stock, product_type = 'product',
      track_inventory = true, is_active = true, is_for_sale = true,
      is_for_purchase = true, has_tax = true, tax_percentage = 19, price_includes_tax = false
    } = req.body;

    if (!sku || !name) return res.status(400).json({ success: false, message: 'SKU y nombre son requeridos' });

    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;

    const existingSku = await Product.findOne({ where: { sku: sku.trim(), tenant_id: tenantId } });
    if (existingSku) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese SKU' });

    if (barcode) {
      const existingBarcode = await Product.findOne({ where: { barcode: barcode.trim(), tenant_id: tenantId } });
      if (existingBarcode) return res.status(400).json({ success: false, message: 'Ya existe un producto con ese código de barras' });
    }

    const available_stock = parseFloat(current_stock) - parseFloat(reserved_stock);
    const product = await Product.create({
      tenant_id: tenantId,
      sku: sku.trim(),
      barcode: barcode ? barcode.trim() : null,
      name: name.trim(),
      description: description?.trim() || null,
      category_id: category_id || null,
      warehouse_id: warehouse_id || null,
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
      is_active, is_for_sale, is_for_purchase, has_tax, tax_percentage, price_includes_tax
    });

    const newProduct = await Product.findOne({ where: { id: product.id }, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }] });
    res.status(201).json({ success: true, message: 'Producto creado exitosamente', data: newProduct });
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

    await product.update(updateData);
    const updatedProduct = await Product.findOne({ where: { id }, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }] });
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
    const product = await Product.findOne({ where: whereClause, include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }] });
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