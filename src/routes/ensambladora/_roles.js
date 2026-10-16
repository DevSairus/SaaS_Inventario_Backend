// backend/src/routes/ensambladora/_roles.js
// ENS-1: antes ninguna ruta de ensambladora validaba rol; cualquier usuario
// con el módulo podía vincular técnicos, cerrar garantías o registrar ventas.
const { checkRole } = require('../../middleware/auth');

// Acciones de control: vincular técnicos, cerrar garantías, recalls, eventos.
const requireEnsMgmt = checkRole('admin', 'manager', 'super_admin');
// Venta y matrícula del vehículo.
const requireEnsSales = checkRole('admin', 'manager', 'seller', 'super_admin');
// Operación diaria (alistamiento, entrega, revisión, radicar garantía,
// cotizar): todos menos los roles de solo consulta o contables.
const requireEnsOperation = checkRole('admin', 'manager', 'seller', 'technician', 'warehouse_keeper', 'user', 'super_admin');

module.exports = { requireEnsMgmt, requireEnsSales, requireEnsOperation };
