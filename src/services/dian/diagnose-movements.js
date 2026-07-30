// Script de diagnóstico para verificar movimientos de inventario
require('dotenv').config();
const { sequelize } = require('../../src/config/database');
const { QueryTypes } = require('sequelize');

// Herramienta de diagnóstico manual (node services/dian/diagnose-movements.js),
// no forma parte del flujo de la app -- corre por fuera de cualquier request
// HTTP, así que no hay contexto de tenant (AsyncLocalStorage) disponible y no
// se puede usar getCurrentSchema() como en los controllers. Antes, todas las
// queries apuntaban solo a "public" -- desde que hay tenants en modo
// schema-per-tenant, eso da un diagnóstico incompleto (o directamente
// engañoso: "0 movimientos" para un tenant que sí tiene datos, solo que en
// su propio schema). Ahora recorre "public" + cada schema de tenant
// provisionado y reporta cada uno por separado.
async function countIn(schema, table, extraWhere = '') {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) as count FROM "${schema}"."${table}" ${extraWhere}`,
    { type: QueryTypes.SELECT }
  );
  return Number(row.count);
}

async function diagnosticarSchema(schema, label) {
  console.log(`\n=====================================================`);
  console.log(`📁 Schema: ${schema}  (${label})`);
  console.log(`=====================================================`);

  const totalMovimientos = await countIn(schema, 'inventory_movements');
  console.log('📊 Total de movimientos:', totalMovimientos);

  if (totalMovimientos === 0) return;

  const movimientosPorTenant = await sequelize.query(
    `SELECT tenant_id, COUNT(*) as count FROM "${schema}"."inventory_movements" GROUP BY tenant_id`,
    { type: QueryTypes.SELECT }
  );
  console.log('\n📊 Movimientos por tenant:');
  console.table(movimientosPorTenant);

  const movimientosPorTipo = await sequelize.query(
    `SELECT movement_type, COUNT(*) as count FROM "${schema}"."inventory_movements" GROUP BY movement_type`,
    { type: QueryTypes.SELECT }
  );
  console.log('\n📊 Movimientos por tipo:');
  console.table(movimientosPorTipo);

  const ultimosMovimientos = await sequelize.query(
    `SELECT
      id, tenant_id, product_id, warehouse_id, movement_type,
      quantity, movement_date, movement_reason, reference_type, reference_id
    FROM "${schema}"."inventory_movements"
    ORDER BY movement_date DESC
    LIMIT 10`,
    { type: QueryTypes.SELECT }
  );
  console.log('\n📊 Últimos 10 movimientos:');
  console.table(ultimosMovimientos);

  const reporteResultado = await sequelize.query(
    `SELECT
      TO_CHAR(movement_date, 'YYYY-MM') as month,
      movement_type,
      SUM(quantity)::numeric as total_quantity,
      COUNT(*)::integer as total_movements
    FROM "${schema}"."inventory_movements"
    WHERE movement_date >= NOW() - INTERVAL '6 months'
    GROUP BY TO_CHAR(movement_date, 'YYYY-MM'), movement_type
    ORDER BY month DESC`,
    { type: QueryTypes.SELECT }
  );
  console.log('\n📊 Simulando consulta del reporte (últimos 6 meses):');
  console.table(reporteResultado);

  console.log('\n📊 Total de productos:', await countIn(schema, 'products'));
  console.log('📊 Total de ventas:', await countIn(schema, 'sales'));
  console.log('📊 Total de compras:', await countIn(schema, 'purchases'));
}

async function diagnosticar() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos');

    // Tenants y sus schemas viven siempre en public, sin importar el modo
    // de cada tenant -- esto no cambia con schema-per-tenant.
    const tenants = await sequelize.query(
      'SELECT id, name, schema_name FROM public.tenants ORDER BY name ASC',
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Tenants en el sistema:');
    console.table(tenants);

    await diagnosticarSchema('public', 'tenants en modo legado + catálogos globales');

    const schemasATenant = tenants.filter((t) => t.schema_name);
    for (const t of schemasATenant) {
      await diagnosticarSchema(t.schema_name, t.name);
    }

    console.log('\n✅ Diagnóstico completado');
  } catch (error) {
    console.error('❌ Error en diagnóstico:', error.message);
    console.error(error);
  } finally {
    await sequelize.close();
  }
}

diagnosticar();
