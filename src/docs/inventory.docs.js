// ─── CATEGORIES ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/categories:
 *   get:
 *     tags: [Categories]
 *     summary: Listar categorías
 *     parameters:
 *       - in: query
 *         name: parent_id
 *         schema: { type: string, format: uuid }
 *         description: Filtrar por categoría padre (null para raíz)
 *     responses:
 *       200:
 *         description: Lista de categorías
 *   post:
 *     tags: [Categories]
 *     summary: Crear categoría
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: 'Herramientas' }
 *               description: { type: string }
 *               parent_id: { type: string, format: uuid, nullable: true }
 *     responses:
 *       201:
 *         description: Categoría creada
 */

/**
 * @swagger
 * /api/categories/{id}:
 *   get:
 *     tags: [Categories]
 *     summary: Obtener categoría por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Categoría encontrada
 *       404:
 *         description: No encontrada
 *   put:
 *     tags: [Categories]
 *     summary: Actualizar categoría
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Actualizada
 *   delete:
 *     tags: [Categories]
 *     summary: Eliminar categoría
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminada
 */

/**
 * @swagger
 * /api/categories/{id}/deactivate:
 *   patch:
 *     tags: [Categories]
 *     summary: Desactivar categoría
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Desactivada
 */

// ─── SUPPLIERS ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/suppliers:
 *   get:
 *     tags: [Suppliers]
 *     summary: Listar proveedores
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: is_active
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Lista de proveedores
 *   post:
 *     tags: [Suppliers]
 *     summary: Crear proveedor
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Supplier'
 *     responses:
 *       201:
 *         description: Proveedor creado
 */

/**
 * @swagger
 * /api/inventory/suppliers/stats:
 *   get:
 *     tags: [Suppliers]
 *     summary: Estadísticas de proveedores
 *     responses:
 *       200:
 *         description: Estadísticas
 */

/**
 * @swagger
 * /api/inventory/suppliers/{id}:
 *   get:
 *     tags: [Suppliers]
 *     summary: Obtener proveedor por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Proveedor encontrado
 *       404:
 *         description: No encontrado
 *   put:
 *     tags: [Suppliers]
 *     summary: Actualizar proveedor
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Supplier'
 *     responses:
 *       200:
 *         description: Actualizado
 *   delete:
 *     tags: [Suppliers]
 *     summary: Eliminar proveedor
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminado
 */

/**
 * @swagger
 * /api/inventory/suppliers/{id}/deactivate:
 *   patch:
 *     tags: [Suppliers]
 *     summary: Desactivar proveedor
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Desactivado
 */

/**
 * @swagger
 * /api/inventory/suppliers/{id}/activate:
 *   patch:
 *     tags: [Suppliers]
 *     summary: Reactivar proveedor
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Activado
 */

// ─── WAREHOUSES ──────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/warehouses:
 *   get:
 *     tags: [Warehouses]
 *     summary: Listar bodegas del tenant
 *     responses:
 *       200:
 *         description: Lista de bodegas activas
 *   post:
 *     tags: [Warehouses]
 *     summary: Crear bodega
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, code]
 *             properties:
 *               name: { type: string, example: 'Bodega Norte' }
 *               code: { type: string, example: 'BD-002' }
 *               address: { type: string }
 *               city: { type: string }
 *               phone: { type: string }
 *               is_main: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Bodega creada
 */

/**
 * @swagger
 * /api/inventory/warehouses/{id}:
 *   get:
 *     tags: [Warehouses]
 *     summary: Obtener bodega por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bodega encontrada
 *   put:
 *     tags: [Warehouses]
 *     summary: Actualizar bodega
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Warehouse'
 *     responses:
 *       200:
 *         description: Actualizada
 *   delete:
 *     tags: [Warehouses]
 *     summary: Eliminar bodega
 *     description: Solo funciona si la bodega no tiene stock activo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminada
 *       400:
 *         description: Tiene productos en stock
 */

// ─── MOVEMENTS ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/movements:
 *   get:
 *     tags: [Movements]
 *     summary: Listar movimientos de inventario
 *     description: Los movimientos se crean automáticamente desde compras, ventas, ajustes, etc.
 *     parameters:
 *       - in: query
 *         name: product_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: movement_type
 *         schema: { type: string, enum: [entry, exit, adjustment, transfer_in, transfer_out] }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Lista de movimientos
 */

