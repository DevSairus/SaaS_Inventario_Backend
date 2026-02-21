// ─── STOCK ALERTS ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/stock-alerts:
 *   get:
 *     tags: [StockAlerts]
 *     summary: Listar alertas de stock
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, resolved, ignored] }
 *       - in: query
 *         name: alert_type
 *         schema: { type: string, enum: [low_stock, out_of_stock, overstock] }
 *     responses:
 *       200:
 *         description: Lista de alertas
 */

/**
 * @swagger
 * /api/stock-alerts/stats:
 *   get:
 *     tags: [StockAlerts]
 *     summary: Estadísticas de alertas activas
 *     responses:
 *       200:
 *         description: Estadísticas
 */

/**
 * @swagger
 * /api/stock-alerts/check:
 *   post:
 *     tags: [StockAlerts]
 *     summary: Ejecutar verificación manual de stock
 *     description: Revisa todos los productos y crea alertas para los que estén bajo el mínimo
 *     responses:
 *       200:
 *         description: Verificación ejecutada
 */

/**
 * @swagger
 * /api/stock-alerts/{id}:
 *   get:
 *     tags: [StockAlerts]
 *     summary: Obtener alerta por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Alerta encontrada
 *   delete:
 *     tags: [StockAlerts]
 *     summary: Eliminar alerta
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
 * /api/stock-alerts/{id}/resolve:
 *   patch:
 *     tags: [StockAlerts]
 *     summary: Marcar alerta como resuelta
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Resuelta
 */

/**
 * @swagger
 * /api/stock-alerts/{id}/ignore:
 *   patch:
 *     tags: [StockAlerts]
 *     summary: Ignorar alerta
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ignorada
 */

/**
 * @swagger
 * /api/stock-alerts/{id}/reactivate:
 *   patch:
 *     tags: [StockAlerts]
 *     summary: Reactivar alerta ignorada
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Reactivada
 */

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/dashboard/kpis:
 *   get:
 *     tags: [Dashboard]
 *     summary: KPIs principales del negocio
 *     description: Ventas del día/mes, stock bajo, productos más vendidos, etc.
 *     responses:
 *       200:
 *         description: KPIs actualizados
 */

/**
 * @swagger
 * /api/dashboard/alerts:
 *   get:
 *     tags: [Dashboard]
 *     summary: Alertas del sistema para el dashboard
 *     description: Alertas de stock, ventas pendientes, cartera vencida
 *     responses:
 *       200:
 *         description: Alertas activas
 */

// ─── REPORTS ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/inventory/reports/movements:
 *   get:
 *     tags: [Reports]
 *     summary: Movimientos por mes (entradas vs salidas)
 *     parameters:
 *       - in: query
 *         name: months
 *         schema: { type: integer, default: 6 }
 *         description: Número de meses a incluir
 *     responses:
 *       200:
 *         description: Movimientos agrupados por mes
 */

/**
 * @swagger
 * /api/inventory/reports/valuation:
 *   get:
 *     tags: [Reports]
 *     summary: Valorización del inventario por categoría
 *     responses:
 *       200:
 *         description: Valor del inventario en COP por categoría
 */

/**
 * @swagger
 * /api/inventory/reports/profit:
 *   get:
 *     tags: [Reports]
 *     summary: Ganancia por producto
 *     parameters:
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Ganancia por producto ordenada de mayor a menor
 */

/**
 * @swagger
 * /api/inventory/reports/rotation:
 *   get:
 *     tags: [Reports]
 *     summary: Rotación de inventario
 *     description: Productos más y menos vendidos. Útil para detectar inventario muerto.
 *     responses:
 *       200:
 *         description: Reporte de rotación
 */

// ─── TENANT ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/tenant/config:
 *   get:
 *     tags: [Tenant]
 *     summary: Obtener configuración de la empresa
 *     responses:
 *       200:
 *         description: Configuración del tenant
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/TenantConfig'
 *   put:
 *     tags: [Tenant]
 *     summary: Actualizar configuración de la empresa
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TenantConfig'
 *     responses:
 *       200:
 *         description: Configuración actualizada
 */

/**
 * @swagger
 * /api/tenant/logo:
 *   post:
 *     tags: [Tenant]
 *     summary: Subir logo de la empresa
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               logo:
 *                 type: string
 *                 format: binary
 *                 description: Imagen (JPG, PNG, WEBP — máx 5MB)
 *     responses:
 *       200:
 *         description: Logo subido
 *   delete:
 *     tags: [Tenant]
 *     summary: Eliminar logo de la empresa
 *     responses:
 *       200:
 *         description: Logo eliminado
 */

