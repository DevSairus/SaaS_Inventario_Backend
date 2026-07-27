const { SupportFaqCategory, SupportFaqArticle } = require('../../models');
const logger = require('../../config/logger');

// GET /api/support/faq — listado de categorías con sus artículos (solo activos)
const getFaq = async (req, res) => {
  try {
    const categories = await SupportFaqCategory.findAll({
      where: { is_active: true },
      order: [['order', 'ASC'], ['name', 'ASC']],
      include: [{
        model: SupportFaqArticle,
        as: 'articles',
        where: { is_active: true },
        required: false,
        separate: true,
        order: [['order', 'ASC']],
      }],
    });

    res.json({ success: true, data: categories });
  } catch (error) {
    logger.error('Error obteniendo FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener las preguntas frecuentes',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// POST /api/support/faq/:id/feedback — marcar artículo como útil/no útil
const submitFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { helpful } = req.body;

    if (typeof helpful !== 'boolean') {
      return res.status(400).json({ success: false, message: 'El campo "helpful" (boolean) es requerido' });
    }

    const article = await SupportFaqArticle.findOne({ where: { id, is_active: true } });
    if (!article) {
      return res.status(404).json({ success: false, message: 'Artículo no encontrado' });
    }

    if (helpful) {
      await article.increment('helpful_count');
    } else {
      await article.increment('not_helpful_count');
    }

    res.json({ success: true, message: 'Gracias por tu feedback' });
  } catch (error) {
    logger.error('Error registrando feedback de FAQ:', error);
    res.status(500).json({
      success: false,
      message: 'Error al registrar el feedback',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  getFaq,
  submitFeedback,
};
