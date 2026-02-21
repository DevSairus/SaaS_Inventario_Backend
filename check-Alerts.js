#!/usr/bin/env node

/**
 * Script de Verificación de Alertas de Stock
 * 
 * Ejecutar desde el directorio backend: node check-alerts.js
 */

const path = require('path');

// Determinar si estamos en backend o en la raíz
const isInBackend = __dirname.endsWith('backend');
const modelsPath = isInBackend 
  ? path.join(__dirname, 'src', 'models')
  : path.join(__dirname, 'backend', 'src', 'models');

console.log('📂 Directorio actual:', __dirname);
console.log('📂 Buscando modelos en:', modelsPath);

// Cargar modelos
const { sequelize, Product, StockAlert, Tenant } = require(modelsPath);
const { Op } = require('sequelize');

async function checkAlerts() {
  try {
    console.log('\n🔍 ===== VERIFICACIÓN DE ALERTAS DE STOCK =====\n');

    // Conectar a la base de datos
    await sequelize.authenticate();
    console.log('✅ Conexión a la base de datos establecida\n');

    // 1. Verificar tenants
    const tenants = await Tenant.findAll({
      attributes: ['id', 'company_name']
    });
    console.log(`📊 Tenants en el sistema: ${tenants.length}`);
    tenants.forEach(t => console.log(`   - ${t.company_name} (${t.id})`));

    if (tenants.length === 0) {
      console.log('\n❌ No hay tenants en el sistema. Verifica tu base de datos.\n');
      process.exit(1);
    }

    // 2. Para cada tenant, verificar productos
    for (const tenant of tenants) {
      console.log(`\n🏢 Verificando tenant: ${tenant.company_name}`);
      console.log('─'.repeat(60));

      // Productos totales
      const totalProducts = await Product.count({
        where: { tenant_id: tenant.id }
      });
      console.log(`   📦 Total de productos: ${totalProducts}`);

      if (totalProducts === 0) {
        console.log('   ⚠️  No hay productos en este tenant\n');
        continue;
      }

      // Productos con min_stock configurado
      const withMinStock = await Product.count({
        where: {
          tenant_id: tenant.id,
          min_stock: { [Op.not]: null, [Op.gt]: 0 }
        }
      });
      console.log(`   ⚙️  Productos con min_stock: ${withMinStock}`);

      if (withMinStock === 0) {
        console.log('\n   ⚠️  PROBLEMA ENCONTRADO: Ningún producto tiene min_stock configurado');
        console.log('   💡 SOLUCIÓN: Ejecuta este SQL:');
        console.log(`   
   UPDATE products 
   SET min_stock = 10, current_stock = 2
   WHERE tenant_id = '${tenant.id}'
   AND min_stock IS NULL
   LIMIT 10;
        `);
        continue;
      }

      // Productos con stock bajo (current_stock <= min_stock)
      const lowStockCount = await sequelize.query(`
        SELECT COUNT(*) as count
        FROM products
        WHERE tenant_id = :tenant_id
        AND min_stock IS NOT NULL
        AND min_stock > 0
        AND CAST(current_stock AS DECIMAL) <= CAST(min_stock AS DECIMAL)
      `, {
        replacements: { tenant_id: tenant.id },
        type: sequelize.QueryTypes.SELECT
      });
      
      const lowStockNumber = parseInt(lowStockCount[0].count);
      console.log(`   ⚠️  Productos con stock bajo: ${lowStockNumber}`);

      // Listar algunos productos con stock bajo
      if (lowStockNumber > 0) {
        const lowStockProducts = await sequelize.query(`
          SELECT name, sku, current_stock, min_stock
          FROM products
          WHERE tenant_id = :tenant_id
          AND min_stock IS NOT NULL
          AND min_stock > 0
          AND CAST(current_stock AS DECIMAL) <= CAST(min_stock AS DECIMAL)
          LIMIT 5
        `, {
          replacements: { tenant_id: tenant.id },
          type: sequelize.QueryTypes.SELECT
        });

        console.log('\n   📋 Ejemplos de productos con stock bajo:');
        lowStockProducts.forEach(p => {
          console.log(`      - ${p.name} (${p.sku}): Stock ${p.current_stock} / Min ${p.min_stock}`);
        });
      }

      // Alertas activas
      const activeAlerts = await StockAlert.count({
        where: { tenant_id: tenant.id, status: 'active' }
      });
      console.log(`\n   🔔 Alertas activas en la BD: ${activeAlerts}`);

      // Comparar: ¿Cuántas alertas DEBERÍAN existir vs cuántas existen?
      if (lowStockNumber > 0 && activeAlerts === 0) {
        console.log('\n   ❌ PROBLEMA: Hay productos con stock bajo pero NO hay alertas');
        console.log('   💡 SOLUCIÓN: Ve a la UI → Alertas de Stock → Clic en "Verificar Alertas"');
      } else if (lowStockNumber > 0 && activeAlerts > 0) {
        console.log(`   ✅ OK: Existen alertas para productos con stock bajo (${activeAlerts}/${lowStockNumber})`);
      } else if (lowStockNumber === 0 && activeAlerts === 0) {
        console.log('   ℹ️  No hay productos con stock bajo, por lo tanto no hay alertas');
      }

      // Si hay alertas, mostrar algunas
      if (activeAlerts > 0) {
        const alerts = await StockAlert.findAll({
          where: { tenant_id: tenant.id, status: 'active' },
          include: [{
            model: Product,
            as: 'product',
            attributes: ['name', 'sku']
          }],
          limit: 5
        });

        console.log('\n   📋 Ejemplos de alertas activas:');
        alerts.forEach(a => {
          console.log(`      - ${a.product?.name || 'N/A'} (${a.alert_type}) - ${a.severity}`);
        });
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Diagnóstico completado\n');

    // Cerrar conexión
    await sequelize.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error durante la verificación:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Ejecutar
checkAlerts();