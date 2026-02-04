/* eslint-disable indent */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');

const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Invoice = require('../models/billing/Invoice');
const TenantSubscription = require('../models/subscriptions/TenantSubscription');
const SubscriptionPlan = require('../models/subscriptions/SubscriptionPlan');
const SubscriptionInvoice = require('../models/subscriptions/SubscriptionInvoice');
const SuperAdminMercadoPagoConfig = require('../models/payments/SuperAdminMercadoPagoConfig');

// ============================================
// GESTIÓN DE TENANTS
// ============================================

// GET /tenants - Listar todos los tenants CON suscripciones
router.get(
  '/tenants',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 10,
        search = '',
        status = 'all',
        plan = '',
        subscription_status = '',
        is_active,
      } = req.query;

      const where = {};

      if (search) {
        where[Op.or] = [
          { company_name: { [Op.iLike]: `%${search}%` } },
          { email: { [Op.iLike]: `%${search}%` } },
        ];
      }

      // Soportar ambos formatos: status=active/inactive y is_active=true/false
      if (is_active !== undefined && is_active !== '') {
        where.is_active = is_active === 'true';
      } else if (status !== 'all') {
        where.is_active = status === 'active';
      }

      const offset = (page - 1) * limit;

      const { count, rows } = await Tenant.findAndCountAll({
        where,
        limit: parseInt(limit),
        offset,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: TenantSubscription,
            as: 'subscriptions',
            required: false,
            include: [
              {
                model: SubscriptionPlan,
                as: 'plan',
                attributes: ['id', 'name', 'slug'],
              },
            ],
            where: subscription_status ? { status: subscription_status } : {},
            limit: 1,
            order: [['created_at', 'DESC']],
          },
        ],
      });

      const tenantsFormatted = await Promise.all(
        rows.map(async (tenant) => {
          const subscription = tenant.subscriptions && tenant.subscriptions[0];
          const userCount = await User.count({
            where: { tenant_id: tenant.id },
          });

          return {
            id: tenant.id,
            company_name: tenant.company_name,
            slug: tenant.slug,
            email: tenant.email,
            phone: tenant.phone,
            address: tenant.address,
            business_name: tenant.business_name,
            tax_id: tenant.tax_id,
            is_active: tenant.is_active,
            created_at: tenant.created_at,
            updated_at: tenant.updated_at,
            plan: subscription?.plan?.slug || 'free',
            subscription_status: subscription?.status || 'trial',
            trial_ends_at: subscription?.trial_ends_at || null,
            next_billing_date: subscription?.next_billing_date || null,
            userCount,
            subscription: subscription || null,
          };
        })
      );

      const filteredTenants = plan
        ? tenantsFormatted.filter((t) => t.plan === plan)
        : tenantsFormatted;

      // ✅ CAMBIAR ESTRUCTURA DE RESPUESTA
      res.json({
        data: {
          tenants: filteredTenants,
          currentPage: parseInt(page),
          totalPages: Math.ceil(count / limit),
          totalItems: count,
        },
      });
    } catch (error) {
      console.error('Error fetching tenants:', error);
      res.status(500).json({ error: 'Error al obtener tenants' });
    }
  }
);

