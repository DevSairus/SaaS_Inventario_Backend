/* eslint-disable indent */
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const { Op } = require('sequelize');

// Dashboard con métricas SaaS
const getDashboard = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    // Total de tenants
    const totalTenants = await Tenant.count();
    const activeTenants = await Tenant.count({
      where: { is_active: true, subscription_status: 'active' },
    });
    const trialTenants = await Tenant.count({
      where: { subscription_status: 'trial' },
    });
    const suspendedTenants = await Tenant.count({
      where: { subscription_status: 'suspended' },
    });

    // Nuevos tenants este mes
    const newTenantsThisMonth = await Tenant.count({
      where: {
        created_at: {
          [Op.gte]: startOfMonth,
        },
      },
    });

    // Nuevos tenants mes anterior
    const newTenantsLastMonth = await Tenant.count({
      where: {
        created_at: {
          [Op.between]: [startOfLastMonth, endOfLastMonth],
        },
      },
    });

    // Calcular crecimiento
    const growth =
      newTenantsLastMonth > 0
        ? (
            ((newTenantsThisMonth - newTenantsLastMonth) /
              newTenantsLastMonth) *
            100
          ).toFixed(1)
        : 100;

    // Total de usuarios en todas las empresas
    const totalUsers = await User.count({
      where: { tenant_id: { [Op.ne]: null } },
    });

    // Ingresos mensuales estimados (basado en planes)
    const planPrices = {
      free: 0,
      basic: 29,
      premium: 99,
      enterprise: 299,
    };

    const tenantsByPlan = await Tenant.findAll({
      where: { subscription_status: 'active' },
      attributes: [
        'plan',
        [Tenant.sequelize.fn('COUNT', Tenant.sequelize.col('id')), 'count'],
      ],
      group: ['plan'],
      raw: true,
    });

    let monthlyRevenue = 0;
    const revenueByPlan = {};

    tenantsByPlan.forEach((item) => {
      const revenue = planPrices[item.plan] * parseInt(item.count);
      monthlyRevenue += revenue;
      revenueByPlan[item.plan] = {
        count: parseInt(item.count),
        revenue: revenue,
      };
    });

    // MRR (Monthly Recurring Revenue)
    const mrr = monthlyRevenue;
    const arr = mrr * 12; // ARR (Annual Recurring Revenue)

    // Churn Rate (cancelados este mes)
    const cancelledThisMonth = await Tenant.count({
      where: {
        subscription_status: 'cancelled',
        updated_at: {
          [Op.gte]: startOfMonth,
        },
      },
    });

    const churnRate =
      totalTenants > 0
        ? ((cancelledThisMonth / totalTenants) * 100).toFixed(1)
        : 0;

    // Tenants por plan
    const allTenantsByPlan = await Tenant.findAll({
      attributes: [
        'plan',
        [Tenant.sequelize.fn('COUNT', Tenant.sequelize.col('id')), 'count'],
      ],
      group: ['plan'],
      raw: true,
    });

    // Últimos tenants creados
    const recentTenants = await Tenant.findAll({
      limit: 5,
      order: [['created_at', 'DESC']],
      attributes: [
        'id',
        'company_name',
        'plan',
        'subscription_status',
        'created_at',
        'is_active',
      ],
    });

    // Tenants próximos a vencer trial
    const trialEndingSoon = await Tenant.findAll({
      where: {
        subscription_status: 'trial',
        trial_ends_at: {
          [Op.between]: [
            now,
            new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          ], // próximos 7 días
        },
      },
      limit: 5,
      order: [['trial_ends_at', 'ASC']],
      attributes: ['id', 'company_name', 'trial_ends_at', 'email'],
    });

    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalTenants,
          activeTenants,
          trialTenants,
          suspendedTenants,
          newTenantsThisMonth,
          growth: parseFloat(growth),
          totalUsers,
          mrr,
          arr,
          churnRate: parseFloat(churnRate),
        },
        revenue: {
          monthly: mrr,
          annual: arr,
          byPlan: revenueByPlan,
        },
        tenantsByPlan: allTenantsByPlan,
        recentTenants,
        trialEndingSoon,
      },
    });
  } catch (error) {
    console.error('Error obteniendo dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener dashboard',
      error: error.message,
    });
  }
};
// Obtener todos los tenants
const getAllTenants = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      plan,
      subscription_status,
      is_active,
    } = req.query;

    const offset = (page - 1) * limit;
    const where = {};

    if (search) {
      where[Op.or] = [
        { company_name: { [Op.iLike]: `%${search}%` } },
        { business_name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (plan) {
      where.plan = plan;
    }

    if (subscription_status) {
      where.subscription_status = subscription_status;
    }

    // ✅ ARREGLO: Solo agregar filtro si is_active tiene valor
    if (is_active !== undefined && is_active !== '') {
      where.is_active = is_active === 'true';
    }

    const { count, rows: tenants } = await Tenant.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']],
      include: [
        {
          model: User,
          as: 'users',
          attributes: ['id'],
        },
      ],
    });

    // Agregar conteo de usuarios por tenant
    const tenantsWithCount = tenants.map((tenant) => ({
      ...tenant.toJSON(),
      userCount: tenant.users?.length || 0,
    }));

    res.status(200).json({
      success: true,
      data: {
        tenants: tenantsWithCount,
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count,
      },
    });
  } catch (error) {
    console.error('Error obteniendo tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener tenants',
      error: error.message,
    });
  }
};

