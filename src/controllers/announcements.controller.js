// controllers/announcements.controller.js
const { 
  Announcement, 
  UserAnnouncementView, 
  User 
} = require('../models');
const { Op } = require('sequelize');

/**
 * Obtener anuncios pendientes para el usuario actual
 * Solo devuelve anuncios que el usuario no ha visto
 */
exports.getPendingAnnouncements = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Determinar target_audience según el rol
    let targetAudiences = ['all'];
    if (userRole === 'super_admin') {
      targetAudiences.push('superadmin');
    } else {
      targetAudiences.push('tenants');
    }

    const announcements = await Announcement.findAll({
      where: {
        is_active: true,
        target_audience: {
          [Op.in]: targetAudiences
        },
        [Op.or]: [
          { expires_at: null },
          { expires_at: { [Op.gt]: new Date() } }
        ]
      },
      include: [
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'first_name', 'last_name', 'email'],
          required: false
        }
      ],
      order: [
        ['priority', 'DESC'], // critical, high, normal, low
        ['release_date', 'DESC']
      ]
    });

    // Filtrar los que el usuario NO ha visto
    const viewedAnnouncementIds = await UserAnnouncementView.findAll({
      where: { user_id: userId },
      attributes: ['announcement_id'],
      raw: true
    }).then(views => views.map(v => v.announcement_id));

    const pendingAnnouncements = announcements.filter(
      a => !viewedAnnouncementIds.includes(a.id)
    );

    res.json({
      success: true,
      count: pendingAnnouncements.length,
      announcements: pendingAnnouncements
    });
  } catch (error) {
    console.error('Error al obtener anuncios pendientes:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener anuncios',
      error: error.message
    });
  }
};

/**
 * Marcar un anuncio como visto
 */
exports.markAsViewed = async (req, res) => {
  try {
    const userId = req.user.id;
    const { announcementId } = req.params;

    // Verificar que el anuncio existe
    const announcement = await Announcement.findByPk(announcementId);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: 'Anuncio no encontrado'
      });
    }

    // Crear o actualizar la vista
    const [view, created] = await UserAnnouncementView.findOrCreate({
      where: {
        user_id: userId,
        announcement_id: announcementId
      },
      defaults: {
        viewed_at: new Date()
      }
    });

    res.json({
      success: true,
      message: created ? 'Anuncio marcado como visto' : 'Ya estaba marcado como visto',
      view
    });
  } catch (error) {
    console.error('Error al marcar anuncio como visto:', error);
    res.status(500).json({
      success: false,
      message: 'Error al marcar anuncio como visto',
      error: error.message
    });
  }
};

/**
 * Marcar un anuncio como descartado
 */
exports.dismissAnnouncement = async (req, res) => {
  try {
    const userId = req.user.id;
    const { announcementId } = req.params;

    const view = await UserAnnouncementView.findOne({
      where: {
        user_id: userId,
        announcement_id: announcementId
      }
    });

    if (view) {
      view.dismissed_at = new Date();
      await view.save();
    } else {
      // Crear la vista como descartada
      await UserAnnouncementView.create({
        user_id: userId,
        announcement_id: announcementId,
        viewed_at: new Date(),
        dismissed_at: new Date()
      });
    }

    res.json({
      success: true,
      message: 'Anuncio descartado'
    });
  } catch (error) {
    console.error('Error al descartar anuncio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al descartar anuncio',
      error: error.message
    });
  }
};

// ==========================================
// ENDPOINTS PARA SUPERADMIN
// ==========================================

/**
 * Obtener todos los anuncios (superadmin)
 */
exports.getAllAnnouncements = async (req, res) => {
  try {
    const { page = 1, limit = 20, is_active, type } = req.query;

    const where = {};
    if (is_active !== undefined) {
      where.is_active = is_active === 'true';
    }
    if (type) {
      where.type = type;
    }

    const announcements = await Announcement.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'first_name', 'last_name', 'email'],
          required: false
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    // Obtener estadísticas de visualización para cada anuncio
    const announcementsWithStats = await Promise.all(
      announcements.rows.map(async (announcement) => {
        const viewCount = await UserAnnouncementView.count({
          where: { announcement_id: announcement.id }
        });

        return {
          ...announcement.toJSON(),
          view_count: viewCount
        };
      })
    );

    res.json({
      success: true,
      announcements: announcementsWithStats,
      pagination: {
        total: announcements.count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(announcements.count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error al obtener anuncios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener anuncios',
      error: error.message
    });
  }
};

/**
 * Crear un nuevo anuncio (superadmin)
 */
exports.createAnnouncement = async (req, res) => {
  try {
    const {
      title,
      content,
      type,
      priority,
      icon,
      version,
      expires_at,
      target_audience,
      show_once
    } = req.body;

    const announcement = await Announcement.create({
      title,
      content,
      type: type || 'feature',
      priority: priority || 'normal',
      icon: icon || 'star',
      version,
      expires_at,
      target_audience: target_audience || 'all',
      show_once: show_once !== undefined ? show_once : true,
      created_by: req.user.id,
      is_active: true
    });

    res.status(201).json({
      success: true,
      message: 'Anuncio creado exitosamente',
      announcement
    });
  } catch (error) {
    console.error('Error al crear anuncio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear anuncio',
      error: error.message
    });
  }
};

/**
 * Actualizar un anuncio (superadmin)
 */
exports.updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: 'Anuncio no encontrado'
      });
    }

    await announcement.update(updates);

    res.json({
      success: true,
      message: 'Anuncio actualizado exitosamente',
      announcement
    });
  } catch (error) {
    console.error('Error al actualizar anuncio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar anuncio',
      error: error.message
    });
  }
};

/**
 * Eliminar un anuncio (superadmin)
 */
exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: 'Anuncio no encontrado'
      });
    }

    await announcement.destroy();

    res.json({
      success: true,
      message: 'Anuncio eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error al eliminar anuncio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar anuncio',
      error: error.message
    });
  }
};

/**
 * Obtener estadísticas de un anuncio (superadmin)
 */
exports.getAnnouncementStats = async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: 'Anuncio no encontrado'
      });
    }

    // Total de usuarios
    const totalUsers = await User.count({
      where: { is_active: true }
    });

    // Usuarios que vieron el anuncio
    const viewCount = await UserAnnouncementView.count({
      where: { announcement_id: id }
    });

    // Usuarios que descartaron el anuncio
    const dismissedCount = await UserAnnouncementView.count({
      where: {
        announcement_id: id,
        dismissed_at: { [Op.not]: null }
      }
    });

    res.json({
      success: true,
      stats: {
        total_users: totalUsers,
        viewed_count: viewCount,
        dismissed_count: dismissedCount,
        pending_count: totalUsers - viewCount,
        view_percentage: totalUsers > 0 ? ((viewCount / totalUsers) * 100).toFixed(2) : 0,
        dismissed_percentage: viewCount > 0 ? ((dismissedCount / viewCount) * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas',
      error: error.message
    });
  }
};