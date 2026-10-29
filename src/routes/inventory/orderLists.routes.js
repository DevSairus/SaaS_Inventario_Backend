// backend/src/routes/inventory/orderLists.routes.js
//
// Listas de pedido a proveedor (sin precios).
// Base: /api/inventory/order-lists
// Cualquier usuario del tenant puede anotar, ajustar y quitar líneas; revisar
// y enviar al proveedor, cerrar, descartar y convertir en compra queda para
// los roles que gestionan compras/bodega.

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/inventory/orderLists.controller');
const { checkRole } = require('../../middleware/auth');

const ORDER_LIST_MANAGE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];
const manage = checkRole(...ORDER_LIST_MANAGE_ROLES);

router.get('/', ctrl.getOrderLists);
router.get('/stats', ctrl.getOrderListsStats);
router.get('/pending-products', ctrl.getPendingProducts);
router.get('/suggestion/:productId', ctrl.getProductSuggestion);
router.post('/items', ctrl.addItem);
router.patch('/items/:itemId', ctrl.updateItem);
router.delete('/items/:itemId', ctrl.deleteItem);

router.get('/:id', ctrl.getOrderListById);
router.patch('/:id', ctrl.updateOrderList);
router.get('/:id/pdf', manage, ctrl.getOrderListPdf);
router.post('/:id/send-email', manage, ctrl.sendOrderListEmail);
router.post('/:id/log-send', manage, ctrl.logOrderListSend);
router.patch('/:id/close', manage, ctrl.closeOrderList);
router.patch('/:id/cancel', manage, ctrl.cancelOrderList);
router.get('/:id/purchase-draft', manage, ctrl.getPurchaseDraft);
router.patch('/:id/link-purchase', manage, ctrl.linkPurchase);

module.exports = router;
