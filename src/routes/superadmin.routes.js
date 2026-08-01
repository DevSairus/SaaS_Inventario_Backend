/* eslint-disable indent */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const { denyImpersonation } = require('../middleware/denyImpersonation');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const audit = require('../utils/audit');
const { cutoverTenant } = require('../scripts/cutoverTenant');
const { rollbackTenant } = require('../scripts/rollbackTenant');
const { cleanupTenantPublicData } = require('../scripts/cleanupTenantPublicData');

const JWT_SECRET = process.env.JWT_SECRET;
const IMPERSONATION_EXPIRES_IN = process.env.IMPERSONATION_EXPIRES_IN || '2h';

// Ninguna ruta de este router es alcanzable desde una sesión impersonada,
// aunque el rol impersonado tuviera por error un permiso superadmin.*
// asignado en RolePermission — ver backend/src/middleware/denyImpersonation.js.
// Cada ruta abajo sigue trayendo su propio authMiddleware (redundante pero
// inofensivo: solo re-decodifica el mismo token).
router.use(authMiddleware, denyImpersonation);

const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Invoice = require('../models/billing/Invoice');
const TenantSubscription = require('../models/subscriptions/TenantSubscription');
const SubscriptionPlan = require('../models/subscriptions/SubscriptionPlan');
const SubscriptionInvoice = require('../models/subscriptions/SubscriptionInvoice');
const SuperAdminMercadoPagoConfig = require('../models/payments/SuperAdminMercadoPagoConfig');
const { MODULES_CATALOG } = require('../config/modules.catalog');
const { invalidateModulesCache, invalidateAllModulesCache, getEffectiveModulesForTenantId } = require('../services/moduleAccess');

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