/**
 * @swagger
 * /api/inventory/movements/kardex/{product_id}:
 *   get:
 *     tags: [Movements]
 *     summary: Kardex de un producto
 *     description: Historial completo de entradas y salidas con saldo acumulado
 *     parameters:
 *       - in: path
 *         name: product_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Kardex del producto
 */

/**
 * @swagger
 * /api/inventory/movements/stats:
 *   get:
 *     tags: [Movements]
 *     summary: Estadísticas de movimientos
 *     responses:
 *       200:
 *         description: Estadísticas
 */

// ─── ADJUSTMENTS ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/adjustments:
 *   get:
 *     tags: [Adjustments]
 *     summary: Listar ajustes de inventario
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, confirmed, cancelled] }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Lista de ajustes
 *   post:
 *     tags: [Adjustments]
 *     summary: Crear ajuste de inventario
 *     description: Crea un ajuste en estado draft. Confirmar para que afecte el inventario.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason, items]
 *             properties:
 *               reason: { type: string, example: 'Conteo físico mensual' }
 *               notes: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity, adjustment_type]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number, example: 10 }
 *                     adjustment_type: { type: string, enum: [increase, decrease, count] }
 *                     notes: { type: string }
 *     responses:
 *       201:
 *         description: Ajuste creado en draft
 */

/**
 * @swagger
 * /api/inventory/adjustments/stats:
 *   get:
 *     tags: [Adjustments]
 *     summary: Estadísticas de ajustes
 *     responses:
 *       200:
 *         description: Estadísticas
 */

/**
 * @swagger
 * /api/inventory/adjustments/{id}:
 *   get:
 *     tags: [Adjustments]
 *     summary: Obtener ajuste por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ajuste encontrado
 *   put:
 *     tags: [Adjustments]
 *     summary: Actualizar ajuste (solo en estado draft)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Actualizado
 *   delete:
 *     tags: [Adjustments]
 *     summary: Eliminar ajuste (solo en estado draft)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminado
 */

/**
 * @swagger
 * /api/inventory/adjustments/{id}/confirm:
 *   patch:
 *     tags: [Adjustments]
 *     summary: Confirmar ajuste
 *     description: ⚠️ Acción irreversible. Genera movimientos de inventario.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ajuste confirmado, inventario actualizado
 */

/**
 * @swagger
 * /api/inventory/adjustments/{id}/cancel:
 *   patch:
 *     tags: [Adjustments]
 *     summary: Cancelar ajuste
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelado
 */

// ─── PURCHASES ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/purchases:
 *   get:
 *     tags: [Purchases]
 *     summary: Listar órdenes de compra
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, confirmed, received, cancelled] }
 *       - in: query
 *         name: supplier_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Lista de compras
 *   post:
 *     tags: [Purchases]
 *     summary: Crear orden de compra
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [supplier_id, items]
 *             properties:
 *               supplier_id: { type: string, format: uuid }
 *               expected_date: { type: string, format: date }
 *               notes: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity, unit_price]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number }
 *                     unit_price: { type: number }
 *     responses:
 *       201:
 *         description: Compra creada
 */

/**
 * @swagger
 * /api/inventory/purchases/stats:
 *   get:
 *     tags: [Purchases]
 *     summary: Estadísticas de compras
 *     responses:
 *       200:
 *         description: Estadísticas
 */

/**
 * @swagger
 * /api/inventory/purchases/{id}:
 *   get:
 *     tags: [Purchases]
 *     summary: Obtener compra por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Compra encontrada
 *   put:
 *     tags: [Purchases]
 *     summary: Actualizar compra (solo draft)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Actualizada
 *   delete:
 *     tags: [Purchases]
 *     summary: Eliminar compra
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminada
 */

/**
 * @swagger
 * /api/inventory/purchases/{id}/confirm:
 *   patch:
 *     tags: [Purchases]
 *     summary: Confirmar orden de compra
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Confirmada
 */

/**
 * @swagger
 * /api/inventory/purchases/{id}/receive:
 *   patch:
 *     tags: [Purchases]
 *     summary: Marcar como recibida (ingresa al inventario)
 *     description: Genera movimientos de entrada en el inventario automáticamente
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Recibida, stock actualizado
 */

/**
 * @swagger
 * /api/inventory/purchases/{id}/cancel:
 *   patch:
 *     tags: [Purchases]
 *     summary: Cancelar compra
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelada
 */

