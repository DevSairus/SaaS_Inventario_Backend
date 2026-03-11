// Script de diagnóstico para verificar movimientos de inventario
require('dotenv').config();
const { sequelize } = require('../../src/config/database');
const { QueryTypes } = require('sequelize');

async function diagnosticar() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos\n');

    // 1. Verificar si existen movimientos
    const totalMovimientos = await sequelize.query(
      'SELECT COUNT(*) as count FROM inventory_movements',
      { type: QueryTypes.SELECT }
    );
    console.log('📊 Total de movimientos en la BD:', totalMovimientos[0].count);

    // 2. Ver movimientos por tenant
    const movimientosPorTenant = await sequelize.query(
      'SELECT tenant_id, COUNT(*) as count FROM inventory_movements GROUP BY tenant_id',
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Movimientos por tenant:');
    console.table(movimientosPorTenant);

    // 3. Ver movimientos por tipo
    const movimientosPorTipo = await sequelize.query(
      'SELECT movement_type, COUNT(*) as count FROM inventory_movements GROUP BY movement_type',
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Movimientos por tipo:');
    console.table(movimientosPorTipo);

    // 4. Ver últimos 10 movimientos
    const ultimosMovimientos = await sequelize.query(
      `SELECT 
        id,
        tenant_id,
        product_id,
        warehouse_id,
        movement_type,
        quantity,
        movement_date,
        movement_reason,
        reference_type,
        reference_id
      FROM inventory_movements 
      ORDER BY movement_date DESC 
      LIMIT 10`,
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Últimos 10 movimientos:');
    console.table(ultimosMovimientos);

    // 5. Simular consulta del reporte (últimos 6 meses)
    console.log('\n📊 Simulando consulta del reporte (últimos 6 meses):');
    const reporteQuery = `
      SELECT 
        TO_CHAR(movement_date, 'YYYY-MM') as month,
        movement_type,
        SUM(quantity)::numeric as total_quantity,
        COUNT(*)::integer as total_movements
      FROM inventory_movements
      WHERE movement_date >= NOW() - INTERVAL '6 months'
      GROUP BY TO_CHAR(movement_date, 'YYYY-MM'), movement_type
      ORDER BY month DESC
    `;
    
    const reporteResultado = await sequelize.query(reporteQuery, {
      type: QueryTypes.SELECT
    });
    
    console.log('Resultado del reporte:');
    console.table(reporteResultado);

    // 6. Ver si hay tenants
    const tenants = await sequelize.query(
      'SELECT id, name FROM tenants',
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Tenants en el sistema:');
    console.table(tenants);

    // 7. Ver productos
    const productos = await sequelize.query(
      'SELECT COUNT(*) as count FROM products',
      { type: QueryTypes.SELECT }
    );
    console.log('\n📊 Total de productos:', productos[0].count);

    // 8. Ver ventas
    const ventas = await sequelize.query(
      'SELECT COUNT(*) as count FROM sales',
      { type: QueryTypes.SELECT }
    );
    console.log('📊 Total de ventas:', ventas[0].count);

    // 9. Ver compras
    const compras = await sequelize.query(
      'SELECT COUNT(*) as count FROM purchases',
      { type: QueryTypes.SELECT }
    );
    console.log('📊 Total de compras:', compras[0].count);

    console.log('\n✅ Diagnóstico completado');

  } catch (error) {
    console.error('❌ Error en diagnóstico:', error.message);
    console.error(error);
  } finally {
    await sequelize.close();
  }
}

diagnosticar();