// IMPORTANTE: esta ruta va ANTES de GET /tenants/:id -- si no, Express
// matchea "migration-status" contra ese :id primero (mismo método, mismo
// número de segmentos, registrado antes) y esta nunca se alcanza.
// GET /tenants/migration-status -- listado de tenants con su estado de
// corte (schema_name o "legado") y el resultado del último intento de
// cutover, para no depender de acceso a consola en producción.
router.get(
  '/tenants/migration-status',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const tenants = await Tenant.findAll({
        attributes: [
          'id', 'slug', 'business_name', 'schema_name',
          'cutover_last_attempt_at', 'cutover_last_status', 'cutover_last_error',
        ],
        order: [['business_name', 'ASC']],
      });

      res.json({
        tenants: tenants.map((t) => ({
          id: t.id,
          slug: t.slug,
          business_name: t.business_name,
          status: t.schema_name ? 'migrado' : 'legado',
          schema_name: t.schema_name,
          cutover_last_attempt_at: t.cutover_last_attempt_at,
          cutover_last_status: t.cutover_last_status,
          cutover_last_error: t.cutover_last_error,
        })),
      });
    } catch (error) {
      console.error('Error obteniendo estado de migración de tenants:', error);
      res.status(500).json({ error: 'Error al obtener el estado de migración', details: error.message });
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
          {
            model: SubscriptionPlan,
            as: 'subscriptionPlan',
            required: false,
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
      const Branch = require('../models/Branch');
      const totalBranches = await Branch.count({ where: { tenant_id: id, is_active: true } });

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
          max_branches: subscription?.plan?.max_branches ?? 1,
          allow_extra_branches: subscription?.plan?.allow_extra_branches || false,
          extra_branch_price: subscription?.plan?.extra_branch_price || 0,

          // Suscripción completa
          subscription: subscription || null,

          // Plan efectivo (fuente de verdad de módulos, independiente de la suscripción)
          plan_id: tenant.plan_id,
          subscription_plan: tenant.subscriptionPlan || null,
          modules_enabled: tenant.modules_enabled || [],
          modules_disabled: tenant.modules_disabled || [],
          effective_modules: await getEffectiveModulesForTenantId(tenant.id),
        },
        stats: {
          totalUsers,
          totalInvoices,
          totalBranches,
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

// POST /run-migrations
// Ejecuta manualmente las migraciones pendientes y ESPERA a que terminen
// antes de responder. Existe porque en Vercel (serverless) el auto-run de
// migraciones al boot (server.js) es un `.then()` sin await sobre
// `module.exports = app` — el runtime puede congelar la función en cuanto
// se responde la petición que disparó el cold start, cortando a la mitad
// cualquier migración que tarde (ej. backfills que iteran todos los
// tenants). Este endpoint ata la ejecución al ciclo de vida del request
// HTTP: Vercel no congela la función hasta que se envía la respuesta, así
// que awaitear aquí garantiza que si el proceso responde, la migración
// terminó (o falló con el error visible, no en silencio).
router.post(
  '/run-migrations',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { runMigrations } = require('../database/migrator');
      const executed = await runMigrations();
      res.json({
        success: true,
        message: executed.length > 0
          ? `${executed.length} migración(es) ejecutada(s)`
          : 'No había migraciones pendientes',
        executed: executed.map((m) => m.name),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Error ejecutando migraciones',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
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
      // 2. Obtener plan (por plan_id si viene del nuevo selector, o por slug legacy)
      const plan = req.body.plan_id
        ? await SubscriptionPlan.findByPk(req.body.plan_id)
        : await SubscriptionPlan.findOne({ where: { slug: req.body.plan || 'free' } });

      if (!plan) {
        throw new Error('Plan no encontrado');
      }

      // 1. Crear tenant (plan_id directo — fuente de verdad de módulos/límites)
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
          plan_id: plan.id,
          modules_enabled: req.body.modules_enabled || [],
          modules_disabled: req.body.modules_disabled || [],
        },
        { transaction }
      );

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

      // 3b. Plan de cuentas PUC estándar + mapeos contables por defecto
      const { seedChartOfAccountsForTenant } = require('../services/accounting/accountingSeed.service');
      await seedChartOfAccountsForTenant(tenant.id, transaction);

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

      // Aprovisiona el schema dedicado (schema-per-tenant) en background --
      // no bloquea la respuesta del alta, que ya se envió arriba. Un tenant
      // recién creado no tiene filas propias en las tablas compartidas, así
      // que el paso de copia de datos es prácticamente instantáneo. Si esto
      // falla, el tenant queda funcionando en el modelo legado (schema_name
      // null, datos en public) sin impacto visible para el usuario -- se
      // puede reintentar a mano con `node src/scripts/cutoverTenant.js <slug>`.
      // Este era el único punto de creación de tenants que le faltaba esta
      // llamada (routes/superadmin.routes.js es el router real montado en
      // server.js; el controller viejo que sí la tenía nunca estuvo enrutado).
      cutoverTenant(tenant.slug)
        .then(() => {
          tenant.update({
            cutover_last_attempt_at: new Date(),
            cutover_last_status: 'success',
            cutover_last_error: null,
          }).catch((err) => {
            console.error(`No se pudo guardar el estado de cutover exitoso para "${tenant.slug}":`, err);
          });
        })
        .catch((err) => {
          console.error(`Error aprovisionando schema para tenant "${tenant.slug}":`, err);
          tenant.update({
            cutover_last_attempt_at: new Date(),
            cutover_last_status: 'failed',
            cutover_last_error: String(err && err.message ? err.message : err).slice(0, 4000),
          }).catch((updateErr) => {
            console.error(`Además, no se pudo guardar el error de cutover para "${tenant.slug}":`, updateErr);
          });
        });
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

      const updates = {
        company_name: req.body.company_name,
        business_name: req.body.business_name,
        tax_id: req.body.tax_id,
        email: req.body.email,
        phone: req.body.phone,
        address: req.body.address,
      };
      if (req.body.modules_enabled !== undefined) updates.modules_enabled = req.body.modules_enabled;
      if (req.body.modules_disabled !== undefined) updates.modules_disabled = req.body.modules_disabled;

      // Plan (por plan_id del selector nuevo, o por slug legacy)
      const plan = req.body.plan_id
        ? await SubscriptionPlan.findByPk(req.body.plan_id)
        : req.body.plan
          ? await SubscriptionPlan.findOne({ where: { slug: req.body.plan } })
          : null;

      if (plan) {
        updates.plan_id = plan.id;

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

      await tenant.update(updates);
      invalidateModulesCache(tenant.id);

      res.json({ tenant });
    } catch (error) {
      console.error('Error updating tenant:', error);
      res.status(500).json({ error: 'Error al actualizar tenant' });
    }
  }
);

// DELETE /tenants/:id - Eliminar empresa permanentemente
router.delete(
  '/tenants/:id',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    const transaction = await Tenant.sequelize.transaction();
    try {
      const { id } = req.params;

      const tenant = await Tenant.findByPk(id, { transaction });
      if (!tenant) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }
      const { schema_name: schemaName } = tenant;

      // Eliminar en orden para respetar FK constraints
      // 1. Usuarios del tenant
      await User.destroy({ where: { tenant_id: id }, transaction });

      // 2. Suscripciones
      await TenantSubscription.destroy({ where: { tenant_id: id }, transaction });

      // 3. El tenant mismo (el resto de tablas tienen ON DELETE CASCADE
      // desde la migración 2026072704-fix-tenant-cascade-deletes.js)
      await Tenant.destroy({ where: { id }, transaction });

      await transaction.commit();

      // 4. Si el tenant ya vivía en su propio schema (schema-per-tenant),
      // el borrado de arriba solo limpió las filas legadas de `public` --
      // el schema dedicado con los datos reales queda huérfano si no se
      // dropea acá. No puede ir dentro de la misma transacción (DROP
      // SCHEMA no es transaccional de forma útil junto con las queries
      // anteriores y no debe bloquear la respuesta si falla).
      if (schemaName) {
        Tenant.sequelize
          .query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
          .catch((err) => {
            console.error(`Error dropeando schema "${schemaName}" del tenant eliminado:`, err);
          });
      }

      res.json({
        success: true,
        message: `Empresa "${tenant.company_name}" eliminada permanentemente`,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error eliminando tenant:', error);

      // FK constraint violation — hay datos relacionados que impiden el borrado
      if (error.name === 'SequelizeForeignKeyConstraintError') {
        return res.status(409).json({
          error: 'No se puede eliminar la empresa porque tiene datos relacionados (ventas, inventario, etc.). Desactívala en su lugar.',
          details: error.message,
        });
      }

      res.status(500).json({ error: 'Error al eliminar la empresa', details: error.message });
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

// GET /modules-catalog - Catálogo de módulos y sus dependencias duras
router.get(
  '/modules-catalog',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  (req, res) => {
    res.json({ modules: MODULES_CATALOG });
  }
);

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
        max_products: req.body.max_products ?? 100,
        max_warehouses: req.body.max_warehouses ?? 1,
        max_branches: req.body.max_branches ?? 1,
        allow_extra_branches: req.body.allow_extra_branches || false,
        extra_branch_price: req.body.extra_branch_price || 0,
        max_invoices_per_month: req.body.max_invoices_per_month || 100,
        max_storage_mb: req.body.max_storage_mb || 100,
        modules: req.body.modules || [],
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
        max_products: req.body.max_products !== undefined ? req.body.max_products : plan.max_products,
        max_warehouses: req.body.max_warehouses !== undefined ? req.body.max_warehouses : plan.max_warehouses,
        max_branches: req.body.max_branches !== undefined ? req.body.max_branches : plan.max_branches,
        allow_extra_branches: req.body.allow_extra_branches !== undefined ? req.body.allow_extra_branches : plan.allow_extra_branches,
        extra_branch_price: req.body.extra_branch_price !== undefined ? req.body.extra_branch_price : plan.extra_branch_price,
        max_invoices_per_month: req.body.max_invoices_per_month !== undefined ? req.body.max_invoices_per_month : plan.max_invoices_per_month,
        modules: req.body.modules !== undefined ? req.body.modules : plan.modules,
        features: req.body.features !== undefined ? req.body.features : plan.features,
        is_active: req.body.is_active !== undefined ? req.body.is_active : plan.is_active,
        is_popular: req.body.is_popular !== undefined ? req.body.is_popular : plan.is_popular,
        sort_order: req.body.sort_order !== undefined ? req.body.sort_order : plan.sort_order,
      });

      invalidateAllModulesCache();
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
      let subscription = await TenantSubscription.findOne({
        where: { tenant_id: req.params.tenantId },
        include: [{ model: SubscriptionPlan, as: 'plan' }],
      });

      // Tenants creados antes de que existiera el sistema de suscripciones
      // (o fuera del flujo normal de alta) pueden no tener ningún registro
      // en tenant_subscriptions — sin esto, la pantalla de gestión de
      // suscripción del superadmin queda en blanco por falta de datos.
      // Se autoprovisiona una suscripción por defecto usando el plan_id
      // del tenant (o el plan "free" como último fallback).
      if (!subscription) {
        const tenant = await Tenant.findByPk(req.params.tenantId);
        if (!tenant) {
          return res.status(404).json({ error: 'Tenant no encontrado' });
        }

        const plan =
          (tenant.plan_id && (await SubscriptionPlan.findByPk(tenant.plan_id))) ||
          (await SubscriptionPlan.findOne({ where: { slug: 'free' } })) ||
          (await SubscriptionPlan.findOne({ order: [['sort_order', 'ASC']] }));

        if (!plan) {
          return res.status(404).json({ error: 'No hay planes configurados para autoprovisionar la suscripción' });
        }

        const trialDays = plan.trial_days || 14;
        const trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

        const created = await TenantSubscription.create({
          tenant_id: tenant.id,
          plan_id: plan.id,
          status: tenant.subscription_status || 'trial',
          billing_cycle: 'monthly',
          amount: plan.monthly_price,
          currency: 'COP',
          starts_at: new Date(),
          trial_ends_at: trialEndsAt,
          current_period_start: new Date(),
          current_period_end: trialEndsAt,
          next_billing_date: trialEndsAt,
          auto_renew: true,
        });

        subscription = await TenantSubscription.findByPk(created.id, {
          include: [{ model: SubscriptionPlan, as: 'plan' }],
        });
      }

      res.json({ subscription });
    } catch (error) {
      console.error('Error al obtener suscripción:', error);
      res.status(500).json({ error: 'Error al obtener suscripción', details: error.message });
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

      // El login (auth.controller.js) y tenantMiddleware validan acceso
      // contra tenants.subscription_status, NO contra tenant_subscriptions
      // -- si no se sincroniza acá, el tenant queda con acceso bloqueado (o
      // indebidamente abierto) aunque este endpoint reporte éxito.
      // 'past_due' no es un valor válido en tenants.subscription_status
      // (solo trial/active/suspended/cancelled) -- durante ese estado el
      // acceso sigue normal (gracia), así que se mapea a 'active'.
      const tenantSyncStatus = req.body.status === 'past_due' ? 'active' : req.body.status;
      await Tenant.update(
        { subscription_status: tenantSyncStatus },
        { where: { id: req.params.tenantId } }
      );

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

      // Igual que en change-subscription-status: tenants.trial_ends_at es
      // lo que de verdad chequea el login/tenantMiddleware, no
      // tenant_subscriptions -- y extender el trial implica reactivar el
      // acceso si el tenant estaba suspendido por vencimiento previo.
      await Tenant.update(
        { trial_ends_at: newTrialEnd, subscription_status: 'trial' },
        { where: { id: req.params.tenantId } }
      );

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

      // Ver nota en extend-trial: tenants.trial_ends_at es la columna que
      // valida el acceso, hay que mantenerla en sincro con la suscripción.
      await Tenant.update(
        { trial_ends_at: req.body.trial_ends_at, subscription_status: 'trial' },
        { where: { id: req.params.tenantId } }
      );

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

      const revenueByMonthEstimado = tenantsByMonth.map((item) => ({
        month: item.month,
        total: parseInt(item.count) * 50000,
      }));

      // Si la conexión NCF está activa, usar plata REAL facturada en vez
      // del estimado (nuevos_tenants * $50.000) que se usaba antes -- ese
      // número nunca fue ingreso real, era un placeholder.
      let revenueByMonth = revenueByMonthEstimado;
      let revenueIsEstimate = true;
      try {
        const ncfClient = require('../services/ncf/ncfClient');
        const config = await ncfClient.getConfig();
        if (config?.is_active) {
          const real = await ncfClient.obtenerFacturacionMensual(24);
          if (real) {
            revenueByMonth = real.map((r) => ({ month: r.mes, total: r.total }));
            revenueIsEstimate = false;
          }
        }
      } catch (ncfErr) {
        console.warn('No se pudo obtener facturación real del Núcleo, usando estimado:', ncfErr.message);
      }

      // Estado de cobro -- cuántos tenants están suspendidos por impago
      // ahora mismo, y cuántos están en el margen de gracia (vencidos pero
      // todavía no suspendidos). Ver ncfSyncService.revisarSuspensiones.
      const tenantsSuspendidos = await Tenant.count({ where: { subscription_status: 'suspended' } });
      const tenantsPorVencer = await TenantSubscription.count({ where: { status: 'past_due' } });

      // ✅ ESTRUCTURA CORRECTA
      res.json({
        data: {
          tenantsByMonth: tenantsByMonth.map((item) => ({
            month: item.month,
            count: item.count,
          })),
          revenueByMonth,
          revenueIsEstimate,
          tenantsSuspendidos,
          tenantsPorVencer,
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

      const TenantMercadoPagoConfig = require('../models/payments/TenantMercadoPagoConfig');

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

      const TenantMercadoPagoConfig = require('../models/payments/TenantMercadoPagoConfig');

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

      const TenantMercadoPagoConfig = require('../models/payments/TenantMercadoPagoConfig');

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
// CONFIGURACIÓN NCF -- NÚCLEO CENTRAL DE FACTURACIÓN (ESC DATACORE)
// ============================================
// Mismo patrón que la configuración de MercadoPago de arriba: un registro
// global (la credencial de Pitbox como SistemaOrigen frente al Núcleo) y
// un registro por tenant (los datos fiscales para poder facturarle su
// suscripción). Ver src/services/ncf/ncfClient.js.

/**
 * GET /api/v1/superadmin/ncf-config
 * Configuración global de la conexión con el Núcleo (un solo registro)
 */
router.get(
  '/ncf-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const NcfConfig = require('../models/payments/NcfConfig');

      let config = await NcfConfig.findOne();
      if (!config) {
        config = await NcfConfig.create({});
      }

      res.json({
        success: true,
        config: {
          id: config.id,
          ncf_base_url: config.ncf_base_url || null,
          has_api_key: !!config.ncf_api_key,
          has_webhook_secret: !!config.ncf_webhook_secret,
          is_active: config.is_active,
          last_test_at: config.last_test_at,
          last_test_ok: config.last_test_ok,
          last_test_message: config.last_test_message,
          webhook_url_a_configurar_en_el_nucleo: `${process.env.BACKEND_PUBLIC_URL || 'https://TU-DOMINIO-PITBOX'}/api/webhooks/ncf`,
        },
      });
    } catch (error) {
      console.error('Error fetching NCF config:', error);
      res.status(500).json({ error: 'Error al obtener configuración NCF' });
    }
  }
);

/**
 * POST /api/v1/superadmin/ncf-config
 * Guardar/Actualizar la configuración global de conexión con el Núcleo
 */
router.post(
  '/ncf-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { ncf_base_url, ncf_api_key, ncf_webhook_secret, is_active } = req.body;

      if (!ncf_base_url) {
        return res.status(400).json({ error: 'ncf_base_url es requerido' });
      }

      const NcfConfig = require('../models/payments/NcfConfig');
      let config = await NcfConfig.findOne();

      const updates = { ncf_base_url };
      // Los secretos solo se sobreescriben si vienen en el body -- así el
      // formulario del frontend puede guardar cambios sin tener que
      // re-pegar la API key cada vez (nunca se la devolvemos en el GET).
      if (ncf_api_key) updates.ncf_api_key = ncf_api_key;
      if (ncf_webhook_secret) updates.ncf_webhook_secret = ncf_webhook_secret;
      if (is_active !== undefined) updates.is_active = is_active;

      if (config) {
        await config.update(updates);
      } else {
        config = await NcfConfig.create(updates);
      }

      res.json({
        success: true,
        message: 'Configuración NCF guardada correctamente',
        config: {
          id: config.id,
          ncf_base_url: config.ncf_base_url,
          has_api_key: !!config.ncf_api_key,
          has_webhook_secret: !!config.ncf_webhook_secret,
          is_active: config.is_active,
        },
      });
    } catch (error) {
      console.error('Error saving NCF config:', error);
      res.status(500).json({ error: 'Error al guardar configuración NCF', details: error.message });
    }
  }
);

/**
 * DELETE /api/v1/superadmin/ncf-config
 * Limpia las credenciales (no borra el registro, mismo patrón que MercadoPago)
 */
router.delete(
  '/ncf-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const NcfConfig = require('../models/payments/NcfConfig');
      const config = await NcfConfig.findOne();

      if (!config) {
        return res.status(404).json({ error: 'Configuración no encontrada' });
      }

      await config.update({
        ncf_api_key: null,
        ncf_webhook_secret: null,
        is_active: false,
      });

      res.json({ success: true, message: 'Credenciales NCF eliminadas correctamente' });
    } catch (error) {
      console.error('Error deleting NCF config:', error);
      res.status(500).json({ error: 'Error al eliminar configuración NCF' });
    }
  }
);

