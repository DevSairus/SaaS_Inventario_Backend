// backend/src/services/tenantPurgeService.js
//
// Elimina PERMANENTEMENTE un tenant y absolutamente todos sus datos.
// Política de la empresa: a los 30 días de cancelado un contrato se borran
// los datos y la empresa. También se usa para depurar tenants de demo/
// prueba ofrecidos a posibles clientes.
//
// Cubre los dos modos en los que puede estar un tenant (la migración a
// schema-per-tenant es gradual, tenant por tenant -- ver middleware/tenant.js):
//
//   1. Tenant YA migrado (tenants.schema_name != null):
//      -> DROP SCHEMA "tenant_<slug>" CASCADE se lleva TODO lo que vive ahí
//         (ventas, inventario, OTs, facturas, etc).
//
//   2. Tenant en modo legado o parcialmente migrado:
//      -> cualquier fila que haya quedado en tablas de "public" con su
//         tenant_id (users, tenant_subscriptions, subscription_invoices,
//         tenant_mercadopago_config, audit_logs, y cualquier tabla de
//         negocio que nunca se migró) se borra respetando el orden de FKs,
//         mismo enfoque de topoSort que ya usa scripts/rollbackTenant.js.
//
// Estos dos pasos NO son excluyentes: siempre se corre el barrido de
// `public` (por si quedó algo huérfano ahí) y ADEMÁS se dropea el schema
// si existe.

const { sequelize } = require('../config/database');
const Tenant = require('../models/auth/Tenant');

async function getTenantScopedTables() {
  const [rows] = await sequelize.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  `);
  return rows.map((r) => r.table_name);
}

// Orden topológico por FKs, pero invertido: para BORRAR hay que eliminar
// primero los HIJOS (los que referencian a otra tabla), no los padres.
async function tablesInDeleteOrder(tables) {
  const tableSet = new Set(tables);
  const [fkRows] = await sequelize.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of fkRows) {
    if (tableSet.has(child) && tableSet.has(parent) && child !== parent) deps.get(child).add(parent);
  }
  const sorted = [];
  const visited = new Set();
  function visit(t, stack = new Set()) {
    if (visited.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const dep of deps.get(t) || []) visit(dep, stack);
    stack.delete(t);
    visited.add(t);
    sorted.push(t);
  }
  for (const t of tables) visit(t);
  return sorted.reverse(); // hijos primero
}

/**
 * Borra permanentemente un tenant: schema dedicado (si existe) + todas las
 * filas huérfanas en `public` + la fila de `tenants`.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string} opts.reason - 'manual_superadmin' | 'auto_30_dias_cancelacion' | etc, solo para el audit log
 * @param {string|null} opts.triggeredBy - id del usuario superadmin que la disparó (null si fue el job automático)
 */
async function purgeTenant(tenantId, { reason = 'manual', triggeredBy = null } = {}) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) {
    throw new Error(`Tenant "${tenantId}" no existe`);
  }

  const { id, slug, company_name, schema_name } = tenant;
  const report = {
    tenantId: id,
    slug,
    company_name,
    schema_name,
    publicTablesPurged: [],
    schemaDropped: false,
  };

  // El listado de tablas + orden de borrado se calcula ANTES de abrir la
  // transacción (son solo lecturas de information_schema, no hace falta
  // que compitan con los locks del borrado).
  const tables = await getTenantScopedTables();
  const orderedTables = await tablesInDeleteOrder(tables);

  const transaction = await sequelize.transaction();
  try {
    for (const table of orderedTables) {
      const [, meta] = await sequelize.query(
        `DELETE FROM "public"."${table}" WHERE tenant_id = :tenantId`,
        { replacements: { tenantId: id }, transaction }
      );
      const rowCount = meta?.rowCount ?? 0;
      if (rowCount > 0) report.publicTablesPurged.push({ table, rows: rowCount });
    }

    if (schema_name) {
      await sequelize.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`, { transaction });
      report.schemaDropped = true;
    }

    await Tenant.destroy({ where: { id }, transaction });

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  // Audit log FUERA de la transacción y con tenant_id null: los audit_logs
  // de este tenant ya se borraron en el barrido de arriba, así que este
  // registro queda a nivel de sistema como evidencia de que la purga ocurrió.
  try {
    const audit = require('../utils/audit');
    await audit({
      tenant_id: null,
      user_id: triggeredBy,
      action: 'tenant.purge',
      entity: 'Tenant',
      entity_id: id,
      changes: { company_name, slug, schema_name, reason, ...report },
    });
  } catch (e) {
    console.error('[tenantPurgeService] No se pudo registrar el audit log de purga:', e.message);
  }

  return report;
}

/**
 * Job automático: purga tenants cuya suscripción más reciente está
 * cancelada desde hace >= graceDays (política: 30 días).
 *
 * Desactivado por defecto -- se activa con ENABLE_TENANT_AUTOPURGE=true
 * (ver jobs/scheduler.js). Revisa doble: que la suscripción que cumplió
 * el plazo siga siendo la MÁS RECIENTE del tenant (por si reactivó después).
 */
async function purgeExpiredCancelledTenants({ graceDays = 30 } = {}) {
  const { Op } = require('sequelize');
  const TenantSubscription = require('../models/subscriptions/TenantSubscription');

  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  const candidates = await TenantSubscription.findAll({
    where: {
      status: 'cancelled',
      cancelled_at: { [Op.ne]: null, [Op.lte]: cutoff },
    },
    order: [['cancelled_at', 'ASC']],
  });

  const seenTenants = new Set();
  const results = [];

  for (const sub of candidates) {
    if (seenTenants.has(sub.tenant_id)) continue;
    seenTenants.add(sub.tenant_id);

    const tenant = await Tenant.findByPk(sub.tenant_id);
    if (!tenant) continue; // ya se borró en una corrida anterior

    const latestSub = await TenantSubscription.findOne({
      where: { tenant_id: tenant.id },
      order: [['created_at', 'DESC']],
    });
    if (
      !latestSub ||
      latestSub.status !== 'cancelled' ||
      !latestSub.cancelled_at ||
      new Date(latestSub.cancelled_at) > cutoff
    ) {
      continue; // reactivó, o la cancelación más reciente aún no cumple los 30 días
    }

    try {
      const report = await purgeTenant(tenant.id, { reason: 'auto_30_dias_cancelacion' });
      console.log(`🗑️  [tenant-auto-purge] Tenant "${tenant.slug}" purgado (cancelado desde ${latestSub.cancelled_at.toISOString()})`);
      results.push({ tenant: tenant.slug, status: 'purged', report });
    } catch (error) {
      console.error(`❌ [tenant-auto-purge] Error purgando tenant "${tenant.slug}":`, error.message);
      results.push({ tenant: tenant.slug, status: 'error', error: error.message });
    }
  }

  return results;
}

module.exports = { purgeTenant, purgeExpiredCancelledTenants };