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
const {
  discoverTenantTables,
  tablesInOrder,
  buildIndirectOrExistsSql,
} = require('../scripts/tenantScopedTables');

// Nombre estándar del schema de un tenant (misma regla que
// scripts/provisionTenantSchema.js#schemaNameFor, sin cargar ese script).
const schemaNameFor = (slug) => `tenant_${slug.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
// Nombre de schema válido para borrar: nunca public ni nada fuera de tenant_*.
const TENANT_SCHEMA_RE = /^tenant_[a-z0-9_]+$/;
const MAX_FK_FIXES = 500;

/**
 * DELETE de `"schema"."table" t0 WHERE <where>` resolviendo las FKs que lo
 * bloquean (23503) en vez de abortar la purga.
 *
 * Por qué: muchas tablas apuntan a public.users / public.tenants sin ON DELETE
 * (audit_logs.user_id, created_by de todo tipo, también desde los schemas de
 * otras empresas): eliminar una empresa fallaba con "users violates foreign
 * key constraint audit_logs_user_id_fkey". Recorrer de antemano esas ~1.300
 * FKs sería lento, así que se intenta el DELETE dentro de un SAVEPOINT y, si
 * una FK lo bloquea, se arregla esa FK puntual y se reintenta:
 *   - columna que acepta NULL -> se pone en NULL (p. ej. un audit_log de
 *     plataforma que registra a un usuario de esta empresa: se conserva);
 *   - columna NOT NULL -> se borran esas filas hijas, con la misma regla.
 * `where` usa el alias t0 para la tabla que se borra.
 */
async function deleteResolvingFks({ schema, table, where, replacements, transaction, report, depth = 0 }) {
  if (depth > 6) throw new Error(`Cadena de referencias demasiado profunda al borrar "${schema}"."${table}"`);
  const fixed = new Set();
  for (let i = 0; i < MAX_FK_FIXES; i++) {
    await sequelize.query('SAVEPOINT tenant_purge', { transaction });
    try {
      const [, meta] = await sequelize.query(
        `DELETE FROM "${schema}"."${table}" t0 WHERE ${where}`,
        { replacements, transaction }
      );
      await sequelize.query('RELEASE SAVEPOINT tenant_purge', { transaction });
      return meta?.rowCount ?? 0;
    } catch (error) {
      await sequelize.query('ROLLBACK TO SAVEPOINT tenant_purge', { transaction });
      await sequelize.query('RELEASE SAVEPOINT tenant_purge', { transaction });
      const pg = error.parent || error.original || {};
      if (pg.code !== '23503' || !pg.constraint || !pg.table) throw error;
      const childSchema = pg.schema || 'public';
      const key = `${childSchema}.${pg.table}.${pg.constraint}`;
      if (fixed.has(key)) throw error; // ya se arregló y sigue bloqueando: no insistir
      fixed.add(key);

      const [cols] = await sequelize.query(`
        SELECT ca.attname AS child_column, NOT ca.attnotnull AS nullable, pa.attname AS parent_column
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(child_attnum, parent_attnum)
        JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_attnum
        JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_attnum
        WHERE con.contype = 'f' AND con.conname = :name AND n.nspname = :schema AND c.relname = :table
      `, { replacements: { name: pg.constraint, schema: childSchema, table: pg.table }, transaction });
      if (cols.length !== 1) throw error; // FK compuesta: no se adivina

      const { child_column: childCol, nullable, parent_column: parentCol } = cols[0];
      const childWhere = `t0."${childCol}" IN (SELECT t0."${parentCol}" FROM "${schema}"."${table}" t0 WHERE ${where})`;
      if (nullable) {
        const [, meta] = await sequelize.query(
          `UPDATE "${childSchema}"."${pg.table}" t0 SET "${childCol}" = NULL WHERE ${childWhere}`,
          { replacements, transaction }
        );
        report.referencesCleared.push({ table: `${childSchema}.${pg.table}`, column: childCol, rows: meta?.rowCount ?? 0 });
      } else {
        const rows = await deleteResolvingFks({
          schema: childSchema, table: pg.table, where: childWhere, replacements, transaction, report, depth: depth + 1,
        });
        report.referencesDeleted.push({ table: `${childSchema}.${pg.table}`, column: childCol, rows });
      }
    }
  }
  throw new Error(`Demasiadas referencias al borrar "${schema}"."${table}"`);
}

/**
 * Schemas a borrar: el de tenants.schema_name y, si existe, el de nombre
 * estándar tenant_<slug> (queda tras un rollback, con schema_name ya en NULL),
 * siempre que no sea de otra empresa.
 */
async function schemasToDrop({ id, slug, schema_name }) {
  const candidates = [...new Set([schema_name, slug ? schemaNameFor(slug) : null].filter(Boolean))];
  const result = [];
  for (const name of candidates) {
    if (!TENANT_SCHEMA_RE.test(name)) {
      throw new Error(`Nombre de schema inesperado "${name}": no se borra nada`);
    }
    const [[exists]] = await sequelize.query(
      'SELECT 1 AS ok FROM pg_namespace WHERE nspname = :name', { replacements: { name } }
    );
    if (!exists) continue;
    const [[owner]] = await sequelize.query(
      'SELECT slug FROM public.tenants WHERE schema_name = :name AND id <> :id LIMIT 1',
      { replacements: { name, id } }
    );
    if (owner) throw new Error(`El schema "${name}" pertenece a la empresa "${owner.slug}": no se borra`);
    result.push(name);
  }
  return result;
}

// El descubrimiento de tablas (directas + indirectas por FK transitiva) vive
// en scripts/tenantScopedTables.js, compartido con migrateTenantData.js y
// cleanupTenantPublicData.js. Antes, este servicio solo veía tablas con
// tenant_id propio -- una tabla como customer_return_items (relacionada solo
// vía sale_items.sale_item_id) quedaba sin borrar de public, y el DELETE de
// sale_items reventaba con violación de FK exactamente igual que en
// cleanupTenantPublicData.js.

/**
 * Borra permanentemente un tenant: schema dedicado (si existe) + todas sus
 * filas en `public` (negocio, usuarios, suscripciones) + la fila de `tenants`.
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
    schemasDropped: [],
    publicTablesPurged: [],
    usersDeleted: 0,
    referencesCleared: [],
    referencesDeleted: [],
  };

  // Schemas, tablas y orden de borrado se calculan ANTES de abrir la
  // transacción (solo lecturas de pg_catalog).
  const schemas = await schemasToDrop(tenant);
  const { directTables, indirectTables, resolutionChains } = await discoverTenantTables(sequelize);
  const indirectSet = new Set(indirectTables);
  const orderedTables = await tablesInOrder(sequelize, [...directTables, ...indirectTables], { forDelete: true });
  const replacements = { tenantId: id };

  // Todo en UNA transacción (en Postgres el DROP SCHEMA también es
  // transaccional): si algo falla no queda la empresa borrada a medias.
  const transaction = await sequelize.transaction();
  try {
    // 1. Primero el schema: se lleva los datos reales y, con ellos, sus FKs
    // hacia public.users, que si no bloquean el borrado de los usuarios.
    for (const name of schemas) {
      await sequelize.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`, { transaction });
      report.schemasDropped.push(name);
    }

    // 2. Filas del tenant que queden en public (modo legado, copia vieja de
    // antes del corte, tablas fijas de public como soporte).
    for (const table of orderedTables) {
      const where = indirectSet.has(table)
        ? buildIndirectOrExistsSql(table, resolutionChains, 'public', 't0')
        : 't0.tenant_id = :tenantId';
      const rows = await deleteResolvingFks({ schema: 'public', table, where, replacements, transaction, report });
      if (rows > 0) report.publicTablesPurged.push({ table, rows });
    }

    // 3. Usuarios: pueden seguir referenciados desde registros de plataforma
    // o de otras empresas (audit_logs, soporte...); se sueltan o se borran.
    report.usersDeleted = await deleteResolvingFks({
      schema: 'public', table: 'users', where: 't0.tenant_id = :tenantId', replacements, transaction, report,
    });

    // 4. La empresa (suscripciones y demás caen por ON DELETE CASCADE o se
    // resuelven igual).
    await deleteResolvingFks({
      schema: 'public', table: 'tenants', where: 't0.id = :tenantId', replacements, transaction, report,
    });

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