/**
 * POST /api/v1/superadmin/ncf-config/probar-conexion
 * Valida que ncf_base_url + ncf_api_key funcionan de verdad contra el
 * Núcleo (no solo que se guardaron) -- responde a la pregunta "¿cómo los
 * valido?" sin tener que ir a probar manualmente con curl.
 */
router.post(
  '/ncf-config/probar-conexion',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const ncfClient = require('../services/ncf/ncfClient');
      const result = await ncfClient.probarConexion();
      res.json({ success: result.ok, ...result });
    } catch (error) {
      console.error('Error probando conexión NCF:', error);
      res.status(500).json({ error: 'Error al probar la conexión', details: error.message });
    }
  }
);

/**
 * GET /api/v1/superadmin/ncf-config/tenants
 * Estado de sincronización NCF de TODOS los tenants (por sistema completo,
 * no hay pantalla por tenant). Lee directo de public.tenants.
 */
router.get(
  '/ncf-config/tenants',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const Tenant = require('../models/Tenant');
      const tenants = await Tenant.findAll({
        where: { is_active: true },
        attributes: [
          'id', 'company_name', 'business_name', 'tax_id', 'email',
          'subscription_status', 'ncf_ciudad', 'ncf_regimen_code',
          'ncf_external_ref', 'ncf_last_sync_at', 'ncf_last_status',
          'ncf_payment_link_url', 'ncf_last_error',
        ],
        order: [['business_name', 'ASC']],
      });

      res.json({ success: true, tenants });
    } catch (error) {
      console.error('Error listing tenants NCF status:', error);
      res.status(500).json({ error: 'Error al listar el estado NCF de los tenants' });
    }
  }
);

