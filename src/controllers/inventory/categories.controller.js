const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Category } = require('../../models/inventory');

/**
 * Obtener todas las categorías
 */
const getAllCategories = async (req, res) => {
  try {
    const { include_inactive = 'false' } = req.query;

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

    if (include_inactive !== 'true') {
      whereClause.is_active = true;
    }

    const categories = await Category.findAll({
      where: whereClause,
      include: [{
        model: Category,
        as: 'parent',
        attributes: ['id', 'name']
      }],
      order: [['name', 'ASC']],
      attributes: ['id', 'name', 'description', 'parent_id', 'is_active', 'created_at']
    });

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Error en getAllCategories:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener categorías', 
      error: error.message 
    });
  }
};

/**
 * Obtener una categoría por ID
 */
const getCategoryById = async (req, res) => {
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

    const category = await Category.findOne({
      where: whereClause,
      include: [
        {
          model: Category,
          as: 'parent',
          attributes: ['id', 'name']
        },
        {
          model: Category,
          as: 'subcategories',
          attributes: ['id', 'name', 'is_active']
        }
      ]
    });

    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Categoría no encontrada' 
      });
    }

    res.json({ success: true, data: category });
  } catch (error) {
    console.error('Error en getCategoryById:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener categoría', 
      error: error.message 
    });
  }
};

/**
 * Crear una nueva categoría
 */
const createCategory = async (req, res) => {
  try {
    const { name, description, parent_id, is_active = true } = req.body;

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
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'El nombre es requerido' 
      });
    }

    // Determinar tenant_id a usar
    const tenantId = req.user.role === 'super_admin' 
      ? (req.body.tenant_id || null) 
      : req.user.tenant_id;

    // Verificar que no exista otra categoría con el mismo nombre
    const existing = await Category.findOne({
      where: {
        name: name.trim(),
        tenant_id: tenantId
      }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Ya existe una categoría con ese nombre' 
      });
    }

    const category = await Category.create({
      tenant_id: tenantId,
      name: name.trim(),
      description: description?.trim() || null,
      parent_id: parent_id || null,
      is_active
    });

    const newCategory = await Category.findOne({
      where: { id: category.id },
      include: [{
        model: Category,
        as: 'parent',
        attributes: ['id', 'name']
      }]
    });

    res.status(201).json({
      success: true,
      message: 'Categoría creada exitosamente',
      data: newCategory
    });
  } catch (error) {
    console.error('Error en createCategory:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear categoría', 
      error: error.message 
    });
  }
};

/**
 * Actualizar una categoría
 */
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, parent_id, is_active } = req.body;

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
        message: 'Usuario sin tenant asignado'
      });
    }

    let whereClause = { id };

    // ✅ Filtrar por tenant si no es super_admin
    if (req.user.role !== 'super_admin') {
      whereClause.tenant_id = req.user.tenant_id;
    }

    const category = await Category.findOne({ where: whereClause });

    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Categoría no encontrada' 
      });
    }

    // Determinar tenant_id para validaciones
    const tenantId = req.user.role === 'super_admin' 
      ? category.tenant_id 
      : req.user.tenant_id;

    // Si se cambia el nombre, verificar que no exista
    if (name && name.trim() !== category.name) {
      const existing = await Category.findOne({
        where: {
          name: name.trim(),
          tenant_id: tenantId,
          id: { [Op.ne]: id }
        }
      });

      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ya existe una categoría con ese nombre' 
        });
      }
    }

    // No permitir que una categoría sea su propia padre
    if (parent_id && parent_id === id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Una categoría no puede ser su propia categoría padre' 
      });
    }

    await category.update({
      name: name ? name.trim() : category.name,
      description: description !== undefined ? (description?.trim() || null) : category.description,
      parent_id: parent_id !== undefined ? parent_id : category.parent_id,
      is_active: is_active !== undefined ? is_active : category.is_active
    });

    const updatedCategory = await Category.findOne({
      where: { id },
      include: [{
        model: Category,
        as: 'parent',
        attributes: ['id', 'name']
      }]
    });

    res.json({
      success: true,
      message: 'Categoría actualizada exitosamente',
      data: updatedCategory
    });
  } catch (error) {
    console.error('Error en updateCategory:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar categoría', 
      error: error.message 
    });
  }
};

/**
 * Desactivar categoría (soft delete)
 */
const deactivateCategory = async (req, res) => {
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

    const category = await Category.findOne({ where: whereClause });

    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Categoría no encontrada' 
      });
    }

    await category.update({ is_active: false });

    res.json({
      success: true,
      message: 'Categoría desactivada exitosamente'
    });
  } catch (error) {
    console.error('Error en deactivateCategory:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al desactivar categoría', 
      error: error.message 
    });
  }
};

/**
 * Eliminar categoría permanentemente
 */
const deleteCategoryPermanently = async (req, res) => {
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

    const category = await Category.findOne({ where: whereClause });

    if (!category) {
      return res.status(404).json({ 
        success: false, 
        message: 'Categoría no encontrada' 
      });
    }

    // Verificar si tiene productos asociados
    const [products] = await sequelize.query(`
      SELECT COUNT(*) as count FROM products WHERE category_id = :category_id
    `, {
      replacements: { category_id: id }
    });

    if (products[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `No se puede eliminar. Hay ${products[0].count} producto(s) asociado(s) a esta categoría`
      });
    }

    // Verificar si tiene subcategorías
    const subcategories = await Category.count({ where: { parent_id: id } });

    if (subcategories > 0) {
      return res.status(400).json({
        success: false,
        message: `No se puede eliminar. Hay ${subcategories} subcategoría(s) asociada(s)`
      });
    }

    await category.destroy();

    res.json({
      success: true,
      message: 'Categoría eliminada permanentemente'
    });
  } catch (error) {
    console.error('Error en deleteCategoryPermanently:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar categoría', 
      error: error.message 
    });
  }
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
  deleteCategoryPermanently
};