router.get(
  '/tenants/:id',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { id } = req.params;

      console.log('🔍 Buscando tenant con ID:', id);

      const tenant = await Tenant.findByPk(id, {
        include: [
          {
            model: TenantSubscription,
            as: 'subscriptions',
            required: false,
            include: [
              {
                model: SubscriptionPlan,
                as: 'plan',
              },
            ],
            limit: 1,
            order: [['created_at', 'DESC']],
          },
        ],
      });

      if (!tenant) {
        console.log('❌ Tenant no encontrado para ID:', id);
        return res.status(404).json({
          error: 'Tenant no encontrado',
          id: id,
        });
      }

      console.log('✅ Tenant encontrado:', tenant.company_name);

      // Obtener estadísticas
      const totalUsers = await User.count({ 
        where: { 
          tenant_id: id,
          role: { [Op.ne]: 'super_admin' }  // ← Excluir super_admin del conteo
        } 
      });
      const totalInvoices = await Invoice.count({ where: { tenant_id: id } });

      const subscription = tenant.subscriptions && tenant.subscriptions[0];

      console.log(
        '📊 Suscripción:',
        subscription ? subscription.status : 'No tiene'
      );

      // Formatear respuesta
      const response = {
        tenant: {
          id: tenant.id,
          company_name: tenant.company_name,
          slug: tenant.slug,
          email: tenant.email,
          phone: tenant.phone,
          address: tenant.address,
          business_name: tenant.business_name,
          tax_id: tenant.tax_id,
          is_active: tenant.is_active,
          created_at: tenant.created_at,
          updated_at: tenant.updated_at,

          // Datos de suscripción
          plan: subscription?.plan?.slug || 'free',
          subscription_status: subscription?.status || 'trial',
          trial_ends_at: subscription?.trial_ends_at || null,
          next_billing_date: subscription?.next_billing_date || null,

          // Límites del plan
          max_users: subscription?.plan?.max_users || 3,
          max_clients: subscription?.plan?.max_clients || 50,
          max_invoices_per_month:
            subscription?.plan?.max_invoices_per_month || 100,

          // Suscripción completa
          subscription: subscription || null,
        },
        stats: {
          totalUsers,
          totalInvoices,
        },
      };

      console.log('📤 Enviando respuesta:', JSON.stringify(response, null, 2));

      res.json(response);
    } catch (error) {
      console.error('❌ Error fetching tenant:', error);
      res.status(500).json({
        error: 'Error al obtener tenant',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  }
);

// POST /tenants - Crear tenant CON suscripción
router.post(
  '/tenants',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    const transaction = await Tenant.sequelize.transaction();

    try {
      // 1. Crear tenant
      const tenant = await Tenant.create(
        {
          company_name: req.body.company_name,
          slug: req.body.slug,
          business_name: req.body.business_name,
          tax_id: req.body.tax_id,
          email: req.body.email,
          phone: req.body.phone,
          address: req.body.address,
          is_active: true,
        },
        { transaction }
      );

      // 2. Obtener plan
      const plan = await SubscriptionPlan.findOne({
        where: { slug: req.body.plan || 'free' },
      });

      if (!plan) {
        throw new Error('Plan no encontrado');
      }

      // 3. Crear suscripción
      const trialDays = 14;
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

      await TenantSubscription.create(
        {
          tenant_id: tenant.id,
          plan_id: plan.id,
          status: 'trial',
          billing_cycle: 'monthly',
          amount: plan.monthly_price,
          currency: 'COP',
          starts_at: new Date(),
          trial_ends_at: trialEndsAt,
          current_period_start: new Date(),
          current_period_end: trialEndsAt,
          next_billing_date: trialEndsAt,
          auto_renew: true,
        },
        { transaction }
      );

      // 4. Crear admin
      if (req.body.admin_email && req.body.admin_password) {
        const hashedPassword = await bcrypt.hash(req.body.admin_password, 10);

        await User.create(
          {
            tenant_id: tenant.id,
            email: req.body.admin_email,
            password_hash: hashedPassword,
            role: 'admin',
            first_name: req.body.admin_first_name,
            last_name: req.body.admin_last_name,
            is_active: true,
            email_verified: true,
          },
          { transaction }
        );
      }

      await transaction.commit();
      res.status(201).json({ tenant });
    } catch (error) {
      await transaction.rollback();
      console.error('Error creating tenant:', error);
      res
        .status(500)
        .json({ error: 'Error al crear tenant', details: error.message });
    }
  }
);

// PUT /tenants/:id - Actualizar tenant Y suscripción
router.put(
  '/tenants/:id',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const tenant = await Tenant.findByPk(id);

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant no encontrado' });
      }

      await tenant.update({
        company_name: req.body.company_name,
        business_name: req.body.business_name,
        tax_id: req.body.tax_id,
        email: req.body.email,
        phone: req.body.phone,
        address: req.body.address,
      });

      if (req.body.plan) {
        const plan = await SubscriptionPlan.findOne({
          where: { slug: req.body.plan },
        });

        if (plan) {
          const subscription = await TenantSubscription.findOne({
            where: { tenant_id: id },
            order: [['created_at', 'DESC']],
          });

          if (subscription) {
            await subscription.update({
              plan_id: plan.id,
              amount:
                subscription.billing_cycle === 'monthly'
                  ? plan.monthly_price
                  : plan.yearly_price,
            });
          }
        }
      }

      res.json({ tenant });
    } catch (error) {
      console.error('Error updating tenant:', error);
      res.status(500).json({ error: 'Error al actualizar tenant' });
    }
  }
);