/**
 * POST /api/v1/superadmin/ncf-config/sincronizar-tenants
 * Sincronización POR SISTEMA COMPLETO: recorre los tenants activos cuya
 * fecha de corte cae dentro de la ventana de anticipación (NCF_ANTICIPATION_DAYS,
 * 7 días por defecto) y envía/actualiza su prefactura en el Núcleo, en una
 * sola pasada. No hay activación por tenant -- el único interruptor es
 * NcfConfig.is_active. Es la misma función que corre sola todos los días
 * (ver /api/cron/ncf-sync) -- este botón solo la dispara manualmente.
 *
 * Body opcional: { forzar: true } -- ignora la ventana de anticipación y el
 * chequeo de "ya sincronizado este ciclo" (para pruebas o reenvíos puntuales).
 */
router.post(
  '/ncf-config/sincronizar-tenants',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const ncfSyncService = require('../services/ncf/ncfSyncService');
      const resultados = await ncfSyncService.sincronizarTodosLosTenants({ forzar: !!req.body?.forzar });

      res.json({
        success: true,
        message: `Sincronización completa: ${resultados.length} tenants evaluados`,
        resultados,
      });
    } catch (error) {
      console.error('Error sincronizando tenants con NCF:', error);
      res.status(500).json({ error: error.message || 'Error al sincronizar con el Núcleo' });
    }
  }
);