const getTenantById = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findByPk(id, {
      include: [
        {
          model: User,
          as: 'users',
          attributes: [
            'id',
            'email',
            'first_name',
            'last_name',
            'role',
            'is_active',
          ],
        },
      ],
    });

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    // Estadísticas del tenant
    const stats = {
      totalUsers: await User.count({ where: { tenant_id: id } }),
      totalInvoices: await Invoice.count({ where: { tenant_id: id } }),
      totalPayments: await Payment.count({ where: { tenant_id: id } }),
      revenue:
        (await Payment.sum('amount', {
          where: { tenant_id: id, status: 'completed' },
        })) || 0,
    };

    res.status(200).json({
      success: true,
      data: {
        tenant,
        stats,
      },
    });
  } catch (error) {
    console.error('❌ Error obteniendo tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener tenant',
      error: error.message,
    });
  }
};
// Crear nuevo tenant
const createTenant = async (req, res) => {
  try {
    const {
      company_name,
      slug,
      business_name,
      tax_id,
      email,
      phone,
      address,
      plan,
      max_users,
      max_clients,
      max_invoices_per_month,
      admin_first_name,
      admin_last_name,
      admin_email,
      admin_password,
    } = req.body;

    // Verificar que el slug sea único
    const existingTenant = await Tenant.findOne({ where: { slug } });
    if (existingTenant) {
      return res.status(400).json({
        success: false,
        message: 'El slug ya está en uso',
      });
    }

    // Verificar que el email del admin sea único
    const existingAdmin = await User.findOne({ where: { email: admin_email } });
    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: 'El email del administrador ya está registrado',
      });
    }

    // Crear tenant
    const tenant = await Tenant.create({
      company_name,
      slug,
      business_name,
      tax_id,
      email,
      phone,
      address,
      plan: plan || 'free',
      subscription_status: 'trial',
      trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 días
      max_users: max_users || 3,
      max_clients: max_clients || 50,
      max_invoices_per_month: max_invoices_per_month || 100,
      is_active: true,
    });

    // Crear usuario admin del tenant
    const admin = await User.create({
      tenant_id: tenant.id,
      email: admin_email,
      password_hash: admin_password || 'temporal123',
      role: 'admin',
      first_name: admin_first_name,
      last_name: admin_last_name,
      is_active: true,
      email_verified: true,
      created_by: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Tenant creado exitosamente',
      data: {
        tenant,
        admin: {
          id: admin.id,
          email: admin.email,
          first_name: admin.first_name,
          last_name: admin.last_name,
        },
      },
    });
  } catch (error) {
    console.error('Error creando tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear tenant',
      error: error.message,
    });
  }
};

// Actualizar tenant
const updateTenant = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      company_name,
      business_name,
      tax_id,
      email,
      phone,
      address,
      logo_url,
      notes,
      plan, // ← AGREGAR
      max_users, // ← AGREGAR
      max_clients, // ← AGREGAR
      max_invoices_per_month, // ← AGREGAR
    } = req.body;

    const tenant = await Tenant.findByPk(id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    await tenant.update({
      company_name,
      business_name,
      tax_id,
      email,
      phone,
      address,
      logo_url,
      notes,
      plan, // ← AGREGAR
      max_users, // ← AGREGAR
      max_clients, // ← AGREGAR
      max_invoices_per_month, // ← AGREGAR
    });

    res.status(200).json({
      success: true,
      message: 'Tenant actualizado exitosamente',
      data: { tenant },
    });
  } catch (error) {
    console.error('Error actualizando tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar tenant',
      error: error.message,
    });
  }
};
// Activar/Desactivar tenant
const toggleTenantStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findByPk(id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    await tenant.update({
      is_active: !tenant.is_active,
    });

    res.status(200).json({
      success: true,
      message: `Tenant ${tenant.is_active ? 'activado' : 'desactivado'} exitosamente`,
      data: { tenant },
    });
  } catch (error) {
    console.error('Error cambiando estado del tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar estado del tenant',
      error: error.message,
    });
  }
};

