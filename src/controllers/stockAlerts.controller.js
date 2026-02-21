const { StockAlert, Product, Category, User } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * Obtener todas las alertas con filtros y paginación
 */
const getStockAlerts = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const {
      search = '',
      alert_type,
      severity,
      status = 'active',
      category_id,
      sort_by = 'created_at', // ✅ Cambiado de 'alert_date' a 'created_at'
      sort_order = 'DESC',
      page = 1,
      limit = 500 // ✅ Aumentado el límite por defecto a 500
    } = req.query;

    const tenant_id = req.user.tenant_id;
    
    console.log('🔍 [getStockAlerts] Iniciando consulta...');
    console.log('📊 [getStockAlerts] Tenant ID:', tenant_id);
    console.log('📋 [getStockAlerts] Filtros recibidos:', { search, alert_type, severity, status, category_id, sort_by, sort_order, page, limit });
    
    // Permitir límites más altos pero con un máximo razonable
    const maxLimit = Math.min(parseInt(limit), 500);
    const offset = (page - 1) * maxLimit;

    // Construir condiciones de búsqueda
    const where = { tenant_id };

    if (status) {
      where.status = status;
    }

    if (alert_type) {
      where.alert_type = alert_type;
    }

    if (severity) {
      where.severity = severity;
    }

    console.log('🔎 [getStockAlerts] WHERE conditions:', where);

    // Condiciones para búsqueda en producto
    const productWhere = {};
    if (category_id) {
      productWhere.category_id = category_id;
    }

    if (search) {
      productWhere[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { sku: { [Op.iLike]: `%${search}%` } },
        { barcode: { [Op.iLike]: `%${search}%` } }
      ];
    }

    console.log('🔎 [getStockAlerts] Product WHERE conditions:', productWhere);
    console.log('🔎 [getStockAlerts] Using INNER JOIN?', Object.keys(productWhere).length > 0 ? 'YES - PROBLEMA DETECTADO' : 'NO');

    // ✅ CORRECCIÓN: Usar required: false para LEFT JOIN y evitar pérdida de alertas
    const includeProduct = {
      model: Product,
      as: 'product',
      required: false, // ✅ LEFT JOIN en lugar de INNER JOIN
      attributes: ['id', 'name', 'sku', 'barcode', 'current_stock', 'min_stock', 'max_stock'],
      include: [
        {
          model: Category,
          as: 'category',
          required: false, // ✅ LEFT JOIN también para categoría
          attributes: ['id', 'name']
        }
      ]
    };

    // Solo aplicar filtros de producto si hay búsqueda específica
    if (Object.keys(productWhere).length > 0) {
      includeProduct.where = productWhere;
      includeProduct.required = true; // Solo en este caso usar INNER JOIN
      console.log('⚠️ [getStockAlerts] Aplicando filtro de producto - Se usará INNER JOIN');
    }

    // Obtener alertas
    const { count, rows } = await StockAlert.findAndCountAll({
      where,
      include: [
        includeProduct,
        {
          model: User,
          as: 'resolver',
          required: false, // ✅ LEFT JOIN
          attributes: ['id', 'first_name', 'last_name', 'email']
        }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: maxLimit,
      offset: parseInt(offset),
      distinct: true // ✅ Para contar correctamente con JOINs
    });

    console.log('✅ [getStockAlerts] Resultados:');
    console.log('   - Total encontrado:', count);
    console.log('   - Devolviendo:', rows.length);
    console.log('   - Página:', page);
    console.log('   - Límite:', maxLimit);
    console.log('   - Total páginas:', Math.ceil(count / maxLimit));

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: maxLimit,
        pages: Math.ceil(count / maxLimit)
      }
    });

  } catch (error) {
    console.error('❌ [getStockAlerts] Error:', error);
    console.error('❌ [getStockAlerts] Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Error al obtener alertas de stock',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Obtener una alerta por ID
 */
const getStockAlertById = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await StockAlert.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'sku', 'barcode', 'current_stock', 'min_stock', 'max_stock'],
          include: [
            {
              model: Category,
              as: 'category',
              attributes: ['id', 'name']
            }
          ]
        },
        {
          model: User,
          as: 'resolver',
          attributes: ['id', 'first_name', 'last_name', 'email']
        }
      ]
    });

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alerta no encontrada'
      });
    }

    res.json({
      success: true,
      data: alert
    });

  } catch (error) {
    console.error('Error en getStockAlertById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener la alerta'
    });
  }
};