// POST /tenants/:id/toggle-status
router.post(
  '/tenants/:id/toggle-status',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant no encontrado' });
      }
      await tenant.update({ is_active: !tenant.is_active });
      res.json({ tenant });
    } catch (error) {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  }
);

// GET /tenants/:id/users
router.get(
  '/tenants/:tenantId/users',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { page = 1, limit = 10, search = '', role = '' } = req.query;

      const where = {
        tenant_id: tenantId,
      };

      // Si se pasa filtro de role, usar ese valor exacto (siempre excluyendo super_admin)
      if (role && role !== 'super_admin') {
        where.role = role;
      } else {
        where.role = { [Op.ne]: 'super_admin' };
      }

      if (search) {
        where[Op.or] = [
          { first_name: { [Op.iLike]: `%${search}%` } },
          { last_name: { [Op.iLike]: `%${search}%` } },
          { email: { [Op.iLike]: `%${search}%` } }
        ];
      }

      const offset = (page - 1) * limit;

      const { count, rows } = await User.findAndCountAll({
        where,
        limit: parseInt(limit),
        offset,
        order: [['created_at', 'DESC']],
        attributes: { exclude: ['password_hash'] }
      });

      // Obtener info del tenant para mostrar en el frontend
      const tenant = await Tenant.findByPk(tenantId, {
        attributes: ['id', 'company_name', 'plan']
      });

      res.json({
        users: rows,
        tenant: tenant || null,
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count
      });
    } catch (error) {
      console.error('Error fetching tenant users:', error);
      res.status(500).json({ error: 'Error al obtener usuarios' });
    }
  }
);

// ============================================
// GESTIÓN DE PLANES DE SUSCRIPCIÓN
// ============================================

// GET /subscription-plans - Listar todos los planes
router.get(
  '/subscription-plans',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const plans = await SubscriptionPlan.findAll({
        order: [['sort_order', 'ASC'], ['created_at', 'ASC']],
      });
      res.json({ plans });
    } catch (error) {
      console.error('Error fetching plans:', error);
      res.status(500).json({ error: 'Error al obtener planes' });
    }
  }
);

// POST /subscription-plans - Crear un nuevo plan
router.post(
  '/subscription-plans',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const plan = await SubscriptionPlan.create({
        name: req.body.name,
        slug: req.body.slug,
        description: req.body.description || null,
        monthly_price: req.body.monthly_price,
        yearly_price: req.body.yearly_price || null,
        max_users: req.body.max_users || 3,
        max_clients: req.body.max_clients || 50,
        max_invoices_per_month: req.body.max_invoices_per_month || 100,
        max_storage_mb: req.body.max_storage_mb || 100,
        features: req.body.features || {},
        is_active: req.body.is_active !== undefined ? req.body.is_active : true,
        is_popular: req.body.is_popular || false,
        sort_order: req.body.sort_order || 0,
        trial_days: req.body.trial_days || 14,
      });
      res.status(201).json({ plan });
    } catch (error) {
      console.error('Error creating plan:', error);
      res.status(500).json({ error: 'Error al crear plan', details: error.message });
    }
  }
);

// PUT /subscription-plans/:id - Actualizar un plan
router.put(
  '/subscription-plans/:id',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const plan = await SubscriptionPlan.findByPk(req.params.id);
      if (!plan) {
        return res.status(404).json({ error: 'Plan no encontrado' });
      }

      await plan.update({
        name: req.body.name !== undefined ? req.body.name : plan.name,
        slug: req.body.slug !== undefined ? req.body.slug : plan.slug,
        description: req.body.description !== undefined ? req.body.description : plan.description,
        monthly_price: req.body.monthly_price !== undefined ? req.body.monthly_price : plan.monthly_price,
        yearly_price: req.body.yearly_price !== undefined ? req.body.yearly_price : plan.yearly_price,
        max_users: req.body.max_users !== undefined ? req.body.max_users : plan.max_users,
        max_clients: req.body.max_clients !== undefined ? req.body.max_clients : plan.max_clients,
        max_invoices_per_month: req.body.max_invoices_per_month !== undefined ? req.body.max_invoices_per_month : plan.max_invoices_per_month,
        features: req.body.features !== undefined ? req.body.features : plan.features,
        is_active: req.body.is_active !== undefined ? req.body.is_active : plan.is_active,
        is_popular: req.body.is_popular !== undefined ? req.body.is_popular : plan.is_popular,
        sort_order: req.body.sort_order !== undefined ? req.body.sort_order : plan.sort_order,
      });

      res.json({ plan });
    } catch (error) {
      console.error('Error updating plan:', error);
      res.status(500).json({ error: 'Error al actualizar plan' });
    }
  }
);