// ─── TRANSFERS ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/transfers:
 *   get:
 *     tags: [Transfers]
 *     summary: Listar traslados entre bodegas
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, sent, received, cancelled] }
 *     responses:
 *       200:
 *         description: Lista de traslados
 *   post:
 *     tags: [Transfers]
 *     summary: Crear traslado
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [origin_warehouse_id, destination_warehouse_id, items]
 *             properties:
 *               origin_warehouse_id: { type: string, format: uuid }
 *               destination_warehouse_id: { type: string, format: uuid }
 *               notes: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number }
 *     responses:
 *       201:
 *         description: Traslado creado
 */

/**
 * @swagger
 * /api/inventory/transfers/{id}:
 *   get:
 *     tags: [Transfers]
 *     summary: Obtener traslado por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Traslado encontrado
 *   delete:
 *     tags: [Transfers]
 *     summary: Eliminar traslado (solo draft)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminado
 */

/**
 * @swagger
 * /api/inventory/transfers/{id}/send:
 *   put:
 *     tags: [Transfers]
 *     summary: Enviar traslado (descuenta del origen)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Traslado enviado
 */

/**
 * @swagger
 * /api/inventory/transfers/{id}/receive:
 *   put:
 *     tags: [Transfers]
 *     summary: Recibir traslado (suma al destino)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Traslado recibido, stock actualizado
 */

/**
 * @swagger
 * /api/inventory/transfers/{id}/cancel:
 *   put:
 *     tags: [Transfers]
 *     summary: Cancelar traslado
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelado
 */

// ─── SUPPLIER RETURNS ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/supplier-returns:
 *   get:
 *     tags: [SupplierReturns]
 *     summary: Listar devoluciones a proveedores
 *     responses:
 *       200:
 *         description: Lista de devoluciones
 *   post:
 *     tags: [SupplierReturns]
 *     summary: Crear devolución a proveedor
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [supplier_id, items]
 *             properties:
 *               supplier_id: { type: string, format: uuid }
 *               reason: { type: string, example: 'Producto defectuoso' }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number }
 *     responses:
 *       201:
 *         description: Devolución creada
 */

/**
 * @swagger
 * /api/inventory/supplier-returns/{id}:
 *   get:
 *     tags: [SupplierReturns]
 *     summary: Obtener devolución por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Devolución encontrada
 *   delete:
 *     tags: [SupplierReturns]
 *     summary: Eliminar devolución (solo pendiente)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminada
 */

/**
 * @swagger
 * /api/inventory/supplier-returns/{id}/approve:
 *   put:
 *     tags: [SupplierReturns]
 *     summary: Aprobar devolución (descuenta del inventario)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Aprobada
 */

/**
 * @swagger
 * /api/inventory/supplier-returns/{id}/reject:
 *   put:
 *     tags: [SupplierReturns]
 *     summary: Rechazar devolución
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Rechazada
 */

// ─── INTERNAL CONSUMPTIONS ───────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/internal-consumptions:
 *   get:
 *     tags: [InternalConsumptions]
 *     summary: Listar consumos internos
 *     responses:
 *       200:
 *         description: Lista de consumos
 *   post:
 *     tags: [InternalConsumptions]
 *     summary: Crear consumo interno
 *     description: Registra productos usados internamente (no ventas). Ej: material de oficina, mantenimiento.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason, items]
 *             properties:
 *               reason: { type: string, example: 'Mantenimiento de equipos' }
 *               department: { type: string, example: 'Operaciones' }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number }
 *     responses:
 *       201:
 *         description: Consumo creado
 */

/**
 * @swagger
 * /api/inventory/internal-consumptions/{id}:
 *   get:
 *     tags: [InternalConsumptions]
 *     summary: Obtener consumo por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Consumo encontrado
 *   delete:
 *     tags: [InternalConsumptions]
 *     summary: Eliminar consumo (solo pendiente)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminado
 */

/**
 * @swagger
 * /api/inventory/internal-consumptions/{id}/approve:
 *   put:
 *     tags: [InternalConsumptions]
 *     summary: Aprobar consumo (descuenta del inventario)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Aprobado
 */

/**
 * @swagger
 * /api/inventory/internal-consumptions/{id}/reject:
 *   put:
 *     tags: [InternalConsumptions]
 *     summary: Rechazar consumo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Rechazado
 */