/**
 * Resolver una alerta
 */
const resolveStockAlert = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const alert = await StockAlert.findOne({
      where: { id, tenant_id }
    });

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alerta no encontrada'
      });
    }

    if (alert.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'La alerta ya fue resuelta o ignorada'
      });
    }

    await alert.update({
      status: 'resolved',
      resolved_date: new Date(),
      resolved_by: user_id,
      resolution_notes
    });

    // Obtener alerta actualizada con relaciones
    const updatedAlert = await StockAlert.findOne({
      where: { id },
      include: [
        {
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'sku', 'current_stock']
        },
        {
          model: User,
          as: 'resolver',
          attributes: ['id', 'first_name', 'last_name']
        }
      ]
    });

    res.json({
      success: true,
      message: 'Alerta resuelta exitosamente',
      data: updatedAlert
    });

  } catch (error) {
    console.error('Error en resolveStockAlert:', error);
    res.status(500).json({
      success: false,
      message: 'Error al resolver la alerta'
    });
  }
};

/**
 * Ignorar una alerta
 */
const ignoreStockAlert = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const { resolution_notes } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const alert = await StockAlert.findOne({
      where: { id, tenant_id }
    });

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alerta no encontrada'
      });
    }

    if (alert.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'La alerta ya fue resuelta o ignorada'
      });
    }

    await alert.update({
      status: 'ignored',
      resolved_date: new Date(),
      resolved_by: user_id,
      resolution_notes
    });

    res.json({
      success: true,
      message: 'Alerta ignorada exitosamente',
      data: alert
    });

  } catch (error) {
    console.error('Error en ignoreStockAlert:', error);
    res.status(500).json({
      success: false,
      message: 'Error al ignorar la alerta'
    });
  }
};

/**
 * Reactivar una alerta
 */
const reactivateStockAlert = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await StockAlert.findOne({
      where: { id, tenant_id }
    });

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alerta no encontrada'
      });
    }

    if (alert.status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'La alerta ya está activa'
      });
    }

    await alert.update({
      status: 'active',
      resolved_date: null,
      resolved_by: null,
      resolution_notes: null
    });

    res.json({
      success: true,
      message: 'Alerta reactivada exitosamente',
      data: alert
    });

  } catch (error) {
    console.error('Error en reactivateStockAlert:', error);
    res.status(500).json({
      success: false,
      message: 'Error al reactivar la alerta'
    });
  }
};

/**
 * Eliminar una alerta
 */
const deleteStockAlert = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const alert = await StockAlert.findOne({
      where: { id, tenant_id }
    });

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alerta no encontrada'
      });
    }

    await alert.destroy();

    res.json({
      success: true,
      message: 'Alerta eliminada exitosamente'
    });

  } catch (error) {
    console.error('Error en deleteStockAlert:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar la alerta'
    });
  }
};

/**
 * Obtener estadísticas de alertas
 */
const getStockAlertsStats = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;

    // Total de alertas activas
    const totalActive = await StockAlert.count({
      where: { tenant_id, status: 'active' }
    });

    // Alertas críticas (out_of_stock)
    const criticalAlerts = await StockAlert.count({
      where: {
        tenant_id,
        status: 'active',
        alert_type: 'out_of_stock'
      }
    });

    // Alertas de stock bajo
    const lowStockAlerts = await StockAlert.count({
      where: {
        tenant_id,
        status: 'active',
        alert_type: 'low_stock'
      }
    });

    // Alertas de sobrestock
    const overstockAlerts = await StockAlert.count({
      where: {
        tenant_id,
        status: 'active',
        alert_type: 'overstock'
      }
    });

    // Alertas resueltas este mes
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const resolvedThisMonth = await StockAlert.count({
      where: {
        tenant_id,
        status: 'resolved',
        resolved_date: {
          [Op.gte]: firstDayOfMonth
        }
      }
    });

    // Alertas por severidad
    const bySeverity = await StockAlert.findAll({
      where: { tenant_id, status: 'active' },
      attributes: [
        'severity',
        [sequelize.fn('COUNT', sequelize.col('id')), 'count']
      ],
      group: ['severity'],
      raw: true
    });

    const severityStats = {
      info: 0,
      warning: 0,
      critical: 0
    };

    bySeverity.forEach(item => {
      severityStats[item.severity] = parseInt(item.count);
    });

    res.json({
      success: true,
      data: {
        total_active: totalActive,
        critical: criticalAlerts,
        low_stock: lowStockAlerts,
        overstock: overstockAlerts,
        resolved_this_month: resolvedThisMonth,
        by_severity: severityStats
      }
    });

  } catch (error) {
    console.error('Error en getStockAlertsStats:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas de alertas'
    });
  }
};