// ============================================
// INTEGRACIÓN CON META (Facebook/Instagram Lead Ads, WhatsApp Cloud API)
// ============================================
// meta_config es un singleton -- la App de Meta que Pitbox registró, usada
// para el OAuth de "cuenta propia" de cualquier tenant y como App/página
// compartida del modo "servicio Pitbox". Ver models/payments/MetaConfig.js.

/**
 * GET /api/v1/superadmin/meta-config
 */
router.get(
  '/meta-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const MetaConfig = require('../models/payments/MetaConfig');
      let config = await MetaConfig.findOne();
      if (!config) config = await MetaConfig.create({});

      res.json({
        success: true,
        config: {
          id: config.id,
          app_id: config.app_id || null,
          has_app_secret: !!config.app_secret,
          has_webhook_verify_token: !!config.webhook_verify_token,
          shared_page_id: config.shared_page_id || null,
          shared_waba_id: config.shared_waba_id || null,
          has_shared_system_user_token: !!config.shared_system_user_token,
          is_active: config.is_active,
          last_test_at: config.last_test_at,
          last_test_ok: config.last_test_ok,
          last_test_message: config.last_test_message,
          webhook_url_a_configurar_en_meta: `${process.env.BACKEND_PUBLIC_URL || 'https://TU-DOMINIO-PITBOX'}/api/webhooks/meta`,
        },
      });
    } catch (error) {
      console.error('Error fetching Meta config:', error);
      res.status(500).json({ error: 'Error al obtener configuración de Meta' });
    }
  }
);

