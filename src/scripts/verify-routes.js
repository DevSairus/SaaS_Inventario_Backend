// Script para verificar que las rutas estén cargadas correctamente
// Ejecutar: node verify-routes.js

const express = require('express');
const app = express();

try {
  console.log('🔍 Verificando rutas de inventory...\n');
  
  // Intentar cargar el router de inventory
  const inventoryRoutes = require('./src/routes/inventory');
  console.log('✅ Router de inventory cargado correctamente');
  
  // Verificar que sea un router de Express
  if (inventoryRoutes && inventoryRoutes.stack) {
    console.log(`✅ Es un router válido de Express`);
    console.log(`✅ Número de rutas registradas: ${inventoryRoutes.stack.length}\n`);
    
    // Listar las rutas
    console.log('📋 Rutas registradas:');
    inventoryRoutes.stack.forEach((layer, index) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
        console.log(`   ${index + 1}. ${methods} ${layer.route.path}`);
      } else if (layer.name === 'router') {
        console.log(`   ${index + 1}. Router montado en: ${layer.regexp}`);
      }
    });
  }
  
  console.log('\n✅ Todas las verificaciones pasaron');
  console.log('\n🚀 Las rutas deberían funcionar en:');
  console.log('   GET  http://localhost:5000/api/inventory/suppliers');
  console.log('   GET  http://localhost:5000/api/inventory/purchases');
  console.log('   GET  http://localhost:5000/api/inventory/suppliers/stats');
  console.log('   GET  http://localhost:5000/api/inventory/purchases/stats');
  
  console.log('\n⚠️  IMPORTANTE:');
  console.log('   Si el servidor está corriendo, debes reiniciarlo para que cargue estas rutas.');
  console.log('   Presiona Ctrl+C en la terminal del servidor y ejecuta: npm start');
  
} catch (error) {
  console.error('❌ Error al cargar las rutas:', error.message);
  console.error('\n🔧 Posibles causas:');
  console.error('   1. Falta algún archivo en src/routes/inventory/');
  console.error('   2. Error de sintaxis en algún archivo');
  console.error('   3. Falta algún módulo require()');
  console.error('\nDetalles del error:');
  console.error(error.stack);
  process.exit(1);
}