// Eliminar tenant
const deleteTenant = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findByPk(id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    // Soft delete - solo desactivar
    await tenant.update({
      is_active: false,
      subscription_status: 'cancelled',
    });

    res.status(200).json({
      success: true,
      message: 'Tenant eliminado exitosamente',
    });
  } catch (error) {
    console.error('Error eliminando tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar tenant',
      error: error.message,
    });
  }
};

// Obtener usuarios de un tenant
const getTenantUsers = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const offset = (page - 1) * limit;

    const { count, rows: users } = await User.findAndCountAll({
      where: { tenant_id: tenantId },
      attributes: { exclude: ['password_hash'] },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });

    res.status(200).json({
      success: true,
      data: {
        users,
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count,
      },
    });
  } catch (error) {
    console.error('Error obteniendo usuarios del tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener usuarios',
      error: error.message,
    });
  }
};

// Actualizar suscripción
const updateSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      plan,
      subscription_status,
      max_users,
      max_clients,
      max_invoices_per_month,
    } = req.body;

    const tenant = await Tenant.findByPk(id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    const updateData = {};

    if (plan) {
      updateData.plan = plan;
    }
    if (subscription_status) {
      updateData.subscription_status = subscription_status;
    }
    if (max_users) {
      updateData.max_users = max_users;
    }
    if (max_clients) {
      updateData.max_clients = max_clients;
    }
    if (max_invoices_per_month) {
      updateData.max_invoices_per_month = max_invoices_per_month;
    }

    // Si se activa la suscripción, establecer fecha de inicio
    if (
      subscription_status === 'active' &&
      tenant.subscription_status !== 'active'
    ) {
      updateData.subscription_starts_at = new Date();
      updateData.next_billing_date = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );
    }

    await tenant.update(updateData);

    res.status(200).json({
      success: true,
      message: 'Suscripción actualizada exitosamente',
      data: { tenant },
    });
  } catch (error) {
    console.error('Error actualizando suscripción:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar suscripción',
      error: error.message,
    });
  }
};

// Analytics overview
const getAnalyticsOverview = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const dateFilter = {};
    if (start_date && end_date) {
      dateFilter.created_at = {
        [Op.between]: [new Date(start_date), new Date(end_date)],
      };
    }

    // Nuevos tenants por mes
    const tenantsByMonth = await Tenant.findAll({
      attributes: [
        [
          Tenant.sequelize.fn(
            'DATE_TRUNC',
            'month',
            Tenant.sequelize.col('created_at')
          ),
          'month',
        ],
        [Tenant.sequelize.fn('COUNT', Tenant.sequelize.col('id')), 'count'],
      ],
      where: dateFilter,
      group: [
        Tenant.sequelize.fn(
          'DATE_TRUNC',
          'month',
          Tenant.sequelize.col('created_at')
        ),
      ],
      order: [
        [
          Tenant.sequelize.fn(
            'DATE_TRUNC',
            'month',
            Tenant.sequelize.col('created_at')
          ),
          'ASC',
        ],
      ],
      raw: true,
    });

    // Ingresos por mes
    const revenueByMonth = await Payment.findAll({
      attributes: [
        [
          Payment.sequelize.fn(
            'DATE_TRUNC',
            'month',
            Payment.sequelize.col('payment_date')
          ),
          'month',
        ],
        [Payment.sequelize.fn('SUM', Payment.sequelize.col('amount')), 'total'],
      ],
      where: {
        status: 'completed',
        ...(start_date && end_date
          ? {
              payment_date: {
                [Op.between]: [new Date(start_date), new Date(end_date)],
              },
            }
          : {}),
      },
      group: [
        Payment.sequelize.fn(
          'DATE_TRUNC',
          'month',
          Payment.sequelize.col('payment_date')
        ),
      ],
      order: [
        [
          Payment.sequelize.fn(
            'DATE_TRUNC',
            'month',
            Payment.sequelize.col('payment_date')
          ),
          'ASC',
        ],
      ],
      raw: true,
    });

    res.status(200).json({
      success: true,
      data: {
        tenantsByMonth,
        revenueByMonth,
      },
    });
  } catch (error) {
    console.error('Error obteniendo analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener analytics',
      error: error.message,
    });
  }
};

