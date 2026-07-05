// backend/src/middleware/autoCheckAlerts.middleware.js
const { StockAlert, Product } = require('../models');
const { Op } = require('sequelize');

/**
 * Middleware para verificar y crear alertas automáticamente
 * después de operaciones que modifiquen el stock
 */

/**
 * Verificar alertas para un producto específico
 */
async function checkAlertsForProduct(product_id, tenant_id) {
  try {
    // Obtener producto
    const product = await Product.findOne({
      where: { id: product_id, tenant_id },
      attributes: ['id', 'name', 'sku', 'current_stock', 'min_stock', 'max_stock']
    });

    if (!product || !product.min_stock || product.min_stock <= 0) {
      return; // Sin min_stock configurado, no hacer nada
    }

    const currentStock = parseFloat(product.current_stock) || 0;
    const minStock = parseFloat(product.min_stock) || 0;
    const maxStock = product.max_stock ? parseFloat(product.max_stock) : null;

    let alertType = null;
    let severity = null;

    // Determinar tipo de alerta
    if (currentStock <= 0) {
      alertType = 'out_of_stock';
      severity = 'critical';
    } else if (currentStock <= minStock) {
      alertType = 'low_stock';
      severity = 'warning';
    } else if (maxStock && currentStock >= maxStock) {
      alertType = 'overstock';
      severity = 'info';
    }

    if (alertType) {
      // Verificar si ya existe una alerta activa del mismo tipo
      const existingAlert = await StockAlert.findOne({
        where: {
          tenant_id,
          product_id: product.id,
          alert_type: alertType,
          status: 'active'
        }
      });

      if (!existingAlert) {
        // Crear nueva alerta
        await StockAlert.create({
          tenant_id,
          product_id: product.id,
          alert_type: alertType,
          severity,
          current_stock: currentStock,
          min_stock: minStock,
          max_stock: maxStock,
          status: 'active'
        });
        console.log(`✅ Alerta automática creada: ${product.name} - ${alertType}`);
      } else {
        // Actualizar stock actual en la alerta existente
        await existingAlert.update({
          current_stock: currentStock,
          severity: severity
        });
      }
    } else {
      // Si el stock está bien, resolver alertas activas
      await StockAlert.update(
        {
          status: 'resolved',
          resolved_date: new Date(),
          resolution_notes: 'Stock normalizado automáticamente'
        },
        {
          where: {
            tenant_id,
            product_id: product.id,
            status: 'active'
          }
        }
      );
    }
  } catch (error) {
    console.error('Error en checkAlertsForProduct:', error);
    // No lanzar error para no interrumpir la operación principal
  }
}

/**
 * Verificar alertas para múltiples productos
 */
async function checkAlertsForProducts(product_ids, tenant_id) {
  try {
    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return;
    }

    for (const product_id of product_ids) {
      await checkAlertsForProduct(product_id, tenant_id);
    }
  } catch (error) {
    console.error('Error en checkAlertsForProducts:', error);
  }
}

/**
 * Verificar alertas de TODOS los productos (todos los tenants).
 * Pensado como red de seguridad para un cron job periódico.
 */
async function checkAllStockAlerts() {
  const products = await Product.findAll({
    where: { min_stock: { [Op.not]: null, [Op.gt]: 0 } },
    attributes: ['id', 'tenant_id']
  });

  for (const product of products) {
    await checkAlertsForProduct(product.id, product.tenant_id);
  }

  return { products_checked: products.length };
}

/**
 * Middleware que se ejecuta después de operaciones de inventario
 * Uso: router.post('/ruta', middleware, autoCheckAlerts);
 */
const autoCheckAlerts = async (req, res, next) => {
  // Este middleware se ejecuta DESPUÉS de la operación principal
  // Los datos relevantes deben estar en res.locals
  
  try {
    const { product_id, product_ids, tenant_id } = res.locals.alertCheck || {};
    
    if (!tenant_id) return next();

    if (product_id) {
      // Verificar alerta para un solo producto
      await checkAlertsForProduct(product_id, tenant_id);
    } else if (product_ids && Array.isArray(product_ids)) {
      // Verificar alertas para múltiples productos
      await checkAlertsForProducts(product_ids, tenant_id);
    }
    
    next();
  } catch (error) {
    console.error('Error en autoCheckAlerts middleware:', error);
    next(); // Continuar aunque falle la verificación de alertas
  }
};

/**
 * Función helper para marcar productos que necesitan verificación
 * Ejecuta la verificación directamente via setImmediate (fuera del request cycle)
 */
function markForAlertCheck(res, product_id, tenant_id) {
  setImmediate(async () => {
    try {
      await checkAlertsForProduct(product_id, tenant_id);
    } catch (err) {
      console.error('[AlertCheck] Error verificando alertas:', err.message);
    }
  });
}

/**
 * Función helper para marcar múltiples productos
 */
function markProductsForAlertCheck(res, product_ids, tenant_id) {
  setImmediate(async () => {
    try {
      await checkAlertsForProducts(product_ids, tenant_id);
    } catch (err) {
      console.error('[AlertCheck] Error verificando alertas:', err.message);
    }
  });
}

module.exports = {
  autoCheckAlerts,
  checkAlertsForProduct,
  checkAlertsForProducts,
  checkAllStockAlerts,
  markForAlertCheck,
  markProductsForAlertCheck
};