// backend/src/services/crmLifecycleService.js
//
// CRM Fase 3 — job nocturno. Recalcula, por cliente:
//   - lifecycle_stage (prospecto / activo / en_riesgo / inactivo)
//   - next_vehicle_service_due (solo si el tenant tiene 'workshop' activo)
// y dispara una Opportunity automática (source='recompra_recurrente') cuando
// el cliente entra en su ventana de recompra estimada y no tiene ya una
// oportunidad abierta.
//
// Sigue el mismo patrón multi-schema que vehicleReminderService.js: cada
// tenant con schema propio se procesa dentro de runWithTenantSchema; los
// tenants legacy (sin schema_name) se procesan juntos contra `public`.
//
// Umbral de "en riesgo" (DEFAULT_ACTIVE_WINDOW_DAYS): hardcodeado por ahora.
// El diseño original lo deja marcado como parametrizable por tenant a
// futuro (un taller y una tienda de repuestos tienen ciclos de recompra
// distintos) — pendiente de UI/campo en Tenant, no bloqueante para esta fase.
const { Op, fn, col } = require('sequelize');

const DEFAULT_ACTIVE_WINDOW_DAYS = 90; // "activo" si compró/interactuó dentro de esta ventana
const AT_RISK_WINDOW_DAYS = DEFAULT_ACTIVE_WINDOW_DAYS * 2; // "en_riesgo" hasta el doble; después "inactivo"

function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24));
}

function avgIntervalDays(sortedDates) {
  if (sortedDates.length < 2) return null;
  let totalGap = 0;
  for (let i = 1; i < sortedDates.length; i++) {
    totalGap += daysBetween(sortedDates[i], sortedDates[i - 1]);
  }
  return totalGap / (sortedDates.length - 1);
}