// Analytics de tenants
const getTenantsAnalytics = async (req, res) => {
  try {
    // Top tenants por facturación
    const topTenants = await Tenant.findAll({
      attributes: [
        'id',
        'company_name',
        'plan',
        [
          Tenant.sequelize.literal(`(
            SELECT COALESCE(SUM(amount), 0)
            FROM payments
            WHERE payments.tenant_id = "Tenant"."id"
            AND payments.status = 'completed'
          )`),
          'total_revenue',
        ],
      ],
      order: [[Tenant.sequelize.literal('total_revenue'), 'DESC']],
      limit: 10,
      raw: true,
    });

    // Distribución de planes
    const planDistribution = await Tenant.findAll({
      attributes: [
        'plan',
        [Tenant.sequelize.fn('COUNT', Tenant.sequelize.col('id')), 'count'],
      ],
      group: ['plan'],
      raw: true,
    });

    // Tasa de conversión (trial -> active)
    const trialTenants = await Tenant.count({
      where: { subscription_status: 'trial' },
    });
    const activeTenants = await Tenant.count({
      where: { subscription_status: 'active' },
    });
    const conversionRate =
      trialTenants > 0
        ? ((activeTenants / (trialTenants + activeTenants)) * 100).toFixed(2)
        : 0;

    res.status(200).json({
      success: true,
      data: {
        topTenants,
        planDistribution,
        conversionRate,
      },
    });
  } catch (error) {
    console.error('Error obteniendo analytics de tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener analytics',
      error: error.message,
    });
  }
};

// Obtener usuarios de un tenant desde el panel de super admin
const getUsersFromTenant = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { page = 1, limit = 10, role, search, is_active } = req.query;

    const offset = (page - 1) * limit;

    // Verificar que el tenant existe
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    const where = {
      tenant_id: tenantId,
    };

    if (role) {
      where.role = role;
    }

    if (is_active !== undefined && is_active !== '') {
      where.is_active = is_active === 'true';
    }

    if (search) {
      where[Op.or] = [
        { first_name: { [Op.iLike]: `%${search}%` } },
        { last_name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows: users } = await User.findAndCountAll({
      where,
      attributes: { exclude: ['password_hash'] },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });

    res.status(200).json({
      success: true,
      data: {
        users,
        tenant: {
          id: tenant.id,
          company_name: tenant.company_name,
          plan: tenant.plan,
        },
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count,
      },
    });
  } catch (error) {
    console.error('Error obteniendo usuarios del tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener usuarios',
      error: error.message,
    });
  }
};

// ============================================
// GESTIÓN DE SUSCRIPCIONES
// ============================================

// Actualizar fecha de trial
const updateTrialDate = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { trial_ends_at } = req.body;

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    // Validar que la fecha sea futura
    const newTrialDate = new Date(trial_ends_at);
    const now = new Date();

    if (newTrialDate <= now) {
      return res.status(400).json({
        success: false,
        message: 'La fecha de trial debe ser futura',
      });
    }

    // Actualizar tenant
    await tenant.update({
      trial_ends_at: newTrialDate,
      subscription_status: 'trial',
    });

    res.status(200).json({
      success: true,
      message: 'Fecha de trial actualizada exitosamente',
      data: { tenant },
    });
  } catch (error) {
    console.error('Error actualizando fecha de trial:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar fecha de trial',
      error: error.message,
    });
  }
};

// Extender trial (agregar días)
const extendTrial = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { days } = req.body;

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    // Calcular nueva fecha
    const currentTrialEnd = tenant.trial_ends_at
      ? new Date(tenant.trial_ends_at)
      : new Date();

    const newTrialEnd = new Date(currentTrialEnd);
    newTrialEnd.setDate(newTrialEnd.getDate() + parseInt(days));

    // Actualizar tenant
    await tenant.update({
      trial_ends_at: newTrialEnd,
      subscription_status: 'trial',
    });

    res.status(200).json({
      success: true,
      message: `Trial extendido por ${days} días`,
      data: { tenant },
    });
  } catch (error) {
    console.error('Error extendiendo trial:', error);
    res.status(500).json({
      success: false,
      message: 'Error al extender trial',
      error: error.message,
    });
  }
};

