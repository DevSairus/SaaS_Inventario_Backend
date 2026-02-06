/**
 * Script para verificar y corregir precios de productos
 * 
 * Este script:
 * 1. Encuentra productos sin margen de ganancia configurado
 * 2. Les asigna un margen de ganancia por defecto (30%)
 * 3. Recalcula el precio de venta basado en el costo promedio
 * 4. Muestra un reporte de productos actualizados
 */

const { Product } = require('../models');
const { Op } = require('sequelize');


async function fixProductPrices() {
  try {
    console.log('🔍 Iniciando verificación de precios de productos...\n');

    // 1. Productos sin margen de ganancia
    const productsWithoutMargin = await Product.findAll({
      where: {
        [Op.or]: [
          { profit_margin_percentage: null },
          { profit_margin_percentage: 0 }
        ],
        is_active: true
      }
    });

    console.log(`📊 Productos sin margen de ganancia: ${productsWithoutMargin.length}`);

    if (productsWithoutMargin.length > 0) {
      console.log('\n🔧 Asignando margen de ganancia por defecto (30%)...\n');
      
      for (const product of productsWithoutMargin) {
        const defaultMargin = 30;
        const averageCost = parseFloat(product.average_cost || 0);
        const newBasePrice = averageCost > 0 ? averageCost * (1 + defaultMargin / 100) : 0;

        await product.update({
          profit_margin_percentage: defaultMargin,
          base_price: newBasePrice
        });

        console.log(`✅ ${product.name} (SKU: ${product.sku})`);
        console.log(`   - Margen: ${defaultMargin}%`);
        console.log(`   - Costo promedio: $${averageCost.toFixed(2)}`);
        console.log(`   - Precio base: $${newBasePrice.toFixed(2)}\n`);
      }
    }

    // 2. Productos con costo promedio pero precio base en 0
    const productsWithCostButNoPrice = await Product.findAll({
      where: {
        average_cost: { [Op.gt]: 0 },
        base_price: 0,
        profit_margin_percentage: { [Op.gt]: 0 },
        is_active: true
      }
    });

    console.log(`\n📊 Productos con costo pero sin precio base: ${productsWithCostButNoPrice.length}`);

    if (productsWithCostButNoPrice.length > 0) {
      console.log('\n🔧 Recalculando precios base...\n');

      for (const product of productsWithCostButNoPrice) {
        const margin = parseFloat(product.profit_margin_percentage);
        const averageCost = parseFloat(product.average_cost);
        const newBasePrice = averageCost * (1 + margin / 100);

        await product.update({
          base_price: newBasePrice
        });

        console.log(`✅ ${product.name} (SKU: ${product.sku})`);
        console.log(`   - Margen: ${margin}%`);
        console.log(`   - Costo promedio: $${averageCost.toFixed(2)}`);
        console.log(`   - Precio base actualizado: $${newBasePrice.toFixed(2)}\n`);
      }
    }

    // 3. Reporte final
    console.log('\n📊 REPORTE FINAL\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const allActiveProducts = await Product.findAll({
      where: { is_active: true }
    });

    const stats = {
      total: allActiveProducts.length,
      withMargin: 0,
      withCost: 0,
      withPrice: 0,
      ready: 0
    };

    for (const product of allActiveProducts) {
      if (product.profit_margin_percentage && parseFloat(product.profit_margin_percentage) > 0) {
        stats.withMargin++;
      }
      if (product.average_cost && parseFloat(product.average_cost) > 0) {
        stats.withCost++;
      }
      if (product.base_price && parseFloat(product.base_price) > 0) {
        stats.withPrice++;
      }
      if (
        product.profit_margin_percentage && parseFloat(product.profit_margin_percentage) > 0 &&
        product.average_cost && parseFloat(product.average_cost) > 0 &&
        product.base_price && parseFloat(product.base_price) > 0
      ) {
        stats.ready++;
      }
    }

    console.log(`Total de productos activos: ${stats.total}`);
    console.log(`Con margen de ganancia: ${stats.withMargin} (${((stats.withMargin/stats.total)*100).toFixed(1)}%)`);
    console.log(`Con costo promedio: ${stats.withCost} (${((stats.withCost/stats.total)*100).toFixed(1)}%)`);
    console.log(`Con precio base: ${stats.withPrice} (${((stats.withPrice/stats.total)*100).toFixed(1)}%)`);
    console.log(`Completamente configurados: ${stats.ready} (${((stats.ready/stats.total)*100).toFixed(1)}%)`);

    console.log('\n✅ Proceso completado exitosamente\n');

  } catch (error) {
    console.error('❌ Error al procesar productos:', error);
    throw error;
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  fixProductPrices()
    .then(() => {
      console.log('Script finalizado');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error fatal:', error);
      process.exit(1);
    });
}

module.exports = { fixProductPrices };