// DELETE /subscription-plans/:id - Eliminar un plan
router.delete(
  '/subscription-plans/:id',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const plan = await SubscriptionPlan.findByPk(req.params.id);
      if (!plan) {
        return res.status(404).json({ error: 'Plan no encontrado' });
      }

      const activeSubscriptions = await TenantSubscription.count({
        where: { plan_id: req.params.id, status: { [Op.in]: ['active', 'trial'] } },
      });

      if (activeSubscriptions > 0) {
        return res.status(400).json({
          error: 'No se puede eliminar un plan con suscripciones activas',
        });
      }

      await plan.destroy();
      res.json({ message: 'Plan eliminado correctamente' });
    } catch (error) {
      console.error('Error deleting plan:', error);
      res.status(500).json({ error: 'Error al eliminar plan' });
    }
  }
);

// PATCH /subscription-plans/:id/toggle - Togglear estado activo
router.patch(
  '/subscription-plans/:id/toggle',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const plan = await SubscriptionPlan.findByPk(req.params.id);
      if (!plan) {
        return res.status(404).json({ error: 'Plan no encontrado' });
      }

      await plan.update({ is_active: !plan.is_active });
      res.json({ plan });
    } catch (error) {
      console.error('Error toggling plan:', error);
      res.status(500).json({ error: 'Error al cambiar estado del plan' });
    }
  }
);

// ============================================
// GESTIÓN DE SUSCRIPCIONES
// ============================================

router.get(
  '/all-subscriptions',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const subscriptions = await TenantSubscription.findAll({
        include: [
          {
            model: SubscriptionPlan,
            as: 'plan',
            attributes: ['id', 'name', 'slug', 'monthly_price', 'yearly_price'],
          },
          {
            model: Tenant,
            as: 'tenant',
            attributes: ['id', 'company_name', 'email'],
          },
        ],
        order: [['created_at', 'DESC']],
      });
      res.json({ subscriptions });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({
        error: 'Error al obtener suscripciones',
        details: error.message,
      });
    }
  }
);

router.get(
  '/tenants/:tenantId/subscription-detail',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
        include: [{ model: SubscriptionPlan, as: 'plan' }],
      });
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener suscripción' });
    }
  }
);

router.put(
  '/tenants/:tenantId/change-plan',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
      });
      if (!subscription) {
        return res.status(404).json({ error: 'Suscripción no encontrada' });
      }

      const plan = await SubscriptionPlan.findByPk(req.body.plan_id);
      if (!plan) {
        return res.status(404).json({ error: 'Plan no encontrado' });
      }

      await subscription.update({
        plan_id: req.body.plan_id,
        amount:
          subscription.billing_cycle === 'monthly'
            ? plan.monthly_price
            : plan.yearly_price,
      });
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error al cambiar plan' });
    }
  }
);

router.put(
  '/tenants/:tenantId/change-subscription-status',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
      });
      if (!subscription) {
        return res.status(404).json({ error: 'Suscripción no encontrada' });
      }
      await subscription.update({ status: req.body.status });
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  }
);

router.post(
  '/tenants/:tenantId/extend-trial',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
      });
      if (!subscription) {
        return res.status(404).json({ error: 'Suscripción no encontrada' });
      }

      const currentTrialEnd = subscription.trial_ends_at
        ? new Date(subscription.trial_ends_at)
        : new Date();
      const newTrialEnd = new Date(
        currentTrialEnd.getTime() + req.body.days * 24 * 60 * 60 * 1000
      );

      await subscription.update({
        trial_ends_at: newTrialEnd,
        next_billing_date: newTrialEnd,
        current_period_end: newTrialEnd,
      });
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error al extender trial' });
    }
  }
);