// Cambiar estado de suscripción
const updateSubscriptionStatus = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { subscription_status, notes } = req.body;

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    const updates = {
      subscription_status,
    };

    // Si se activa la suscripción, establecer fecha de inicio
    if (subscription_status === 'active' && !tenant.subscription_starts_at) {
      updates.subscription_starts_at = new Date();

      // Calcular próxima fecha de facturación (30 días)
      const nextBilling = new Date();
      nextBilling.setDate(nextBilling.getDate() + 30);
      updates.next_billing_date = nextBilling;
    }

    // Si se suspende o cancela, agregar notas
    if (notes) {
      updates.notes = notes;
    }

    await tenant.update(updates);

    res.status(200).json({
      success: true,
      message: 'Estado de suscripción actualizado',
      data: { tenant },
    });
  } catch (error) {
    console.error('Error actualizando estado:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar estado',
      error: error.message,
    });
  }
};

// Obtener tenants con trial próximo a vencer
const getExpiringTrials = async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));

    const tenants = await Tenant.findAll({
      where: {
        subscription_status: 'trial',
        trial_ends_at: {
          [Op.between]: [now, futureDate],
        },
        is_active: true,
      },
      order: [['trial_ends_at', 'ASC']],
    });

    res.status(200).json({
      success: true,
      data: {
        tenants,
        count: tenants.length,
        days: parseInt(days),
      },
    });
  } catch (error) {
    console.error('Error obteniendo trials por vencer:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener trials',
      error: error.message,
    });
  }
};

// ============================================
// GESTIÓN DE USUARIOS (DESDE SUPER ADMIN)
// ============================================

// Actualizar usuario de un tenant
const updateTenantUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { first_name, last_name, email, phone, role, is_active } = req.body;

    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // No permitir editar super_admin
    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'No se puede editar un super admin',
      });
    }

    const updates = {};
    if (first_name) {
      updates.first_name = first_name;
    }
    if (last_name) {
      updates.last_name = last_name;
    }
    if (email) {
      updates.email = email;
    }
    if (phone !== undefined) {
      updates.phone = phone;
    }
    if (role) {
      updates.role = role;
    }
    if (is_active !== undefined) {
      updates.is_active = is_active;
    }

    await user.update(updates);

    res.status(200).json({
      success: true,
      message: 'Usuario actualizado exitosamente',
      data: { user },
    });
  } catch (error) {
    console.error('❌ [SUPERADMIN] Error actualizando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar usuario',
      error: error.message,
    });
  }
};

// Eliminar usuario de un tenant (soft delete)
const deleteTenantUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // No permitir eliminar super_admin
    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'No se puede eliminar un super admin',
      });
    }

    // Soft delete
    await user.update({ is_active: false });

    res.status(200).json({
      success: true,
      message: 'Usuario eliminado exitosamente',
    });
  } catch (error) {
    console.error('❌ [SUPERADMIN] Error eliminando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar usuario',
      error: error.message,
    });
  }
};

// Cambiar rol de usuario
const changeTenantUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'operario', 'cliente'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido',
      });
    }

    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // No permitir cambiar rol de super_admin
    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'No se puede cambiar el rol de un super admin',
      });
    }

    await user.update({ role });

    res.status(200).json({
      success: true,
      message: 'Rol actualizado exitosamente',
      data: { user },
    });
  } catch (error) {
    console.error('❌ [SUPERADMIN] Error cambiando rol:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar rol',
      error: error.message,
    });
  }
};

// Resetear contraseña de usuario
const resetTenantUserPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres',
      });
    }

    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // No permitir resetear contraseña de super_admin
    if (user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'No se puede resetear la contraseña de un super admin',
      });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    await user.update({ password_hash: hashedPassword });

    res.status(200).json({
      success: true,
      message: 'Contraseña reseteada exitosamente',
    });
  } catch (error) {
    console.error('❌ [SUPERADMIN] Error reseteando contraseña:', error);
    res.status(500).json({
      success: false,
      message: 'Error al resetear contraseña',
      error: error.message,
    });
  }
};

module.exports = {
  getDashboard,
  getAllTenants,
  getTenantById,
  createTenant,
  updateTenant,
  toggleTenantStatus,
  deleteTenant,
  getTenantUsers,
  updateSubscription,
  getAnalyticsOverview,
  getTenantsAnalytics,
  getUsersFromTenant,
  updateTrialDate,
  extendTrial,
  updateSubscriptionStatus,
  getExpiringTrials,
  updateTenantUser,
  deleteTenantUser,
  changeTenantUserRole,
  resetTenantUserPassword,
};
