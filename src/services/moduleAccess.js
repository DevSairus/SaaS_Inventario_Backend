// backend/src/services/moduleAccess.js
// Calcula los "módulos efectivos" de un tenant:
//   effective_modules = (plan.modules ∪ tenant.modules_enabled) − tenant.modules_disabled
// cerrado transitivamente sobre las dependencias duras del catálogo, para que
// nunca exista una combinación rota (ej. Cartera sin Ventas) en runtime.

const Tenant = require('../models/auth/Tenant');
const SubscriptionPlan = require('../models/subscriptions/SubscriptionPlan');
const { MODULES_BY_KEY } = require('../config/modules.catalog');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // tenantId -> { modules, expiresAt }

function closeDependencies(moduleKeys) {
  const result = new Set(moduleKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...result]) {
      const deps = MODULES_BY_KEY[key]?.dependsOn || [];
      for (const dep of deps) {
        if (!result.has(dep)) {
          result.add(dep);
          changed = true;
        }
      }
    }
  }
  return result;
}

function getEffectiveModules(tenant, plan) {
  const base = new Set(plan?.modules || []);
  (tenant?.modules_enabled || []).forEach((m) => base.add(m));
  (tenant?.modules_disabled || []).forEach((m) => base.delete(m));
  return [...closeDependencies(base)];
}

async function getEffectiveModulesForTenantId(tenantId) {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.modules;
  }

  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['id', 'plan_id', 'modules_enabled', 'modules_disabled'],
  });

  if (!tenant) {
    return [];
  }

  const plan = tenant.plan_id
    ? await SubscriptionPlan.findByPk(tenant.plan_id, { attributes: ['id', 'modules'] })
    : null;

  const modules = getEffectiveModules(tenant, plan);
  cache.set(tenantId, { modules, expiresAt: Date.now() + CACHE_TTL_MS });
  return modules;
}

function invalidateModulesCache(tenantId) {
  cache.delete(tenantId);
}

// Usado cuando cambia un plan (afecta a todos los tenants que lo usan, no a
// uno puntual) — más simple que rastrear la relación inversa plan→tenants.
function invalidateAllModulesCache() {
  cache.clear();
}

module.exports = {
  getEffectiveModules,
  getEffectiveModulesForTenantId,
  invalidateModulesCache,
  invalidateAllModulesCache,
};
