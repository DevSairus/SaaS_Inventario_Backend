// backend/src/middleware/autoCheckAlerts.middleware.js
const { StockAlert, Product } = require('../models');
const { Op } = require('sequelize');

/**
 * Middleware para verificar y crear alertas automáticamente
 * después de operaciones que modifiquen el stock
 */

/**
 * Determina qué alerta (si alguna) corresponde al stock actual del producto.
 * "Sin stock" no depende de tener min_stock configurado: 0 unidades es
 * crítico siempre. "Stock bajo" y "sobrestock" sí necesitan un umbral
 * (min_stock/max_stock) configurado para tener sentido -- si no hay
 * umbral, se compara contra 0 y siempre daría falso.
 */
function classifyStock(product) {
  const currentStock = parseFloat(product.current_stock) || 0;
  const minStock = parseFloat(product.min_stock) || 0;
  const maxStock = product.max_stock ? parseFloat(product.max_stock) : null;

  let alertType = null;
  let severity = null;
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
  return { currentStock, minStock, maxStock, alertType, severity };
}

const NOT_APPLICABLE_NOTE = 'No aplica: producto sin compras ni entradas de inventario registradas';

/**
 * De los productos dados, cuáles "manejan stock" de verdad: tienen o tuvieron
 * existencias. Muchos productos se crean solo como ficha (catálogo, precios,
 * referencia) sin haber comprado nunca una unidad, y antes generaban una
 * alerta "sin stock" cada uno — puro ruido (en un tenant real: 5.812 de
 * 5.813 alertas "sin stock" eran de productos sin ninguna entrada).
 *
 * Un producto aplica para alertas si cumple cualquiera de:
 *  - tuvo algún movimiento de inventario de entrada (direction='in': compra
 *    recibida, ajuste, saldo inicial, devolución de cliente, traslado...),
 *  - aparece en una compra confirmada/recibida (no borrador ni anulada),
 *  - tiene stock > 0 hoy (ej. importado con existencias sin movimiento).
 *
 * @param {Array<{id, current_stock}>} products
 * @returns {Promise<Set<string>>} ids que aplican
 */
async function productsWithEntries(products) {
  const { InventoryMovement, PurchaseItem, Purchase } = require('../models');
  const result = new Set(products.filter((p) => (parseFloat(p.current_stock) || 0) > 0).map((p) => p.id));
  const pending = products.map((p) => p.id).filter((id) => !result.has(id));
  // Por lotes: el IN (...) de miles de UUIDs en una sola query es pesado.
  for (let i = 0; i < pending.length; i += 1000) {
    const ids = pending.slice(i, i + 1000);
    const [moved, purchased] = await Promise.all([
      InventoryMovement.findAll({
        where: { product_id: ids, direction: 'in' },
        attributes: ['product_id'],
        group: ['product_id'],
        raw: true,
      }),
      PurchaseItem.findAll({
        where: { product_id: ids },
        attributes: ['product_id'],
        include: [{ model: Purchase, as: 'purchase', attributes: [], where: { status: { [Op.notIn]: ['draft', 'cancelled'] } } }],
        group: ['PurchaseItem.product_id'],
        raw: true,
      }),
    ]);
    for (const r of moved) result.add(r.product_id);
    for (const r of purchased) result.add(r.product_id);
  }
  return result;
}

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

    if (!product) return;
    if (product.track_inventory === false) {
      // No controla inventario: no aplica, y se cierra cualquier alerta previa.
      await StockAlert.update(
        { status: 'resolved', resolved_date: new Date(), resolution_notes: 'No aplica: el producto no controla inventario' },
        { where: { tenant_id, product_id: product.id, status: 'active' } }
      );
      return;
    }

    // Producto solo-ficha (nunca tuvo entradas): no aplica, y se cierran las
    // alertas que hubiera de antes.
    const applies = (await productsWithEntries([product])).has(product.id);
    if (!applies) {
      await StockAlert.update(
        { status: 'resolved', resolved_date: new Date(), resolution_notes: NOT_APPLICABLE_NOTE },
        { where: { tenant_id, product_id: product.id, status: 'active' } }
      );
      return;
    }

    const { currentStock, minStock, maxStock, alertType, severity } = classifyStock(product);

    if (alertType) {
      // Cerrar alertas activas de otro tipo (ej. "stock bajo" que quedó
      // activa cuando el producto ya pasó a "sin stock").
      await StockAlert.update(
        { status: 'resolved', resolved_date: new Date(), resolution_notes: 'Reemplazada por una alerta de otro tipo' },
        { where: { tenant_id, product_id: product.id, status: 'active', alert_type: { [Op.ne]: alertType } } }
      );

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
    totalChecked += (await syncStockAlertsForTenants(legacyTenantIds)).checked;
  }

  // Tenants ya cortados a su propio schema: cada uno necesita correr dentro
  // de su propio runWithTenantSchema para que los modelos (Product,
  // StockAlert) resuelvan contra el schema correcto.
  const schemaTenants = tenants.filter((t) => t.schema_name);
  for (const tenant of schemaTenants) {
    try {
      await runWithTenantSchema(tenant.schema_name, async () => {
        totalChecked += (await syncStockAlertsForTenants([tenant.id])).checked;
      });
    } catch (error) {
      console.error(`Error revisando alertas de stock para tenant "${tenant.schema_name}":`, error.message);
    }
  }

  return { products_checked: totalChecked, tenants_checked: tenants.length };
}

