// ─── SALES ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/sales:
 *   get:
 *     tags: [Sales]
 *     summary: Listar ventas
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, confirmed, delivered, cancelled] }
 *       - in: query
 *         name: customer_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: customer_name
 *         schema: { type: string }
 *       - in: query
 *         name: vehicle_plate
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Busca en número, cliente, email, teléfono, placa
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Lista de ventas
 *   post:
 *     tags: [Sales]
 *     summary: Crear venta (en estado draft)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               customer_id: { type: string, format: uuid, nullable: true }
 *               customer_name: { type: string, example: 'Juan Pérez' }
 *               customer_tax_id: { type: string }
 *               customer_email: { type: string, format: email }
 *               customer_phone: { type: string }
 *               notes: { type: string }
 *               discount: { type: number, default: 0 }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity, unit_price]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: number }
 *                     unit_price: { type: number }
 *                     discount: { type: number, default: 0 }
 *     responses:
 *       201:
 *         description: Venta creada en draft
 */

/**
 * @swagger
 * /api/sales/stats:
 *   get:
 *     tags: [Sales]
 *     summary: Estadísticas de ventas
 *     parameters:
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Estadísticas (total ventas, monto, top productos, etc.)
 */

/**
 * @swagger
 * /api/sales/{id}:
 *   get:
 *     tags: [Sales]
 *     summary: Obtener venta por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Venta encontrada con items
 *       404:
 *         description: No encontrada
 *   put:
 *     tags: [Sales]
 *     summary: Actualizar venta (solo draft)
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
 *     tags: [Sales]
 *     summary: Eliminar venta (solo draft)
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
 * /api/sales/{id}/confirm:
 *   post:
 *     tags: [Sales]
 *     summary: Confirmar venta y registrar pago
 *     description: |
 *       Confirma la venta, descuenta el inventario y registra el método de pago.
 *       - **Pago completo**: `paid_amount = total`
 *       - **Pago parcial**: `paid_amount < total` → requiere `credit_days`
 *       - **Crédito total**: `paid_amount = 0` → requiere `credit_days`
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
 *             $ref: '#/components/schemas/ConfirmSaleRequest'
 *     responses:
 *       200:
 *         description: Venta confirmada, inventario actualizado
 *       400:
 *         description: Stock insuficiente o datos inválidos
 */

/**
 * @swagger
 * /api/sales/{id}/cancel:
 *   post:
 *     tags: [Sales]
 *     summary: Cancelar venta
 *     description: Si ya estaba confirmada, devuelve el stock al inventario
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelada
 */

/**
 * @swagger
 * /api/sales/{id}/deliver:
 *   post:
 *     tags: [Sales]
 *     summary: Marcar venta como entregada
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Marcada como entregada
 */

/**
 * @swagger
 * /api/sales/{id}/payments:
 *   post:
 *     tags: [Sales]
 *     summary: Registrar abono a venta en crédito
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
 *             required: [amount, payment_method]
 *             properties:
 *               amount: { type: number, example: 50000 }
 *               payment_method: { type: string, enum: [cash, credit_card, debit_card, transfer, check] }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Abono registrado
 */

/**
 * @swagger
 * /api/sales/{id}/pdf:
 *   get:
 *     tags: [Sales]
 *     summary: Generar PDF de la venta
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: PDF generado
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 */

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/customers:
 *   get:
 *     tags: [Customers]
 *     summary: Listar clientes
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Busca por nombre, cédula, email o teléfono
 *       - in: query
 *         name: is_active
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Lista de clientes
 *   post:
 *     tags: [Customers]
 *     summary: Crear cliente
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Customer'
 *     responses:
 *       201:
 *         description: Cliente creado
 */

/**
 * @swagger
 * /api/customers/search:
 *   get:
 *     tags: [Customers]
 *     summary: Buscar clientes (para autocompletar)
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200:
 *         description: Resultados de búsqueda
 */

/**
 * @swagger
 * /api/customers/{id}:
 *   get:
 *     tags: [Customers]
 *     summary: Obtener cliente por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cliente encontrado
 *   put:
 *     tags: [Customers]
 *     summary: Actualizar cliente
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
 *             $ref: '#/components/schemas/Customer'
 *     responses:
 *       200:
 *         description: Actualizado
 *   delete:
 *     tags: [Customers]
 *     summary: Eliminar cliente
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Eliminado
 */

// ─── CUSTOMER RETURNS ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/sales/customer-returns:
 *   get:
 *     tags: [CustomerReturns]
 *     summary: Listar devoluciones de clientes
 *     responses:
 *       200:
 *         description: Lista de devoluciones
 *   post:
 *     tags: [CustomerReturns]
 *     summary: Crear devolución de cliente
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sale_id, items]
 *             properties:
 *               sale_id: { type: string, format: uuid }
 *               reason: { type: string, example: 'Producto dañado' }
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
 * /api/sales/customer-returns/{id}:
 *   get:
 *     tags: [CustomerReturns]
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
 *     tags: [CustomerReturns]
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
 * /api/sales/customer-returns/{id}/approve:
 *   put:
 *     tags: [CustomerReturns]
 *     summary: Aprobar devolución (reintegra al inventario)
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
 * /api/sales/customer-returns/{id}/reject:
 *   put:
 *     tags: [CustomerReturns]
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

// ─── ACCOUNTS RECEIVABLE ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/accounts-receivable/summary:
 *   get:
 *     tags: [AccountsReceivable]
 *     summary: Resumen de cartera
 *     description: Total por cobrar, vencido, por vencer. Requiere rol admin, manager o accountant.
 *     responses:
 *       200:
 *         description: Resumen de cuentas por cobrar
 */

/**
 * @swagger
 * /api/accounts-receivable/aging-report:
 *   get:
 *     tags: [AccountsReceivable]
 *     summary: Reporte de antigüedad de saldos
 *     description: Clasifica la cartera por rangos de días vencidos (0-30, 31-60, 61-90, +90)
 *     responses:
 *       200:
 *         description: Reporte de antigüedad
 */

/**
 * @swagger
 * /api/accounts-receivable/customer/{customerId}:
 *   get:
 *     tags: [AccountsReceivable]
 *     summary: Cartera de un cliente específico
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cartera del cliente
 */

/**
 * @swagger
 * /api/accounts-receivable/payment-history/{saleId}:
 *   get:
 *     tags: [AccountsReceivable]
 *     summary: Historial de pagos de una venta
 *     parameters:
 *       - in: path
 *         name: saleId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Historial de abonos
 */