async function processTenantCustomers(tenantId, hasWorkshop, results) {
  const { Customer, Sale, CustomerInteraction, Opportunity, Vehicle, WorkOrder } = require('../models');
  const { loadStageMap, keysByType, resolveEntryStageKey } = require('../utils/crmPipelineStages');

  const customers = await Customer.findAll({ where: { tenant_id: tenantId, is_active: true } });
  const today = new Date();

  // Fase B.4 — 'nuevo'/'ganado'/'perdido' ya no son strings fijos: se
  // resuelven una vez por tenant contra sus CrmPipelineStage configuradas.
  const stageMap = await loadStageMap(tenantId);
  const openKeys = keysByType(stageMap, 'open');
  const entryStageKey = resolveEntryStageKey(stageMap);

  for (const customer of customers) {
    try {
      const sales = await Sale.findAll({
        where: {
          tenant_id: tenantId,
          customer_id: customer.id,
          document_type: { [Op.ne]: 'cotizacion' },
          status: { [Op.notIn]: ['cancelled', 'draft'] },
        },
        attributes: ['id', 'sale_date'],
        order: [['sale_date', 'ASC']],
      });
      const saleDates = sales.map(s => s.sale_date).filter(Boolean);

      // ── lifecycle_stage ──────────────────────────────────────────────
      const lastActivity = [customer.last_interaction_at, saleDates[saleDates.length - 1]]
        .filter(Boolean)
        .map(d => new Date(d))
        .sort((a, b) => b - a)[0] || null;

      let lifecycle_stage;
      if (!lastActivity) {
        lifecycle_stage = 'prospecto';
      } else {
        const daysSince = daysBetween(today, lastActivity);
        if (daysSince <= DEFAULT_ACTIVE_WINDOW_DAYS) lifecycle_stage = 'activo';
        else if (daysSince <= AT_RISK_WINDOW_DAYS) lifecycle_stage = 'en_riesgo';
        else lifecycle_stage = 'inactivo';
      }

      // ── disparador de recompra genérico (RFM simple) ────────────────
      const genericInterval = avgIntervalDays(saleDates.map(d => new Date(d)));
      let nextRepurchaseDue = null;
      if (genericInterval && saleDates.length >= 2) {
        const last = new Date(saleDates[saleDates.length - 1]);
        nextRepurchaseDue = new Date(last.getTime() + genericInterval * 86400000);
      }

      // ── especialización: próximo servicio de vehículo (solo Taller) ─
      let next_vehicle_service_due = null;
      if (hasWorkshop) {
        const vehicles = await Vehicle.findAll({ where: { tenant_id: tenantId, customer_id: customer.id } });
        for (const vehicle of vehicles) {
          const orders = await WorkOrder.findAll({
            where: { tenant_id: tenantId, vehicle_id: vehicle.id, status: 'entregado' },
            attributes: ['received_at'],
            order: [['received_at', 'ASC']],
          });
          const orderDates = orders.map(o => o.received_at).filter(Boolean).map(d => new Date(d));
          const vehicleInterval = avgIntervalDays(orderDates);
          if (vehicleInterval && orderDates.length >= 2) {
            const last = orderDates[orderDates.length - 1];
            const due = new Date(last.getTime() + vehicleInterval * 86400000);
            if (!next_vehicle_service_due || due < next_vehicle_service_due) next_vehicle_service_due = due;
          }
        }
      }

      // El dato real de vehículo siempre gana sobre el promedio genérico
      // cuando ambos existen (más preciso — ver §2-bis del diseño).
      const finalRepurchaseTrigger = next_vehicle_service_due || nextRepurchaseDue;

      await customer.update({
        lifecycle_stage,
        next_vehicle_service_due: hasWorkshop ? (next_vehicle_service_due ? next_vehicle_service_due.toISOString().slice(0, 10) : null) : null,
      });

      // ── disparar Opportunity automática si corresponde ──────────────
      if (finalRepurchaseTrigger && finalRepurchaseTrigger <= today) {
        const openOpportunity = await Opportunity.findOne({
          where: { tenant_id: tenantId, customer_id: customer.id, stage: { [Op.in]: openKeys } },
        });
        if (!openOpportunity) {
          await Opportunity.create({
            tenant_id: tenantId,
            customer_id: customer.id,
            owner_user_id: customer.owner_user_id || null,
            source: 'recompra_recurrente',
            stage: entryStageKey,
            stage_changed_at: new Date(),
          });
          results.opportunitiesCreated++;
        }
      }

      results.customersProcessed++;
    } catch (err) {
      results.errors++;
      console.error(`❌ [CRM lifecycle] Error procesando cliente ${customer.id}:`, err.message);
    }
  }
}

async function runCrmLifecycleJob() {
  const Tenant = require('../models/auth/Tenant');
  const { runWithTenantSchema } = require('../config/tenantContext');
  const { getEffectiveModulesForTenantId } = require('./moduleAccess');

  const results = { customersProcessed: 0, opportunitiesCreated: 0, errors: 0, tenantsSkipped: 0 };

  const allTenants = await Tenant.findAll({ attributes: ['id', 'schema_name', 'company_name'] });

  for (const tenant of allTenants) {
    const modules = await getEffectiveModulesForTenantId(tenant.id);
    if (!modules.includes('crm')) {
      results.tenantsSkipped++;
      continue;
    }
    const hasWorkshop = modules.includes('workshop');

    try {
      if (tenant.schema_name) {
        await runWithTenantSchema(tenant.schema_name, () => processTenantCustomers(tenant.id, hasWorkshop, results));
      } else {
        await processTenantCustomers(tenant.id, hasWorkshop, results);
      }
    } catch (err) {
      results.errors++;
      console.error(`❌ [CRM lifecycle] Error procesando tenant "${tenant.schema_name || tenant.id}":`, err.message);
    }
  }

  console.log(`✅ [CRM lifecycle] Clientes procesados: ${results.customersProcessed} | Oportunidades creadas: ${results.opportunitiesCreated} | Tenants sin CRM: ${results.tenantsSkipped} | Errores: ${results.errors}`);
  return results;
}

module.exports = { runCrmLifecycleJob };
