/**
 * @swagger
 * /api/products:
 *   get:
 *     tags: [Products]
 *     summary: Listar productos
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Buscar por nombre, SKU o código de barras
 *       - in: query
 *         name: category_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: is_active
 *         schema: { type: boolean }
 *       - in: query
 *         name: low_stock
 *         schema: { type: boolean }
 *         description: Solo productos con stock bajo
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Lista de productos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 *
 *   post:
 *     tags: [Products]
 *     summary: Crear producto
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateProductRequest'
 *     responses:
 *       201:
 *         description: Producto creado
 *       400:
 *         description: Datos inválidos o SKU duplicado
 */

/**
 * @swagger
 * /api/products/stats:
 *   get:
 *     tags: [Products]
 *     summary: Estadísticas de productos
 *     description: Total de productos, valor de inventario, productos con stock bajo, etc.
 *     responses:
 *       200:
 *         description: Estadísticas del inventario
 */

/**
 * @swagger
 * /api/products/barcode/{barcode}:
 *   get:
 *     tags: [Products]
 *     summary: Buscar producto por código de barras
 *     parameters:
 *       - in: path
 *         name: barcode
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Producto encontrado
 *       404:
 *         description: Producto no encontrado
 */

/**
 * @swagger
 * /api/products/check-barcode/{barcode}:
 *   get:
 *     tags: [Products]
 *     summary: Verificar si un código de barras ya existe
 *     parameters:
 *       - in: path
 *         name: barcode
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Resultado de verificación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists: { type: boolean }
 */

/**
 * @swagger
 * /api/products/{id}:
 *   get:
 *     tags: [Products]
 *     summary: Obtener producto por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Producto encontrado
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Product'
 *       404:
 *         description: Producto no encontrado
 *
 *   put:
 *     tags: [Products]
 *     summary: Actualizar producto
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
 *             $ref: '#/components/schemas/CreateProductRequest'
 *     responses:
 *       200:
 *         description: Producto actualizado
 *       404:
 *         description: Producto no encontrado
 *
 *   delete:
 *     tags: [Products]
 *     summary: Eliminar producto permanentemente
 *     description: ⚠️ Eliminación física. Solo funciona si el producto no tiene movimientos.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Producto eliminado
 *       400:
 *         description: No se puede eliminar, tiene movimientos asociados
 */

/**
 * @swagger
 * /api/products/{id}/deactivate:
 *   patch:
 *     tags: [Products]
 *     summary: Desactivar producto (soft delete)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Producto desactivado
 */

/**
 * @swagger
 * /api/products/{id}/suppliers:
 *   get:
 *     tags: [Products]
 *     summary: Obtener proveedores asociados al producto
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lista de proveedores
 */