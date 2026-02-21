const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'API Control de Inventario',
      version: '1.0.0',
      description: `
## Sistema de Gestión de Inventario — API REST

Documentación completa de todos los endpoints disponibles.

### Autenticación
La mayoría de endpoints requieren un **Bearer Token JWT**.
1. Usa \`POST /api/auth/login\` para obtener el token
2. Haz clic en **Authorize** (🔒) e ingresa: \`Bearer <tu_token>\`

### Roles disponibles
| Rol | Descripción |
|-----|-------------|
| \`super_admin\` | Acceso total al sistema |
| \`admin\` | Administrador del tenant |
| \`manager\` | Gerente con acceso amplio |
| \`seller\` | Vendedor |
| \`warehouse_keeper\` | Encargado de bodega |
| \`accountant\` | Contador (cartera) |
| \`viewer\` | Solo lectura |
      `,
      contact: {
        name: 'ESC Data Core Solutions',
        email: 'soporte@esc-datacore.com',
      },
    },
    servers: [
      {
        url: process.env.API_URL || 'http://localhost:5000',
        description: 'Servidor actual',
      },
      {
        url: 'https://tu-backend.vercel.app',
        description: 'Producción (Vercel)',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Ingresa el token JWT obtenido del login',
        },
      },
      schemas: {
        // ── Respuestas genéricas ──────────────────────────────
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Operación exitosa' },
            data: { type: 'object' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Error en la operación' },
          },
        },
        PaginatedResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'array', items: { type: 'object' } },
            total: { type: 'integer', example: 100 },
            limit: { type: 'integer', example: 50 },
            offset: { type: 'integer', example: 0 },
          },
        },

        // ── Auth ──────────────────────────────────────────────
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'admin@empresa.com' },
            password: { type: 'string', minLength: 6, example: 'mi_password' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
                user: { $ref: '#/components/schemas/User' },
              },
            },
          },
        },
        ForgotPasswordRequest: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', example: 'usuario@empresa.com' },
          },
        },
        ResetPasswordRequest: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string', example: 'abc123def456...' },
            password: { type: 'string', minLength: 6, example: 'nueva_password' },
          },
        },

        // ── User ──────────────────────────────────────────────
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            role: { type: 'string', enum: ['super_admin', 'admin', 'manager', 'seller', 'warehouse_keeper', 'accountant', 'viewer'] },
            is_active: { type: 'boolean' },
            tenant_id: { type: 'string', format: 'uuid', nullable: true },
            last_login: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        CreateUserRequest: {
          type: 'object',
          required: ['email', 'password', 'first_name', 'last_name', 'role'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 6 },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'manager', 'seller', 'warehouse_keeper', 'accountant', 'viewer'] },
          },
        },

        // ── Product ───────────────────────────────────────────
        Product: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Tornillo 1/4"' },
            sku: { type: 'string', example: 'TOR-0025' },
            barcode: { type: 'string', example: '7701234567890', nullable: true },
            description: { type: 'string', nullable: true },
            category_id: { type: 'string', format: 'uuid', nullable: true },
            unit_of_measure: { type: 'string', example: 'unidad' },
            purchase_price: { type: 'number', format: 'float', example: 1500 },
            sale_price: { type: 'number', format: 'float', example: 2500 },
            current_stock: { type: 'number', example: 150 },
            min_stock: { type: 'number', example: 20 },
            max_stock: { type: 'number', example: 500, nullable: true },
            is_active: { type: 'boolean', example: true },
          },
        },
        CreateProductRequest: {
          type: 'object',
          required: ['name', 'sale_price'],
          properties: {
            name: { type: 'string' },
            sku: { type: 'string' },
            barcode: { type: 'string' },
            description: { type: 'string' },
            category_id: { type: 'string', format: 'uuid' },
            unit_of_measure: { type: 'string', default: 'unidad' },
            purchase_price: { type: 'number' },
            sale_price: { type: 'number' },
            min_stock: { type: 'number', default: 0 },
            max_stock: { type: 'number' },
          },
        },

        // ── Category ──────────────────────────────────────────
        Category: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Ferretería' },
            description: { type: 'string', nullable: true },
            parent_id: { type: 'string', format: 'uuid', nullable: true },
            is_active: { type: 'boolean' },
          },
        },

        // ── Supplier ──────────────────────────────────────────
        Supplier: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Distribuidora Nacional S.A.' },
            tax_id: { type: 'string', example: '900123456-1' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            contact_name: { type: 'string' },
            is_active: { type: 'boolean' },
          },
        },

        // ── Purchase ──────────────────────────────────────────
        Purchase: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            purchase_number: { type: 'string', example: 'PO-2026-001' },
            supplier_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['draft', 'confirmed', 'received', 'cancelled'] },
            total_amount: { type: 'number', example: 1500000 },
            purchase_date: { type: 'string', format: 'date' },
            expected_date: { type: 'string', format: 'date', nullable: true },
            notes: { type: 'string', nullable: true },
          },
        },

        // ── Sale ──────────────────────────────────────────────
        Sale: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            sale_number: { type: 'string', example: 'VTA-2026-001' },
            customer_id: { type: 'string', format: 'uuid', nullable: true },
            customer_name: { type: 'string', example: 'Juan Pérez' },
            status: { type: 'string', enum: ['draft', 'confirmed', 'delivered', 'cancelled'] },
            payment_method: { type: 'string', enum: ['cash', 'credit_card', 'debit_card', 'transfer', 'check'] },
            payment_status: { type: 'string', enum: ['paid', 'pending', 'partial'] },
            subtotal: { type: 'number' },
            discount: { type: 'number' },
            tax: { type: 'number' },
            total: { type: 'number', example: 250000 },
            sale_date: { type: 'string', format: 'date-time' },
          },
        },
        ConfirmSaleRequest: {
          type: 'object',
          required: ['payment_method', 'paid_amount'],
          properties: {
            payment_method: { type: 'string', enum: ['cash', 'credit_card', 'debit_card', 'transfer', 'check'] },
            paid_amount: { type: 'number', example: 250000 },
            credit_days: { type: 'integer', example: 30, nullable: true, description: 'Requerido si paid_amount < total (pago parcial o crédito)' },
          },
        },

        // ── Customer ──────────────────────────────────────────
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            tax_id: { type: 'string', example: '1234567890' },
            email: { type: 'string', format: 'email', nullable: true },
            phone: { type: 'string', nullable: true },
            address: { type: 'string', nullable: true },
            is_active: { type: 'boolean' },
          },
        },

        // ── Warehouse ─────────────────────────────────────────
        Warehouse: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Bodega Principal' },
            code: { type: 'string', example: 'BD-001' },
            address: { type: 'string', nullable: true },
            city: { type: 'string', nullable: true },
            is_main: { type: 'boolean' },
            is_active: { type: 'boolean' },
          },
        },

        // ── StockAlert ────────────────────────────────────────
        StockAlert: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            product_id: { type: 'string', format: 'uuid' },
            alert_type: { type: 'string', enum: ['low_stock', 'out_of_stock', 'overstock'] },
            status: { type: 'string', enum: ['active', 'resolved', 'ignored'] },
            current_stock: { type: 'number' },
            min_stock: { type: 'number' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },

        // ── Transfer ──────────────────────────────────────────
        Transfer: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            transfer_number: { type: 'string', example: 'TRF-2026-001' },
            origin_warehouse_id: { type: 'string', format: 'uuid' },
            destination_warehouse_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['draft', 'sent', 'received', 'cancelled'] },
            notes: { type: 'string', nullable: true },
          },
        },

        // ── Tenant ────────────────────────────────────────────
        TenantConfig: {
          type: 'object',
          properties: {
            company_name: { type: 'string' },
            tax_id: { type: 'string' },
            address: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            logo_url: { type: 'string', nullable: true },
            currency: { type: 'string', example: 'COP' },
            subscription_status: { type: 'string' },
            plan: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Autenticación y gestión de sesión' },
      { name: 'Users', description: 'Gestión de usuarios del tenant' },
      { name: 'Products', description: 'Gestión de productos e inventario' },
      { name: 'Categories', description: 'Categorías de productos' },
      { name: 'Suppliers', description: 'Proveedores' },
      { name: 'Purchases', description: 'Órdenes de compra' },
      { name: 'Warehouses', description: 'Bodegas / almacenes' },
      { name: 'Movements', description: 'Movimientos de inventario (kardex)' },
      { name: 'Adjustments', description: 'Ajustes de inventario' },
      { name: 'Transfers', description: 'Traslados entre bodegas' },
      { name: 'SupplierReturns', description: 'Devoluciones a proveedores' },
      { name: 'InternalConsumptions', description: 'Consumos internos' },
      { name: 'Sales', description: 'Ventas' },
      { name: 'Customers', description: 'Clientes' },
      { name: 'CustomerReturns', description: 'Devoluciones de clientes' },
      { name: 'AccountsReceivable', description: 'Cuentas por cobrar / Cartera' },
      { name: 'StockAlerts', description: 'Alertas de stock' },
      { name: 'Dashboard', description: 'KPIs y métricas del dashboard' },
      { name: 'Reports', description: 'Reportes de inventario' },
      { name: 'Tenant', description: 'Configuración de la empresa' },
      { name: 'Announcements', description: 'Anuncios del sistema' },
    ],
  },
  apis: ['./src/docs/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;