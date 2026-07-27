const { Op, fn, col, literal } = require('sequelize');
const {
  SupportTicket,
  SupportTicketMessage,
  SupportFaqArticle,
  SupportFaqCategory,
  Tenant,
} = require('../../models');
const logger = require('../../config/logger');

// GET /api/superadmin/support/stats
const getStats = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const dateFilter = {};
    if (start_date && end_date) {
      dateFilter.created_at = { [Op.between]: [new Date(start_date), new Date(end_date)] };
    }

    // ── Totales por estado ──
    const statusCounts = await SupportTicket.findAll({
      where: dateFilter,
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    });

    // ── Totales por prioridad ──
    const priorityCounts = await SupportTicket.findAll({
      where: dateFilter,
      attributes: ['priority', [fn('COUNT', col('id')), 'count']],
      group: ['priority'],
      raw: true,
    });

    // ── Totales por categoría ──
    const categoryCounts = await SupportTicket.findAll({
      where: { ...dateFilter, category: { [Op.ne]: null } },
      attributes: ['category', [fn('COUNT', col('id')), 'count']],
      group: ['category'],
      raw: true,
    });

    // ── Totales por tenant (top 10) ──
    const tenantCounts = await SupportTicket.findAll({
      where: dateFilter,
      attributes: ['tenant_id', [fn('COUNT', col('SupportTicket.id')), 'count']],
      include: [{ model: Tenant, as: 'tenant', attributes: ['company_name'] }],
      group: ['tenant_id', 'tenant.id', 'tenant.company_name'],
      order: [[fn('COUNT', col('SupportTicket.id')), 'DESC']],
      limit: 10,
      raw: true,
      nest: true,
    });

    // ── Tickets por mes (últimos 12 meses) ──
    const monthlyTickets = await SupportTicket.findAll({
      attributes: [
        [fn('TO_CHAR', col('created_at'), 'YYYY-MM'), 'month'],
        [fn('COUNT', col('id')), 'count'],
      ],
      group: [fn('TO_CHAR', col('created_at'), 'YYYY-MM')],
      order: [[fn('TO_CHAR', col('created_at'), 'YYYY-MM'), 'ASC']],
      limit: 12,
      raw: true,
    });

    // ── Tiempos promedio ──
    const avgFirstResponse = await SupportTicket.findOne({
      where: {
        ...dateFilter,
        first_response_at: { [Op.ne]: null },
      },
      attributes: [
        [fn('AVG', literal("EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600")), 'avg_hours'],
      ],
      raw: true,
    });

    const avgResolution = await SupportTicket.findOne({
      where: {
        ...dateFilter,
        resolved_at: { [Op.ne]: null },
      },
      attributes: [
        [fn('AVG', literal("EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600")), 'avg_hours'],
      ],
      raw: true,
    });

    // ── Satisfacción ──
    const ratingStats = await SupportTicket.findOne({
      where: { ...dateFilter, rating: { [Op.ne]: null } },
      attributes: [
        [fn('AVG', col('rating')), 'avg_rating'],
        [fn('COUNT', col('rating')), 'total_ratings'],
      ],
      raw: true,
    });

    // ── FAQ stats ──
    const faqStats = await SupportFaqArticle.findAll({
      where: { is_active: true },
      attributes: ['id', 'question', 'helpful_count', 'not_helpful_count'],
      order: [[literal('helpful_count + not_helpful_count'), 'DESC']],
      limit: 10,
      raw: true,
    });

    // ── Resumen general ──
    const totalTickets = await SupportTicket.count({ where: dateFilter });
    const openTickets = await SupportTicket.count({
      where: { ...dateFilter, status: { [Op.in]: ['open', 'in_progress', 'waiting_customer'] } },
    });
    const closedTickets = await SupportTicket.count({
      where: { ...dateFilter, status: { [Op.in]: ['resolved', 'closed'] } },
    });

    res.json({
      success: true,
      data: {
        summary: {
          total: totalTickets,
          open: openTickets,
          closed: closedTickets,
          avg_first_response_hours: avgFirstResponse?.avg_hours
            ? parseFloat(parseFloat(avgFirstResponse.avg_hours).toFixed(1))
            : null,
          avg_resolution_hours: avgResolution?.avg_hours
            ? parseFloat(parseFloat(avgResolution.avg_hours).toFixed(1))
            : null,
          avg_rating: ratingStats?.avg_rating
            ? parseFloat(parseFloat(ratingStats.avg_rating).toFixed(1))
            : null,
          total_ratings: parseInt(ratingStats?.total_ratings || 0),
        },
        by_status: statusCounts,
        by_priority: priorityCounts,
        by_category: categoryCounts,
        by_tenant: tenantCounts,
        monthly: monthlyTickets,
        faq: faqStats,
      },
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas de soporte:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = { getStats };
