// backend/src/middleware/checkLimits.js
const { Tenant, User } = require('../models');
const SubscriptionPlan = require('../models/subscriptions/SubscriptionPlan');
const { Op } = require('sequelize');

// Definición de planes y sus límites
// IMPORTANTE: incluye alias para 'basic' y 'premium' que usa el modelo Tenant
const PLANS = {
  free: {
    name: 'Free',
    max_users: 2,
    max_clients: 50,
    max_products: 100,
    max_warehouses: 1,
    max_invoices_per_month: 10,
    price: 0
  },
  basic: {
    name: 'Basic',
    max_users: 5,
    max_clients: 200,
    max_products: 500,
    max_warehouses: 2,
    max_invoices_per_month: 50,
    price: 29000
  },
  starter: {
    name: 'Starter',
    max_users: 5,
    max_clients: 200,
    max_products: 500,
    max_warehouses: 2,
    max_invoices_per_month: 50,
    price: 29000
  },
  premium: {
    name: 'Premium',
    max_users: 15,
    max_clients: 1000,
    max_products: 2000,
    max_warehouses: 5,
    max_invoices_per_month: 200,
    price: 69000
  },
  professional: {
    name: 'Professional',
    max_users: 15,
    max_clients: 1000,
    max_products: 2000,
    max_warehouses: 5,
    max_invoices_per_month: 200,
    price: 69000
  },
  enterprise: {
    name: 'Enterprise',
    max_users: -1,
    max_clients: -1,
    max_products: -1,
    max_warehouses: -1,
    max_invoices_per_month: -1,
    price: 149000
  }
};

/**
 * Middleware para verificar límites del plan antes de crear recursos
 * @param {string} resourceType - Tipo de recurso: 'users', 'clients', 'products', 'warehouses', 'invoices'
 */
const checkLimits = (resourceType) => {
  return async (req, res, next) => {
    try {
      // super_admin no tiene tenant y no tiene límites de plan
      if (req.is_super_admin) {
        return next();
      }

      const tenantId = req.tenant_id;

      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'Tenant ID no encontrado'
        });
      }

      // Obtener información del tenant
      const tenant = await Tenant.findByPk(tenantId);

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant no encontrado'
        });
      }

      // Fuente de verdad: subscription_plans (vía tenant.plan_id). Si el tenant
      // todavía no tiene plan_id asignado (legacy, sin backfill), cae al
      // objeto PLANS hardcodeado indexado por el string tenant.plan.
      let plan;
      if (tenant.plan_id) {
        const subscriptionPlan = await SubscriptionPlan.findByPk(tenant.plan_id);
        if (subscriptionPlan) {
          plan = {
            name: subscriptionPlan.name,
            max_users: subscriptionPlan.max_users,
            max_clients: subscriptionPlan.max_clients,
            max_products: subscriptionPlan.max_products,
            max_warehouses: subscriptionPlan.max_warehouses,
            max_invoices_per_month: subscriptionPlan.max_invoices_per_month,
          };
        }
      }
      plan = plan || PLANS[tenant.plan] || PLANS.enterprise;

      if (!plan) {
        // Esta rama nunca debería alcanzarse gracias al fallback, pero por seguridad:
        console.warn(`[checkLimits] Plan desconocido "${tenant.plan}", permitiendo acceso.`);
        return next();
      }

      // Verificar límite según el tipo de recurso
      let currentCount = 0;
      let maxLimit = 0;
      let limitName = '';

      switch (resourceType) {
        case 'users': {
          currentCount = await User.count({
            where: {
              tenant_id: tenantId,
              role: {
                [Op.in]: ['admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer', 'technician']
              },
              is_active: true
            }
          });
          maxLimit = plan.max_users;
          limitName = 'usuarios';
          break;
        }

        case 'clients': {
          currentCount = await User.count({
            where: {
              tenant_id: tenantId,
              role: 'cliente',
              is_active: true
            }
          });
          maxLimit = plan.max_clients;
          limitName = 'clientes';
          break;
        }

        case 'products': {
          const Product = require('../models/inventory/Product');
          currentCount = await Product.count({
            where: {
              tenant_id: tenantId,
              is_active: true
            }
          });
          maxLimit = plan.max_products;
          limitName = 'productos';
          break;
        }

        case 'warehouses': {
          const Warehouse = require('../models/inventory/Warehouse');
          currentCount = await Warehouse.count({
            where: {
              tenant_id: tenantId,
              is_active: true
            }
          });
          maxLimit = plan.max_warehouses;
          limitName = 'bodegas';
          break;
        }

        case 'invoices': {
          const Invoice = require('../models/sales/Sale');
          const now = new Date();
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

          currentCount = await Invoice.count({
            where: {
              tenant_id: tenantId,
              created_at: { [Op.gte]: startOfMonth }
            }
          });
          maxLimit = plan.max_invoices_per_month;
          limitName = 'facturas este mes';
          break;
        }

        default:
          return res.status(400).json({
            success: false,
            message: 'Tipo de recurso no válido'
          });
      }

      // -1 significa ilimitado
      if (maxLimit === -1) {
        return next();
      }

      // Verificar si se ha alcanzado el límite
      if (currentCount >= maxLimit) {
        return res.status(402).json({
          success: false,
          code: 'PLAN_LIMIT_EXCEEDED',
          message: `Has alcanzado el límite de ${limitName} en tu plan ${plan.name} (${currentCount}/${maxLimit}). Actualiza tu plan para agregar más.`,
          limit: {
            current: currentCount,
            max: maxLimit,
            plan: plan.name,
            planCode: tenant.plan,
            resourceType: limitName
          }
        });
      }

      // Advertencia si está cerca del límite (90%)
      const warningThreshold = Math.floor(maxLimit * 0.9);
      if (currentCount >= warningThreshold) {
        res.set('X-Limit-Warning', 'true');
        res.set('X-Limit-Current', currentCount);
        res.set('X-Limit-Max', maxLimit);
      }

      next();
    } catch (error) {
      console.error('❌ [checkLimits] Error:', error);
      res.status(500).json({
        success: false,
        message: 'Error al verificar límites',
        error: error.message
      });
    }
  };
};

module.exports = {
  checkLimits,
  PLANS
};