/**
 * Verificar y crear alertas manualmente (útil para jobs)
 */
const checkAndCreateAlerts = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;

    console.log('🔍 Iniciando verificación de alertas para tenant:', tenant_id);

    // Obtener TODOS los productos con stock configurado (sin límite de paginación)
    const products = await Product.findAll({
      where: {
        tenant_id,
        min_stock: {
          [Op.not]: null,
          [Op.gt]: 0
        }
      },
      attributes: ['id', 'name', 'sku', 'current_stock', 'min_stock', 'max_stock']
    });

    console.log(`📦 Productos encontrados con min_stock configurado: ${products.length}`);

    let alertsCreated = 0;
    let alertsResolved = 0;

    for (const product of products) {
      const currentStock = parseFloat(product.current_stock) || 0;
      const minStock = parseFloat(product.min_stock) || 0;
      const maxStock = product.max_stock ? parseFloat(product.max_stock) : null;

      let alertType = null;
      let severity = null;

      // Determinar tipo de alerta
      if (currentStock <= 0) {
        alertType = 'out_of_stock';
        severity = 'critical';
        console.log(`⚠️ CRÍTICO - Producto sin stock: ${product.name} (${product.sku}) - Stock: ${currentStock}`);
      } else if (currentStock <= minStock) {
        alertType = 'low_stock';
        severity = 'warning';
        console.log(`⚠️ Stock bajo: ${product.name} (${product.sku}) - Stock: ${currentStock} / Min: ${minStock}`);
      } else if (maxStock && currentStock >= maxStock) {
        alertType = 'overstock';
        severity = 'info';
        console.log(`ℹ️ Sobrestock: ${product.name} (${product.sku}) - Stock: ${currentStock} / Max: ${maxStock}`);
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
          const newAlert = await StockAlert.create({
            tenant_id,
            product_id: product.id,
            alert_type: alertType,
            severity,
            current_stock: currentStock,
            min_stock: minStock,
            max_stock: maxStock,
            status: 'active'
          });
          console.log(`✅ Alerta creada para: ${product.name} - Tipo: ${alertType}`);
          alertsCreated++;
        } else {
          // Actualizar stock actual en la alerta existente
          await existingAlert.update({
            current_stock: currentStock,
            severity: severity // Actualizar severidad por si cambió
          });
          console.log(`🔄 Alerta actualizada para: ${product.name}`);
        }
      } else {
        // Si el stock está bien, resolver alertas activas
        const resolvedCount = await StockAlert.update(
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
        if (resolvedCount[0] > 0) {
          console.log(`✅ Alertas resueltas para: ${product.name}`);
        }
        alertsResolved += resolvedCount[0];
      }
    }

    console.log(`📊 Resumen: ${alertsCreated} alertas creadas, ${alertsResolved} alertas resueltas`);

    res.json({
      success: true,
      message: 'Verificación de alertas completada',
      data: {
        products_checked: products.length,
        alerts_created: alertsCreated,
        alerts_resolved: alertsResolved
      }
    });

  } catch (error) {
    console.error('Error en checkAndCreateAlerts:', error);
    res.status(500).json({
      success: false,
      message: 'Error al verificar alertas'
    });
  }
};

module.exports = {
  getStockAlerts,
  getStockAlertById,
  resolveStockAlert,
  ignoreStockAlert,
  reactivateStockAlert,
  deleteStockAlert,
  getStockAlertsStats,
  checkAndCreateAlerts
};