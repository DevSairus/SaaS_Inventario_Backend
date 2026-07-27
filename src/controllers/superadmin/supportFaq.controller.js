const { SupportFaqCategory, SupportFaqArticle } = require('../../models');
const logger = require('../../config/logger');

// ===== Categorías =====

const listCategories = async (req, res) => {
  try {
    const categories = await SupportFaqCategory.findAll({
      order: [['order', 'ASC'], ['name', 'ASC']],
      include: [{ model: SupportFaqArticle, as: 'articles', separate: true, order: [['order', 'ASC']] }],
    });
    res.json({ success: true, data: categories });
  } catch (error) {
    logger.error('Error listando categorías de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener las categorías',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const createCategory = async (req, res) => {
  try {
    const { name, order, is_active } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    }
    const category = await SupportFaqCategory.create({
      name: name.trim(),
      order: order ?? 0,
      is_active: is_active ?? true,
    });
    res.status(201).json({ success: true, message: 'Categoría creada', data: category });
  } catch (error) {
    logger.error('Error creando categoría de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear la categoría',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await SupportFaqCategory.findByPk(id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
    }
    const { name, order, is_active } = req.body;
    await category.update({
      ...(name !== undefined && { name: name.trim() }),
      ...(order !== undefined && { order }),
      ...(is_active !== undefined && { is_active }),
    });
    res.json({ success: true, message: 'Categoría actualizada', data: category });
  } catch (error) {
    logger.error('Error actualizando categoría de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar la categoría',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await SupportFaqCategory.findByPk(id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
    }
    await category.destroy();
    res.json({ success: true, message: 'Categoría eliminada' });
  } catch (error) {
    logger.error('Error eliminando categoría de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar la categoría',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// ===== Artículos =====

const createArticle = async (req, res) => {
  try {
    const { category_id, question, answer, order, is_active } = req.body;
    if (!category_id || !question?.trim() || !answer?.trim()) {
      return res.status(400).json({ success: false, message: 'category_id, question y answer son requeridos' });
    }
    const category = await SupportFaqCategory.findByPk(category_id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
    }
    const article = await SupportFaqArticle.create({
      category_id,
      question: question.trim(),
      answer: answer.trim(),
      order: order ?? 0,
      is_active: is_active ?? true,
    });
    res.status(201).json({ success: true, message: 'Artículo creado', data: article });
  } catch (error) {
    logger.error('Error creando artículo de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear el artículo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updateArticle = async (req, res) => {
  try {
    const { id } = req.params;
    const article = await SupportFaqArticle.findByPk(id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Artículo no encontrado' });
    }
    const { category_id, question, answer, order, is_active } = req.body;
    await article.update({
      ...(category_id !== undefined && { category_id }),
      ...(question !== undefined && { question: question.trim() }),
      ...(answer !== undefined && { answer: answer.trim() }),
      ...(order !== undefined && { order }),
      ...(is_active !== undefined && { is_active }),
    });
    res.json({ success: true, message: 'Artículo actualizado', data: article });
  } catch (error) {
    logger.error('Error actualizando artículo de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el artículo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deleteArticle = async (req, res) => {
  try {
    const { id } = req.params;
    const article = await SupportFaqArticle.findByPk(id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Artículo no encontrado' });
    }
    await article.destroy();
    res.json({ success: true, message: 'Artículo eliminado' });
  } catch (error) {
    logger.error('Error eliminando artículo de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar el artículo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  createArticle,
  updateArticle,
  deleteArticle,
};