/**
 * POST /api/v1/superadmin/meta-config
 * Los secretos solo se sobreescriben si vienen en el body (nunca se
 * devuelven en el GET) -- mismo criterio que /ncf-config.
 */
router.post(
  '/meta-config',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { app_id, app_secret, webhook_verify_token, shared_page_id, shared_waba_id, shared_system_user_token, is_active } = req.body;

      const MetaConfig = require('../models/payments/MetaConfig');
      let config = await MetaConfig.findOne();

      const updates = {};
      if (app_id !== undefined) updates.app_id = app_id;
      if (app_secret) updates.app_secret = app_secret;
      if (webhook_verify_token) updates.webhook_verify_token = webhook_verify_token;
      if (shared_page_id !== undefined) updates.shared_page_id = shared_page_id;
      if (shared_waba_id !== undefined) updates.shared_waba_id = shared_waba_id;
      if (shared_system_user_token) updates.shared_system_user_token = shared_system_user_token;
      if (is_active !== undefined) updates.is_active = is_active;

      if (config) {
        await config.update(updates);
      } else {
        config = await MetaConfig.create(updates);
      }

      res.json({ success: true, message: 'Configuración de Meta guardada correctamente' });
    } catch (error) {
      console.error('Error saving Meta config:', error);
      res.status(500).json({ error: 'Error al guardar configuración de Meta', details: error.message });
    }
  }
);

/**
 * POST /api/v1/superadmin/meta-config/probar-conexion
 */
router.post(
  '/meta-config/probar-conexion',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const metaClient = require('../services/meta/metaClient');
      const result = await metaClient.probarConexion();
      res.json({ success: result.ok, ...result });
    } catch (error) {
      console.error('Error probando conexión con Meta:', error);
      res.status(500).json({ error: 'Error al probar la conexión', details: error.message });
    }
  }
);

/**
 * GET /api/v1/superadmin/meta-config/tenants
 * Estado de la conexión de Meta de todos los tenants -- para ver de un
 * vistazo quién está en modo propio/compartido y a quién le falta mapear
 * formularios de Lead Ads en modo compartido.
 */
router.get(
  '/meta-config/tenants',
  authMiddleware,
  checkPermission('superadmin.view_all'),
  async (req, res) => {
    try {
      const TenantMetaConfig = require('../models/payments/TenantMetaConfig');
      const configs = await TenantMetaConfig.findAll({
        include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'company_name', 'business_name'] }],
        order: [['updated_at', 'DESC']],
      });
      res.json({ success: true, configs });
    } catch (error) {
      console.error('Error listing tenant Meta configs:', error);
      res.status(500).json({ error: 'Error al listar las conexiones de Meta' });
    }
  }
);

/**
 * PUT /api/v1/superadmin/meta-config/tenants/:tenantId/lead-forms
 * Asigna manualmente qué IDs de formulario de Lead Ads (bajo la página
 * compartida) le pertenecen a este tenant -- solo aplica en modo 'pitbox'.
 * Body: { form_ids: ['123', '456'] }
 */
