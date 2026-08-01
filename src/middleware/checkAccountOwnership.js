// backend/src/middleware/checkAccountOwnership.js
//
// CRM Fase 1 — modelo mixto de aislamiento entre vendedores (§5-bis del
// diseño). Por defecto un cliente es cuenta libre: cualquier usuario con
// permiso de ventas puede cotizar/vender/abrir OT para él. Solo cuando un
// manager/admin lo marca explícitamente como cuenta asignada
// (customers.is_assigned_account = true) se bloquea a que únicamente el
// owner_user_id (o un manager/admin/super_admin) pueda transaccionar con
// ese cliente.
//
// Uso: aplicar en las rutas de creación que reciben `customer_id` en el
// body (POST /api/sales, POST /api/workshop/work-orders, etc.). No aplica
// a lectura ni a listados — eso lo resuelve el scoping de visibilidad
// (applyOwnershipScope, aparte de este middleware).

const { Customer } = require('../models');

const OWNERSHIP_BYPASS_ROLES = ['admin', 'manager', 'super_admin'];

const checkAccountOwnership = async (req, res, next) => {
  try {
    const customerId = req.body?.customer_id;

    // Sin cliente identificado (venta de mostrador / consumidor final) no
    // hay nada que bloquear — el guard solo tiene sentido cuando el
    // request está asociado a un customer_id concreto.
    if (!customerId) return next();

    if (OWNERSHIP_BYPASS_ROLES.includes(req.user?.role)) return next();

    const customer = await Customer.findOne({
      where: { id: customerId, tenant_id: req.user.tenant_id },
      attributes: ['id', 'is_assigned_account', 'owner_user_id'],
    });

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    if (customer.is_assigned_account && customer.owner_user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_ASSIGNED_TO_ANOTHER_USER',
        message: 'Este cliente es una cuenta asignada a otro asesor',
      });
    }

    next();
  } catch (error) {
    console.error('❌ [checkAccountOwnership] Error:', error);
    res.status(500).json({ success: false, message: 'Error al verificar la cuenta del cliente' });
  }
};

module.exports = { checkAccountOwnership };