router.put(
  '/tenants/:tenantId/set-trial-date',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
      });
      if (!subscription) {
        return res.status(404).json({ error: 'Suscripción no encontrada' });
      }

      await subscription.update({
        trial_ends_at: req.body.trial_ends_at,
        next_billing_date: req.body.trial_ends_at,
        current_period_end: req.body.trial_ends_at,
      });
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error al establecer fecha' });
    }
  }
);

// ============================================
// DASHBOARD
// ============================================

router.get(
  '/dashboard',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const totalTenants = await Tenant.count();
      const activeTenants = await Tenant.count({ where: { is_active: true } });
      const trialTenants = await TenantSubscription.count({
        where: { status: 'trial' },
      });

      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const newTenantsThisMonth = await Tenant.count({
        where: { created_at: { [Op.gte]: startOfMonth } },
      });

      const totalUsers = await User.count();

      const activeSubscriptions = await TenantSubscription.findAll({
        where: { status: { [Op.in]: ['active', 'trial'] } },
        attributes: ['amount', 'billing_cycle'],
      });

      const mrr = activeSubscriptions
        .filter((s) => s.billing_cycle === 'monthly')
        .reduce((sum, s) => sum + (s.amount || 0), 0);

      const arr = mrr * 12;

      const tenantsByPlan = await TenantSubscription.findAll({
        attributes: [
          [
            TenantSubscription.sequelize.fn(
              'COUNT',
              TenantSubscription.sequelize.col('tenant_id')
            ),
            'count',
          ],
        ],
        include: [
          {
            model: SubscriptionPlan,
            as: 'plan',
            attributes: ['slug'],
          },
        ],
        group: ['plan.id', 'plan.slug'],
        raw: true,
      });

      const formattedPlanData = tenantsByPlan.map((item) => ({
        plan: item['plan.slug'] || 'unknown',
        count: parseInt(item.count) || 0,
      }));

      const recentTenants = await Tenant.findAll({
        limit: 5,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: TenantSubscription,
            as: 'subscriptions',
            include: [{ model: SubscriptionPlan, as: 'plan' }],
            limit: 1,
            order: [['created_at', 'DESC']],
          },
        ],
      });

      const formattedRecentTenants = recentTenants.map((t) => {
        const sub = t.subscriptions?.[0];
        return {
          id: t.id,
          company_name: t.company_name,
          plan: sub?.plan?.slug || 'free',
          subscription_status: sub?.status || 'trial',
          created_at: t.created_at,
        };
      });

      const sevenDaysFromNow = new Date();
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

      const trialEndingSoon = await TenantSubscription.findAll({
        where: {
          status: 'trial',
          trial_ends_at: {
            [Op.lte]: sevenDaysFromNow,
            [Op.gte]: new Date(),
          },
        },
        include: [
          {
            model: Tenant,
            as: 'tenant',
            attributes: ['id', 'company_name'],
          },
        ],
      });

      // ✅ ESTRUCTURA CORRECTA
      res.json({
        data: {
          overview: {
            totalTenants,
            activeTenants,
            trialTenants,
            newTenantsThisMonth,
            totalUsers,
            mrr,
            arr,
            growth: 0,
          },
          tenantsByPlan: formattedPlanData,
          recentTenants: formattedRecentTenants,
          trialEndingSoon: trialEndingSoon.map((t) => ({
            id: t.tenant?.id,
            company_name: t.tenant?.company_name,
            trial_ends_at: t.trial_ends_at,
          })),
          revenue: {
            byPlan: {},
          },
        },
      });
    } catch (error) {
      console.error('Error fetching dashboard:', error);
      res.status(500).json({ error: 'Error al cargar dashboard' });
    }
  }
);

// ============================================
// ANALYTICS
// ============================================

