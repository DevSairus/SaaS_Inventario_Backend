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
      attributes: ['id', 'name', 'sku', 'current_stock', 'min_stock', 'max_stock', 'track_inventory']
    });

    if (!product || product.track_inventory === false) {
      return; // Producto no rastreado por inventario, no aplica
    }

    const currentStock = parseFloat(product.current_stock) || 0;
    const minStock = parseFloat(product.min_stock) || 0;
    const maxStock = product.max_stock ? parseFloat(product.max_stock) : null;

    let alertType = null;
    let severity = null;

    // Determinar tipo de alerta
    // "Sin stock" no depende de tener min_stock configurado: 0 unidades es
    // crítico siempre. "Stock bajo" y "sobrestock" sí necesitan un umbral
    // (min_stock/max_stock) configurado para tener sentido -- si no hay
    // umbral, se compara contra 0 y siempre daría falso.
    if (currentStock <= 0) {
      alertType = 'out_of_stock';
      severity = 'critical';
    } else if (minStock > 0 && currentStock <= minStock) {
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
 *
 * Corre fuera de cualquier request HTTP, así que no hay contexto de tenant
 * (AsyncLocalStorage) disponible por defecto -- sin esto, esta función
 * siempre terminaba leyendo solo `public.products` (Sequelize cae al
 * search_path por defecto de la conexión cuando no hay schema activo), así
 * que para cualquier tenant ya cortado a su propio schema, sus productos
 * quedaban completamente invisibles para el chequeo de alertas, en
 * silencio -- no error, simplemente 0 alertas generadas.
 */
async function checkAllStockAlerts() {
  const { Tenant } = require('../models');
  const { runWithTenantSchema } = require('../config/tenantContext');

  const tenants = await Tenant.findAll({ attributes: ['id', 'schema_name'] });
  let totalChecked = 0;

  // Tenants en modo legado (schema_name null): sus productos siguen en
  // `public`, se pueden revisar todos juntos filtrando por sus tenant_id.
  const legacyTenantIds = tenants.filter((t) => !t.schema_name).map((t) => t.id);
  if (legacyTenantIds.length > 0) {
    const legacyProducts = await Product.findAll({
      where: {
        tenant_id: legacyTenantIds,
        track_inventory: true,
        [Op.or]: [{ min_stock: { [Op.gt]: 0 } }, { current_stock: { [Op.lte]: 0 } }]
      },
      attributes: ['id', 'tenant_id']
    });
    for (const product of legacyProducts) {
      await checkAlertsForProduct(product.id, product.tenant_id);
    }
    totalChecked += legacyProducts.length;
  }

  // Tenants ya cortados a su propio schema: cada uno necesita correr dentro
  // de su propio runWithTenantSchema para que los modelos (Product,
  // StockAlert) resuelvan contra el schema correcto.
  const schemaTenants = tenants.filter((t) => t.schema_name);
  for (const tenant of schemaTenants) {
    try {
      await runWithTenantSchema(tenant.schema_name, async () => {
        const products = await Product.findAll({
          where: {
            tenant_id: tenant.id,
            track_inventory: true,
            [Op.or]: [{ min_stock: { [Op.gt]: 0 } }, { current_stock: { [Op.lte]: 0 } }]
          },
          attributes: ['id', 'tenant_id']
        });
        for (const product of products) {
          await checkAlertsForProduct(product.id, product.tenant_id);
        }
        totalChecked += products.length;
      });
    } catch (error) {
      console.error(`Error revisando alertas de stock para tenant "${tenant.schema_name}":`, error.message);
    }
  }

  return { products_checked: totalChecked, tenants_checked: tenants.length };
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