// ─── USERS ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/users:
 *   get:
 *     tags: [Users]
 *     summary: Listar usuarios del tenant
 *     description: Requiere rol admin, manager o seller
 *     responses:
 *       200:
 *         description: Lista de usuarios
 *   post:
 *     tags: [Users]
 *     summary: Crear usuario
 *     description: Requiere rol admin. Verifica límites del plan de suscripción.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateUserRequest'
 *     responses:
 *       201:
 *         description: Usuario creado
 *       403:
 *         description: Límite de usuarios alcanzado según el plan
 */

/**
 * @swagger
 * /api/users/profile:
 *   get:
 *     tags: [Users]
 *     summary: Obtener perfil propio
 *     responses:
 *       200:
 *         description: Perfil del usuario autenticado
 *   put:
 *     tags: [Users]
 *     summary: Actualizar perfil propio
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               first_name: { type: string }
 *               last_name: { type: string }
 *               phone: { type: string }
 *     responses:
 *       200:
 *         description: Perfil actualizado
 */

/**
 * @swagger
 * /api/users/change-password:
 *   put:
 *     tags: [Users]
 *     summary: Cambiar contraseña propia
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [current_password, new_password]
 *             properties:
 *               current_password: { type: string }
 *               new_password: { type: string, minLength: 6 }
 *     responses:
 *       200:
 *         description: Contraseña actualizada
 *       400:
 *         description: Contraseña actual incorrecta
 */

/**
 * @swagger
 * /api/users/limits/status:
 *   get:
 *     tags: [Users]
 *     summary: Estado de límites del plan del tenant
 *     description: Muestra cuántos usuarios/productos/clientes se han usado vs el máximo del plan
 *     responses:
 *       200:
 *         description: Estado de límites
 */

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Obtener usuario por ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Usuario encontrado
 *   put:
 *     tags: [Users]
 *     summary: Actualizar usuario (solo admin)
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
 *     tags: [Users]
 *     summary: Eliminar usuario (solo admin)
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
 * /api/users/{id}/toggle-status:
 *   patch:
 *     tags: [Users]
 *     summary: Activar / desactivar usuario (solo admin)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Estado cambiado
 */

// ─── ANNOUNCEMENTS ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/announcements/pending:
 *   get:
 *     tags: [Announcements]
 *     summary: Obtener anuncios pendientes de ver
 *     description: Devuelve anuncios activos que el usuario actual no ha visto
 *     responses:
 *       200:
 *         description: Lista de anuncios pendientes
 */

/**
 * @swagger
 * /api/announcements/{announcementId}/view:
 *   post:
 *     tags: [Announcements]
 *     summary: Marcar anuncio como visto
 *     parameters:
 *       - in: path
 *         name: announcementId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Marcado como visto
 */

/**
 * @swagger
 * /api/announcements/{announcementId}/dismiss:
 *   post:
 *     tags: [Announcements]
 *     summary: Descartar anuncio
 *     parameters:
 *       - in: path
 *         name: announcementId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Descartado
 */

/**
 * @swagger
 * /api/announcements:
 *   get:
 *     tags: [Announcements]
 *     summary: Listar todos los anuncios (solo super_admin)
 *     responses:
 *       200:
 *         description: Lista de anuncios
 *   post:
 *     tags: [Announcements]
 *     summary: Crear anuncio (solo super_admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, content]
 *             properties:
 *               title: { type: string, example: 'Nueva funcionalidad disponible' }
 *               content: { type: string }
 *               type: { type: string, enum: [info, warning, success, error], default: info }
 *               target_roles: { type: array, items: { type: string }, description: 'Roles que verán el anuncio. Vacío = todos' }
 *               expires_at: { type: string, format: date-time, nullable: true }
 *     responses:
 *       201:
 *         description: Anuncio creado
 */

/**
 * @swagger
 * /api/announcements/{id}:
 *   put:
 *     tags: [Announcements]
 *     summary: Actualizar anuncio (solo super_admin)
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
 *     tags: [Announcements]
 *     summary: Eliminar anuncio (solo super_admin)
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
 * /api/announcements/{id}/stats:
 *   get:
 *     tags: [Announcements]
 *     summary: Estadísticas de un anuncio (solo super_admin)
 *     description: Cuántos usuarios lo vieron, descartaron, etc.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Estadísticas del anuncio
 */

// ─── HEALTH ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [System]
 *     summary: Health check de la API
 *     security: []
 *     responses:
 *       200:
 *         description: API funcionando correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: 'API funcionando correctamente' }
 *                 timestamp: { type: string, format: date-time }
 */

/**
 * @swagger
 * /api/test-db:
 *   get:
 *     tags: [System]
 *     summary: Verificar conexión a la base de datos
 *     security: []
 *     responses:
 *       200:
 *         description: Estado de la conexión
 */