/**
 * Misma lógica que checkAlertsForProduct, pero por lotes: antes el cron
 * llamaba a checkAlertsForProduct() producto por producto (3-4 queries
 * secuenciales cada uno, releyendo el producto que ya se tenía), y con
 * miles de productos la corrida tardaba ~40 min. Todo ese tiempo la
 * transacción del advisory lock del scheduler (ver utils/advisoryLock.js)
 * quedaba abierta sin uso, Neon terminaba cortando esa conexión y el job
 * reventaba en el COMMIT con "Client has encountered a connection error and
 * is not queryable" -- cada hora, sin llegar a terminar nunca.
 *
 * Acá: 1 query de productos + 1 de alertas activas, se clasifica en memoria
 * y solo se escribe lo que cambió.
 *
 * @returns {Promise<number>} cantidad de productos revisados
 */
async function syncStockAlertsForTenants(tenantIds) {
  const stats = { checked: 0, created: 0, resolved: 0, not_applicable: 0 };

  const activeAlerts = await StockAlert.findAll({
    where: { tenant_id: tenantIds, status: 'active' },
    attributes: ['id', 'tenant_id', 'product_id', 'alert_type', 'severity', 'current_stock']
  });
  const productsWithActiveAlert = [...new Set(activeAlerts.map((a) => a.product_id))];

  // Candidatos: productos que podrían necesitar alerta (umbral configurado o
  // en 0) + TODOS los que hoy tienen una alerta activa, para poder cerrarla
  // si ya no aplica (antes un producto que dejaba de controlar inventario
  // conservaba su alerta activa para siempre).
  const products = await Product.findAll({
    where: {
      tenant_id: tenantIds,
      [Op.or]: [
        {
          track_inventory: true,
          [Op.or]: [
            { min_stock: { [Op.gt]: 0 } },
            { max_stock: { [Op.gt]: 0 } },
            { current_stock: { [Op.lte]: 0 } },
          ],
        },
        ...(productsWithActiveAlert.length ? [{ id: productsWithActiveAlert }] : []),
      ],
    },
    attributes: ['id', 'tenant_id', 'name', 'current_stock', 'min_stock', 'max_stock', 'track_inventory']
  });
  if (products.length === 0) return stats;

  // Solo productos con compras/entradas registradas (ver productsWithEntries).
  const tracked = products.filter((p) => p.track_inventory !== false);
  const applicable = await productsWithEntries(tracked);

  const alertsByProduct = new Map();
  for (const a of activeAlerts) {
    if (!alertsByProduct.has(a.product_id)) alertsByProduct.set(a.product_id, []);
    alertsByProduct.get(a.product_id).push(a);
  }

  const toCreate = [];
  const toUpdate = [];
  const toResolveIds = [];        // stock normalizado o tipo de alerta cambió
  const notApplicableIds = [];    // solo-ficha o no controla inventario
  const notTrackedIds = [];

  for (const product of products) {
    const existing = alertsByProduct.get(product.id) || [];

    if (product.track_inventory === false) {
      if (existing.length) notTrackedIds.push(...existing.map((a) => a.id));
      continue;
    }
    if (!applicable.has(product.id)) {
      if (existing.length) notApplicableIds.push(...existing.map((a) => a.id));
      continue;
    }

    stats.checked += 1;
    const { currentStock, minStock, maxStock, alertType, severity } = classifyStock(product);

    // Alertas activas de otro tipo (ej. quedó "stock bajo" activa cuando ya
    // está en "sin stock", o viceversa): se cierran — solo vale la actual.
    for (const a of existing) if (a.alert_type !== alertType) toResolveIds.push(a.id);
    if (!alertType) continue;

    const current = existing.find((a) => a.alert_type === alertType);
    if (!current) {
      toCreate.push({
        tenant_id: product.tenant_id,
        product_id: product.id,
        alert_type: alertType,
        severity,
        current_stock: currentStock,
        min_stock: minStock,
        max_stock: maxStock,
        status: 'active'
      });
    } else if ((parseFloat(current.current_stock) || 0) !== currentStock || current.severity !== severity) {
      toUpdate.push({ alert: current, current_stock: currentStock, severity });
    }
  }

  if (toCreate.length > 0) {
    await StockAlert.bulkCreate(toCreate);
    stats.created = toCreate.length;
    console.log(`✅ ${toCreate.length} alertas automáticas de stock creadas`);
  }

  for (const { alert, current_stock, severity } of toUpdate) {
    await alert.update({ current_stock, severity });
  }

  // Cierre por lotes (ids de alerta).
  const closeAlerts = async (ids, note) => {
    let n = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const [count] = await StockAlert.update(
        { status: 'resolved', resolved_date: new Date(), resolution_notes: note },
        { where: { id: ids.slice(i, i + 1000), status: 'active' } }
      );
      n += count;
    }
    return n;
  };
  stats.resolved = await closeAlerts(toResolveIds, 'Stock normalizado automáticamente');
  stats.not_applicable = await closeAlerts(notApplicableIds, NOT_APPLICABLE_NOTE)
    + await closeAlerts(notTrackedIds, 'No aplica: el producto no controla inventario');
  if (stats.not_applicable) {
    console.log(`🧹 ${stats.not_applicable} alertas cerradas: productos sin entradas registradas o que no controlan inventario`);
  }

  return stats;
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
  syncStockAlertsForTenants,
  productsWithEntries,
  markForAlertCheck,
  markProductsForAlertCheck
};