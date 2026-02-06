const { Supplier } = require('../../models/inventory');
const { Op } = require('sequelize');

/**
 * Obtener todos los proveedores con filtros y paginación
 */
const getSuppliers = async (req, res) => {
  try {
    const {
      search = '',
      is_active,
      sort_by = 'name',
      sort_order = 'ASC',
      page = 1,
      limit = 10
    } = req.query;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;

    // Construir condiciones de búsqueda
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { business_name: { [Op.iLike]: `%${search}%` } },
        { tax_id: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { contact_name: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (is_active !== undefined && is_active !== '') {
      where.is_active = is_active === 'true';
    }

    // Obtener proveedores
    const { count, rows } = await Supplier.findAndCountAll({
      where,
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error en getSuppliers:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener proveedores', 
      error: error.message 
    });
  }
};

/**
 * Obtener un proveedor por ID
 */
const getSupplierById = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;

    const supplier = await Supplier.findOne({
      where: { id, tenant_id }
    });

    if (!supplier) {
      return res.status(404).json({ 
        success: false, 
        message: 'Proveedor no encontrado' 
      });
    }

    res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    console.error('Error en getSupplierById:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener proveedor', 
      error: error.message 
    });
  }
};

/**
 * Crear un nuevo proveedor
 */
const createSupplier = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;
    const {
      name,
      business_name,
      tax_id,
      email,
      phone,
      mobile,
      address,
      city,
      state,
      country,
      postal_code,
      contact_name,
      contact_phone,
      contact_email,
      payment_terms,
      credit_limit,
      website,
      notes,
      is_active = true,
      rating
    } = req.body;

    // Validar campos requeridos
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'El nombre del proveedor es requerido' 
      });
    }

    // Verificar si ya existe un proveedor con el mismo tax_id
    if (tax_id) {
      const existingSupplier = await Supplier.findOne({
        where: { tenant_id, tax_id }
      });

      if (existingSupplier) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe un proveedor con ese NIT/RUT' 
        });
      }
    }

    const supplier = await Supplier.create({
      tenant_id,
      name,
      business_name,
      tax_id,
      email,
      phone,
      mobile,
      address,
      city,
      state,
      country: country || 'Colombia',
      postal_code,
      contact_name,
      contact_phone,
      contact_email,
      payment_terms,
      credit_limit: credit_limit || 0,
      current_balance: 0,
      website,
      notes,
      is_active,
      rating
    });

    res.status(201).json({
      success: true,
      message: 'Proveedor creado exitosamente',
      data: supplier
    });
  } catch (error) {
    console.error('Error en createSupplier:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear proveedor', 
      error: error.message 
    });
  }
};

/**
 * Actualizar un proveedor
 */
const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;
    const updateData = req.body;

    const supplier = await Supplier.findOne({
      where: { id, tenant_id }
    });

    if (!supplier) {
      return res.status(404).json({ 
        success: false, 
        message: 'Proveedor no encontrado' 
      });
    }

    // Verificar si se está actualizando el tax_id y si ya existe
    if (updateData.tax_id && updateData.tax_id !== supplier.tax_id) {
      const existingSupplier = await Supplier.findOne({
        where: {
          tenant_id,
          tax_id: updateData.tax_id,
          id: { [Op.ne]: id }
        }
      });

      if (existingSupplier) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe un proveedor con ese NIT/RUT' 
        });
      }
    }

    await supplier.update(updateData);

    res.json({
      success: true,
      message: 'Proveedor actualizado exitosamente',
      data: supplier
    });
  } catch (error) {
    console.error('Error en updateSupplier:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar proveedor', 
      error: error.message 
    });
  }
};

/**
 * Desactivar un proveedor (soft delete)
 */
const deactivateSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;

    const supplier = await Supplier.findOne({
      where: { id, tenant_id }
    });

    if (!supplier) {
      return res.status(404).json({ 
        success: false, 
        message: 'Proveedor no encontrado' 
      });
    }

    await supplier.update({ is_active: false });

    res.json({
      success: true,
      message: 'Proveedor desactivado exitosamente'
    });
  } catch (error) {
    console.error('Error en deactivateSupplier:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al desactivar proveedor', 
      error: error.message 
    });
  }
};

/**
 * Activar un proveedor
 */
const activateSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;

    const supplier = await Supplier.findOne({
      where: { id, tenant_id }
    });

    if (!supplier) {
      return res.status(404).json({ 
        success: false, 
        message: 'Proveedor no encontrado' 
      });
    }

    await supplier.update({ is_active: true });

    res.json({
      success: true,
      message: 'Proveedor activado exitosamente'
    });
  } catch (error) {
    console.error('Error en activateSupplier:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al activar proveedor', 
      error: error.message 
    });
  }
};

/**
 * Eliminar un proveedor permanentemente
 */
const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;

    const supplier = await Supplier.findOne({
      where: { id, tenant_id }
    });

    if (!supplier) {
      return res.status(404).json({ 
        success: false, 
        message: 'Proveedor no encontrado' 
      });
    }

    // Verificar si tiene compras asociadas
    const { Purchase } = require('../../models/inventory');
    const purchaseCount = await Purchase.count({
      where: { supplier_id: id }
    });

    if (purchaseCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No se puede eliminar el proveedor porque tiene compras asociadas' 
      });
    }

    await supplier.destroy();

    res.json({
      success: true,
      message: 'Proveedor eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error en deleteSupplier:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar proveedor', 
      error: error.message 
    });
  }
};

/**
 * Obtener estadísticas de proveedores
 */
const getSupplierStats = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado'
      });
    }

    const tenant_id = req.user.tenant_id;

    const totalSuppliers = await Supplier.count({
      where: { tenant_id }
    });

    const activeSuppliers = await Supplier.count({
      where: { tenant_id, is_active: true }
    });

    const inactiveSuppliers = await Supplier.count({
      where: { tenant_id, is_active: false }
    });

    res.json({
      success: true,
      data: {
        total: totalSuppliers,
        active: activeSuppliers,
        inactive: inactiveSuppliers
      }
    });
  } catch (error) {
    console.error('Error en getSupplierStats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener estadísticas', 
      error: error.message 
    });
  }
};

module.exports = {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  activateSupplier,
  deleteSupplier,
  getSupplierStats
};