router.put(
  '/meta-config/tenants/:tenantId/lead-forms',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { form_ids } = req.body;
      if (!Array.isArray(form_ids)) {
        return res.status(400).json({ error: 'form_ids debe ser un array de strings' });
      }

      const TenantMetaConfig = require('../models/payments/TenantMetaConfig');
      const config = await TenantMetaConfig.findOne({ where: { tenant_id: req.params.tenantId } });
      if (!config) return res.status(404).json({ error: 'Este tenant no tiene una conexión de Meta iniciada' });
      if (config.provider_mode !== 'pitbox') {
        return res.status(400).json({ error: 'Este tenant no está en modo "servicio Pitbox" -- el mapeo de formularios no aplica' });
      }

      await config.update({ pitbox_lead_form_ids: form_ids });
      res.json({ success: true, message: 'Formularios asignados correctamente', config });
    } catch (error) {
      console.error('Error asignando formularios de Meta:', error);
      res.status(500).json({ error: 'Error al asignar los formularios' });
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
// GESTIÓN DE USUARIOS DE TENANTS (acciones individuales)
// ============================================

/**
 * PUT /api/v1/superadmin/tenants/:tenantId/users/:userId
 * Actualizar datos de un usuario específico
 */
router.put(
  '/tenants/:tenantId/users/:userId',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { first_name, last_name, email, phone, role, is_active } = req.body;

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede editar un super admin' });
      }

      const updates = {};
      if (first_name)          updates.first_name = first_name;
      if (last_name)           updates.last_name  = last_name;
      if (email)               updates.email      = email;
      if (phone !== undefined) updates.phone      = phone;
      if (role)                updates.role       = role;
      if (is_active !== undefined) updates.is_active = is_active;

      await user.update(updates);

      const userResponse = user.toJSON();
      delete userResponse.password_hash;

      res.json({ success: true, message: 'Usuario actualizado exitosamente', data: { user: userResponse } });
    } catch (error) {
      console.error('Error actualizando usuario:', error);
      res.status(500).json({ success: false, message: 'Error al actualizar usuario', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  }
);

/**
 * DELETE /api/v1/superadmin/tenants/:tenantId/users/:userId
 * Eliminar (desactivar) un usuario de un tenant
 */
router.delete(
  '/tenants/:tenantId/users/:userId',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede eliminar un super admin' });
      }

      // Soft delete: desactivar en lugar de borrar físicamente
      await user.update({ is_active: false });

      res.json({ success: true, message: 'Usuario eliminado exitosamente' });
    } catch (error) {
      console.error('Error eliminando usuario:', error);
      res.status(500).json({ success: false, message: 'Error al eliminar usuario', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  }
);

/**
 * PATCH /api/v1/superadmin/tenants/:tenantId/users/:userId/toggle-status
 * Reactivar (o volver a desactivar) un usuario de un tenant. El DELETE de
 * arriba solo desactiva -- sin esto no había forma de revertirlo desde el
 * panel de superadmin.
 */
router.patch(
  '/tenants/:tenantId/users/:userId/toggle-status',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede cambiar el estado de un super admin' });
      }

      const newStatus = !user.is_active;
      await user.update({ is_active: newStatus });

      res.json({
        success: true,
        message: `Usuario ${newStatus ? 'reactivado' : 'desactivado'} exitosamente`,
        data: { user: { id: user.id, is_active: newStatus } },
      });
    } catch (error) {
      console.error('Error cambiando estado del usuario:', error);
      res.status(500).json({ success: false, message: 'Error al cambiar estado del usuario', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  }
);

/**
 * PUT /api/v1/superadmin/tenants/:tenantId/users/:userId/role
 * Cambiar el rol de un usuario
 */
router.put(
  '/tenants/:tenantId/users/:userId/role',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      const validRoles = ['admin', 'operario', 'cliente'];
      if (!role || !validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Rol inválido. Valores permitidos: ${validRoles.join(', ')}`
        });
      }

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede cambiar el rol de un super admin' });
      }

      await user.update({ role });

      res.json({ success: true, message: 'Rol actualizado exitosamente', data: { user } });
    } catch (error) {
      console.error('Error cambiando rol:', error);
      res.status(500).json({ success: false, message: 'Error al cambiar rol', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  }
);

/**
 * PUT /api/v1/superadmin/tenants/:tenantId/users/:userId/password
 * Resetear la contraseña de un usuario
 */
router.put(
  '/tenants/:tenantId/users/:userId/password',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { password } = req.body;

      if (!password || password.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'La contraseña debe tener al menos 8 caracteres'
        });
      }

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede resetear la contraseña de un super admin' });
      }

      // ✅ Siempre hashear la contraseña antes de guardar
      const hashedPassword = await bcrypt.hash(password, 10);
      await user.update({ password_hash: hashedPassword });

      res.json({ success: true, message: 'Contraseña reseteada exitosamente' });
    } catch (error) {
      console.error('Error reseteando contraseña:', error);
      res.status(500).json({ success: false, message: 'Error al resetear contraseña', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  }
);

/**
 * POST /api/v1/superadmin/tenants/:tenantId/users/:userId/impersonate
 * Inicia una sesión de soporte "como" el usuario indicado — nunca hacia un
 * super_admin ni un usuario inactivo. El token resultante lleva
 * `impersonated_by` (bloqueado de este mismo router por denyImpersonation)
 * y expira en IMPERSONATION_EXPIRES_IN, no en el JWT_EXPIRES_IN normal.
 */
router.post(
  '/tenants/:tenantId/users/:userId/impersonate',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    try {
      const { tenantId, userId } = req.params;

      const tenant = await Tenant.findByPk(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
      }

      const user = await User.findOne({ where: { id: userId, tenant_id: tenantId } });
      if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (user.role === 'super_admin') {
        return res.status(403).json({ success: false, message: 'No se puede iniciar sesión como un super admin' });
      }

      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'No se puede iniciar sesión como un usuario inactivo' });
      }

      // La impersonación es para dar soporte administrativo — roles operativos
      // (técnico, vendedor, bodeguero, etc.) no tienen acceso a la mayoría de
      // pantallas ni aunque se les impersone, así que solo confunde ("¿por qué
      // me da 403 si dice que inició sesión?"). Se limita a admin/manager.
      if (!['admin', 'manager'].includes(user.role)) {
        return res.status(403).json({ success: false, message: 'Solo se puede iniciar sesión como administrador o gerente del tenant' });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id, impersonated_by: req.user.id },
        JWT_SECRET,
        { expiresIn: IMPERSONATION_EXPIRES_IN }
      );

      setImmediate(() => audit({
        tenant_id: tenantId,
        user_id: req.user.id,
        action: 'IMPERSONATE_START',
        entity: 'user',
        entity_id: user.id,
        changes: { impersonated_email: user.email, impersonated_role: user.role, company_name: tenant.company_name },
        req,
      }));

      res.json({
        success: true,
        message: 'Sesión de soporte iniciada',
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
            tenant_id: user.tenant_id,
          },
        },
      });
    } catch (error) {
      console.error('Error iniciando impersonación:', error);
      res.status(500).json({ success: false, message: 'Error al iniciar sesión de soporte', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
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

// ============================================
// MIGRACIÓN SCHEMA-PER-TENANT -- VISIBILIDAD OPERATIVA (Fase 5, continuación)
// ============================================
// El GET de estado (/tenants/migration-status) vive arriba, ANTES de
// GET /tenants/:id, para que Express no lo confunda con ese :id. Las
// acciones (POST) de acá abajo no tienen ese problema porque su forma
// exacta (/tenants/:slug/cutover, etc.) no colisiona con ninguna ruta
// registrada antes.

// POST /tenants/:slug/cutover -- dispara (o reintenta) el corte a schema
// dedicado. Síncrono a propósito acá (a diferencia del alta automática):
// quien aprieta el botón en el panel quiere saber el resultado, no
// enterarse después por otro canal.
router.post(
  '/tenants/:slug/cutover',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    const { slug } = req.params;
    try {
      const tenant = await Tenant.findOne({ where: { slug } });
      if (!tenant) return res.status(404).json({ error: `Tenant "${slug}" no existe` });
      if (tenant.schema_name) {
        return res.status(400).json({ error: `Tenant "${slug}" ya está migrado (schema_name="${tenant.schema_name}")` });
      }

      await cutoverTenant(slug);
      await tenant.reload();
      await tenant.update({
        cutover_last_attempt_at: new Date(),
        cutover_last_status: 'success',
        cutover_last_error: null,
      });

      res.json({ success: true, slug, schema_name: tenant.schema_name });
    } catch (error) {
      console.error(`Error en cutover manual de "${slug}":`, error);
      await Tenant.update(
        {
          cutover_last_attempt_at: new Date(),
          cutover_last_status: 'failed',
          cutover_last_error: String(error && error.message ? error.message : error).slice(0, 4000),
        },
        { where: { slug } }
      );
      res.status(500).json({ error: 'Error al cortar el tenant a schema dedicado', details: error.message });
    }
  }
);

// POST /tenants/:slug/rollback -- body opcional: { dropSchema: boolean }
router.post(
  '/tenants/:slug/rollback',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    const { slug } = req.params;
    const dropSchema = req.body?.dropSchema === true;
    try {
      const tenant = await Tenant.findOne({ where: { slug } });
      if (!tenant) return res.status(404).json({ error: `Tenant "${slug}" no existe` });
      if (!tenant.schema_name) {
        return res.status(400).json({ error: `Tenant "${slug}" ya está en modo legado` });
      }

      await rollbackTenant(slug, { dropSchema });
      res.json({ success: true, slug, dropSchema });
    } catch (error) {
      console.error(`Error en rollback manual de "${slug}":`, error);
      res.status(500).json({ error: 'Error al revertir el tenant a modo legado', details: error.message });
    }
  }
);

// POST /tenants/:slug/cleanup -- body opcional: { execute: boolean }.
// Sin `execute`, corre en dry-run (no borra nada, solo reporta qué
// borraría) -- mismo comportamiento por defecto que el script de consola.
router.post(
  '/tenants/:slug/cleanup',
  authMiddleware,
  checkPermission('superadmin.manage_all'),
  async (req, res) => {
    const { slug } = req.params;
    const execute = req.body?.execute === true;
    try {
      const tenant = await Tenant.findOne({ where: { slug } });
      if (!tenant) return res.status(404).json({ error: `Tenant "${slug}" no existe` });
      if (!tenant.schema_name) {
        return res.status(400).json({ error: `Tenant "${slug}" está en modo legado, no hay datos de public que limpiar todavía` });
      }

      const report = await cleanupTenantPublicData(
        Tenant.sequelize,
        { id: tenant.id, slug: tenant.slug, schema_name: tenant.schema_name },
        { execute }
      );

      res.json({ success: true, slug, execute, report });
    } catch (error) {
      console.error(`Error en cleanup manual de "${slug}":`, error);
      res.status(500).json({ error: 'Error al limpiar datos legados de public', details: error.message });
    }
  }
);

module.exports = router;