router.get(
  '/analytics/overview',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { start_date, end_date } = req.query;

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
        where:
          start_date && end_date
            ? {
                created_at: {
                  [Op.between]: [new Date(start_date), new Date(end_date)],
                },
              }
            : {},
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

      const revenueByMonth = tenantsByMonth.map((item) => ({
        month: item.month,
        total: parseInt(item.count) * 50000,
      }));

      // ✅ ESTRUCTURA CORRECTA
      res.json({
        data: {
          tenantsByMonth: tenantsByMonth.map((item) => ({
            month: item.month,
            count: item.count,
          })),
          revenueByMonth,
        },
      });
    } catch (error) {
      console.error('Error fetching analytics overview:', error);
      res.status(500).json({ error: 'Error al cargar analytics' });
    }
  }
);

router.get(
  '/analytics/tenants',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const planDistribution = await TenantSubscription.findAll({
        attributes: [
          [
            TenantSubscription.sequelize.fn(
              'COUNT',
              TenantSubscription.sequelize.col('tenant_id')
            ),
            'count',
          ],
        ],
        include: [
          {
            model: SubscriptionPlan,
            as: 'plan',
            attributes: ['slug'],
          },
        ],
        group: ['plan.id', 'plan.slug'],
        raw: true,
      });

      const topTenants = await Tenant.findAll({
        limit: 10,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: TenantSubscription,
            as: 'subscriptions',
            include: [{ model: SubscriptionPlan, as: 'plan' }],
            limit: 1,
            order: [['created_at', 'DESC']],
          },
        ],
      });

      // ✅ ESTRUCTURA CORRECTA
      res.json({
        data: {
          planDistribution: planDistribution.map((item) => ({
            plan: item['plan.slug'] || 'unknown',
            count: item.count,
          })),
          topTenants: topTenants.map((t) => {
            const sub = t.subscriptions?.[0];
            return {
              id: t.id,
              company_name: t.company_name,
              plan: sub?.plan?.slug || 'free',
              total_revenue: (sub?.amount || 0) * 12,
            };
          }),
          conversionRate: 0,
        },
      });
    } catch (error) {
      console.error('Error fetching tenants analytics:', error);
      res.status(500).json({ error: 'Error al cargar analytics de tenants' });
    }
  }
);

router.get(
  '/trials-expiring',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { days = 7 } = req.query;
      const daysFromNow = new Date();
      daysFromNow.setDate(daysFromNow.getDate() + parseInt(days));

      const tenants = await TenantSubscription.findAll({
        where: {
          status: 'trial',
          trial_ends_at: {
            [Op.lte]: daysFromNow,
            [Op.gte]: new Date(),
          },
        },
        include: [
          {
            model: Tenant,
            as: 'tenant',
            attributes: ['id', 'company_name'],
          },
        ],
      });

      // ✅ ESTRUCTURA CORRECTA
      res.json({
        data: {
          tenants: tenants.map((t) => ({
            id: t.tenant?.id,
            company_name: t.tenant?.company_name,
            trial_ends_at: t.trial_ends_at,
          })),
        },
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Error al obtener trials' });
    }
  }
);

// ============================================
// FACTURAS DE SUSCRIPCIONES
// ============================================

router.get(
  '/subscription-invoices',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const invoices = await SubscriptionInvoice.findAll({
        include: [
          {
            model: Tenant,
            as: 'tenant',
            attributes: ['id', 'company_name'],
          },
          {
            model: SubscriptionPlan,
            as: 'plan',
            attributes: ['id', 'name', 'slug'],
          },
        ],
        order: [['created_at', 'DESC']],
      });

      res.json({
        invoices: invoices.map((inv) => ({
          id: inv.id,
          invoice_number: inv.invoice_number,
          tenant: inv.tenant,
          plan: inv.plan,
          amount: inv.amount,
          status: inv.status,
          due_date: inv.due_date,
          paid_at: inv.paid_at,
          created_at: inv.created_at,
        })),
      });
    } catch (error) {
      console.error('Error fetching subscription invoices:', error);
      res.status(500).json({ error: 'Error al obtener facturas' });
    }
  }
);

// ============================================
// TRIALS EXPIRANDO (ruta alternativa)
// ============================================

router.get(
  '/trials/expiring',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { days = 7 } = req.query;
      const daysFromNow = new Date();
      daysFromNow.setDate(daysFromNow.getDate() + parseInt(days));

      const tenants = await TenantSubscription.findAll({
        where: {
          status: 'trial',
          trial_ends_at: {
            [Op.lte]: daysFromNow,
            [Op.gte]: new Date(),
          },
        },
        include: [
          {
            model: Tenant,
            as: 'tenant',
            attributes: ['id', 'company_name'],
          },
        ],
      });

      res.json({
        data: {
          tenants: tenants.map((t) => ({
            id: t.tenant?.id,
            company_name: t.tenant?.company_name,
            trial_ends_at: t.trial_ends_at,
          })),
        },
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Error al obtener trials' });
    }
  }
);

// ============================================
// CONFIGURACIÓN DE MERCADOPAGO POR TENANT (SUPERADMIN)
// ============================================
// Agregar estos endpoints a backend/src/routes/superadmin.routes.js

/**
 * GET /api/v1/superadmin/tenants/:tenantId/mercadopago-config
 * Obtener configuración de MercadoPago de un tenant específico
 */
router.get(
  '/tenants/:tenantId/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const { tenantId } = req.params;

      const TenantMercadoPagoConfig = require('../models/TenantMercadoPagoConfig');

      const config = await TenantMercadoPagoConfig.findOne({
        where: { tenant_id: tenantId },
      });

      res.json({
        success: true,
        config: config || null,
      });
    } catch (error) {
      console.error('Error fetching MercadoPago config:', error);
      res.status(500).json({ error: 'Error al obtener configuración' });
    }
  }
);

/**
 * POST /api/v1/superadmin/tenants/:tenantId/mercadopago-config
 * Guardar/Actualizar configuración de MercadoPago de un tenant
 */
router.post(
  '/tenants/:tenantId/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { access_token, public_key } = req.body;

      // Validar datos
      if (!access_token || !public_key) {
        return res.status(400).json({ error: 'Faltan datos requeridos' });
      }

      const TenantMercadoPagoConfig = require('../models/TenantMercadoPagoConfig');

      // Buscar configuración existente
      let config = await TenantMercadoPagoConfig.findOne({
        where: { tenant_id: tenantId },
      });

      if (config) {
        // Actualizar existente
        await config.update({
          access_token,
          public_key,
        });
      } else {
        // Crear nueva
        config = await TenantMercadoPagoConfig.create({
          tenant_id: tenantId,
          access_token,
          public_key,
        });
      }

      res.json({
        success: true,
        message: 'Configuración guardada correctamente',
        config,
      });
    } catch (error) {
      console.error('Error saving MercadoPago config:', error);
      res.status(500).json({
        error: 'Error al guardar configuración',
        details: error.message,
      });
    }
  }
);

/**
 * DELETE /api/v1/superadmin/tenants/:tenantId/mercadopago-config
 * Eliminar configuración de MercadoPago de un tenant
 */
router.delete(
  '/tenants/:tenantId/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { tenantId } = req.params;

      const TenantMercadoPagoConfig = require('../models/TenantMercadoPagoConfig');

      const deleted = await TenantMercadoPagoConfig.destroy({
        where: { tenant_id: tenantId },
      });

      if (deleted === 0) {
        return res.status(404).json({ error: 'Configuración no encontrada' });
      }

      res.json({
        success: true,
        message: 'Configuración eliminada correctamente',
      });
    } catch (error) {
      console.error('Error deleting MercadoPago config:', error);
      res.status(500).json({ error: 'Error al eliminar configuración' });
    }
  }
);

router.get(
  '/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      // Solo hay UN registro para todo el sistema
      let config = await SuperAdminMercadoPagoConfig.findOne();

      if (!config) {
        // Crear registro si no existe
        config = await SuperAdminMercadoPagoConfig.create({
          id: '00000000-0000-0000-0000-000000000001',
        });
      }

      res.json({
        success: true,
        config: {
          id: config.id,
          public_key: config.public_key || null,
          test_mode: config.test_mode,
          has_access_token: !!config.access_token, // Solo indicar si existe
          created_at: config.created_at,
          updated_at: config.updated_at,
        },
      });
    } catch (error) {
      console.error('Error fetching config:', error);
      res.status(500).json({ error: 'Error al obtener configuración' });
    }
  }
);

/**
 * POST /api/v1/superadmin/mercadopago-config
 * Guardar/Actualizar configuración de MercadoPago del SuperAdmin
 */
router.post(
  '/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { access_token, public_key, test_mode } = req.body;

      // Validar datos
      if (!access_token || !public_key) {
        return res
          .status(400)
          .json({ error: 'Access token y public key son requeridos' });
      }

      // Buscar o crear configuración (solo hay una)
      let config = await SuperAdminMercadoPagoConfig.findOne();

      if (config) {
        // Actualizar existente
        await config.update({
          access_token,
          public_key,
          test_mode: test_mode !== undefined ? test_mode : config.test_mode,
        });
      } else {
        // Crear nueva
        config = await SuperAdminMercadoPagoConfig.create({
          id: '00000000-0000-0000-0000-000000000001',
          access_token,
          public_key,
          test_mode: test_mode !== undefined ? test_mode : true,
        });
      }

      res.json({
        success: true,
        message: 'Configuración guardada correctamente',
        config: {
          id: config.id,
          public_key: config.public_key,
          test_mode: config.test_mode,
          has_access_token: true,
        },
      });
    } catch (error) {
      console.error('Error saving config:', error);
      res.status(500).json({
        error: 'Error al guardar configuración',
        details: error.message,
      });
    }
  }
);

/**
 * DELETE /api/v1/superadmin/mercadopago-config
 * Eliminar configuración de MercadoPago del SuperAdmin
 */
router.delete(
  '/mercadopago-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const config = await SuperAdminMercadoPagoConfig.findOne();

      if (!config) {
        return res.status(404).json({ error: 'Configuración no encontrada' });
      }

      // Solo limpiar los datos, no eliminar el registro
      await config.update({
        access_token: null,
        public_key: null,
        webhook_secret: null,
      });

      res.json({
        success: true,
        message: 'Configuración eliminada correctamente',
      });
    } catch (error) {
      console.error('Error deleting config:', error);
      res.status(500).json({ error: 'Error al eliminar configuración' });
    }
  }
);

// ============================================
// GESTIÓN DE USUARIOS DE TENANTS
// ============================================

/**
 * POST /api/v1/superadmin/tenants/:tenantId/users
 * Crear un nuevo usuario para un tenant específico
 */
router.post(
  '/tenants/:tenantId/users',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { tenantId } = req.params;
      const {
        email,
        password,
        first_name,
        last_name,
        role,
        identification_type,
        identification_number,
        phone,
        address,
      } = req.body;

      // Validar datos requeridos
      if (!email || !password || !first_name || !last_name || !role) {
        return res.status(400).json({
          error: 'Faltan campos requeridos',
          required: ['email', 'password', 'first_name', 'last_name', 'role'],
        });
      }

      // Verificar que el tenant existe
      const tenant = await Tenant.findByPk(tenantId);
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant no encontrado' });
      }

      // Verificar si el email ya existe en el tenant
      const existingUser = await User.findOne({
        where: {
          email,
          tenant_id: tenantId,
        },
      });

      if (existingUser) {
        return res.status(400).json({
          error: 'El email ya está registrado en este tenant',
        });
      }

      // Hash de la contraseña
      const hashedPassword = await bcrypt.hash(password, 10);

      // Crear el usuario
      const user = await User.create({
        email,
        password_hash: hashedPassword,
        first_name,
        last_name,
        role,
        identification_type,
        identification_number,
        phone,
        address,
        tenant_id: tenantId,
        is_active: true,
        created_by: req.user.id,
      });

      // No devolver el hash de la contraseña
      const userResponse = user.toJSON();
      delete userResponse.password_hash;

      res.status(201).json({
        success: true,
        message: 'Usuario creado exitosamente',
        user: userResponse,
      });
    } catch (error) {
      console.error('Error creating tenant user:', error);
      res.status(500).json({
        error: 'Error al crear usuario',
        details: error.message,
      });
    }
  }
);

// ============================================
// GESTIÓN DE PERMISOS DE ROLES
// ============================================

const permissionsController = require('../controllers/permissions.controller');

// GET /permissions/role/:role - Obtener permisos de un rol
router.get(
  '/permissions/role/:role',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  permissionsController.getRolePermissions
);

// PUT /permissions/role/:role - Actualizar permisos de un rol
router.put(
  '/permissions/role/:role',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  permissionsController.updateRolePermissions
);

module.exports = router;