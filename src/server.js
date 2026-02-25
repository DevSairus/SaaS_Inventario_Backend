require('dotenv').config();
const validateEnv = require('./config/validateEnv');
validateEnv();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const { testConnection } = require('./config/database');
const { authMiddleware } = require('./middleware/auth');
const { tenantMiddleware } = require('./middleware/tenant');
const { generalLimiter, authLimiter } = require('./middleware/rateLimiter');

// Cargar asociaciones de modelos (debe ejecutarse antes de cualquier ruta)
require('./models');

const app = express();

// ================= MIDDLEWARE =================
app.use(helmet({
  contentSecurityPolicy: false, // Necesario para Swagger UI
}));
app.set('etag', false);
// CORS: soporta múltiples orígenes (local + producción)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim()] : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (Postman, móvil, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS bloqueado para: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= SWAGGER =================
// Usamos CDN para los assets de Swagger UI porque Vercel (serverless)
// no puede servir archivos estáticos locales del paquete npm correctamente.
const swaggerUiOptions = {
  customSiteTitle: 'API Inventario — Docs',
  customCssUrl: 'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css',
  customJs: [
    'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.min.js',
  ],
  customCss: `
    .swagger-ui .topbar { background: linear-gradient(135deg, #4f46e5, #7c3aed); }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
    .swagger-ui .info .title { color: #1e1b4b; }
    .swagger-ui .btn.authorize { background: #4f46e5; border-color: #4f46e5; }
    .swagger-ui .btn.authorize svg { fill: #fff; }
  `,
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'none',
    filter: true,
  },
};

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

// Spec en JSON — útil para importar en Postman o Insomnia
app.get('/api/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// ================= ROUTES =================
const authRoutes = require('./routes/auth/auth.routes');
const productsRoutes = require('./routes/inventory/products.routes');
const categoriesRoutes = require('./routes/inventory/categories.routes');
const suppliersRoutes = require('./routes/inventory/suppliers.routes');
const purchasesRoutes = require('./routes/inventory/purchases.routes');
const movementsRoutes = require('./routes/inventory/movements.routes');
const adjustmentsRoutes = require('./routes/inventory/adjustments.routes');
const warehousesRoutes = require('./routes/inventory/warehouses.routes');
const stockAlertsRoutes = require('./routes/stockAlerts.routes');
const superadminRoutes = require('./routes/superadmin.routes');
const salesRoutes = require('./routes/sales.routes');
const customersRoutes = require('./routes/customers.routes');
const tenantRoutes = require('./routes/tenant.routes');
const reportsRoutes = require('./routes/reports.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const invoiceImportRoutes = require('./routes/invoiceImport.routes');
const permissionsRoutes = require('./routes/permissions.routes');
const vehiclesRoutes = require('./routes/workshop/vehicles.routes');
const workOrdersRoutes = require('./routes/workshop/workOrders.routes');
const commissionSettlementsRoutes = require('./routes/workshop/commissionSettlements.routes');
const userRoutes = require('./routes/user.routes');

// Movimientos Avanzados
const supplierReturnsRoutes = require('./routes/inventory/supplierReturns.routes');
const transfersRoutes = require('./routes/inventory/transfers.routes');
const internalConsumptionsRoutes = require('./routes/inventory/internalConsumptions.routes');
const customerReturnsRoutes = require('./routes/sales/customerReturns.routes');

// ✅ NUEVO: Sistema de Anuncios
const announcementsRoutes = require('./routes/announcements.routes');

// ✅ NUEVO: Gestión de Cartera (Cuentas por Cobrar)
const accountsReceivableRoutes = require('./routes/accounts-receivable.routes');

// Rate limiting global
app.use('/api/', generalLimiter);

// Public
app.use('/api/auth', authRoutes);

// Super Admin Routes (sin tenant middleware)
app.use('/api/superadmin', authMiddleware, superadminRoutes);

// ✅ NUEVO: Anuncios (requiere autenticación, NO requiere tenant)
// Los anuncios funcionan para todos los usuarios (tenants y superadmin)
app.use('/api/announcements', authMiddleware, announcementsRoutes);

// Permisos (superadmin sin tenant)
app.use('/api/permissions', authMiddleware, permissionsRoutes);

// ── TALLER ──
app.use('/api/workshop/vehicles', authMiddleware, tenantMiddleware, vehiclesRoutes);
app.use('/api/workshop/work-orders', authMiddleware, tenantMiddleware, workOrdersRoutes);
app.use('/api/workshop/commission-settlements', authMiddleware, tenantMiddleware, commissionSettlementsRoutes);

// Protected (con tenant middleware)
app.use('/api/products', authMiddleware, tenantMiddleware, productsRoutes);
app.use('/api/categories', authMiddleware, tenantMiddleware, categoriesRoutes);
app.use('/api/inventory/suppliers', authMiddleware, tenantMiddleware, suppliersRoutes);
app.use('/api/inventory/purchases', authMiddleware, tenantMiddleware, purchasesRoutes);
app.use('/api/inventory/movements', authMiddleware, tenantMiddleware, movementsRoutes);
app.use('/api/inventory/adjustments', authMiddleware, tenantMiddleware, adjustmentsRoutes);
app.use('/api/inventory/warehouses', authMiddleware, tenantMiddleware, warehousesRoutes);
app.use('/api/stock-alerts', authMiddleware, stockAlertsRoutes);
app.use('/api/dashboard', authMiddleware, tenantMiddleware, dashboardRoutes);

// Estas rutas específicas deben registrarse ANTES de /api/sales para evitar conflictos con /:id
app.use('/api/sales/customer-returns', authMiddleware, tenantMiddleware, customerReturnsRoutes);
app.use('/api/inventory/supplier-returns', authMiddleware, tenantMiddleware, supplierReturnsRoutes);
app.use('/api/inventory/transfers', authMiddleware, tenantMiddleware, transfersRoutes);
app.use('/api/inventory/internal-consumptions', authMiddleware, tenantMiddleware, internalConsumptionsRoutes);

// Rutas genéricas (van después de las específicas)
app.use('/api/sales', authMiddleware, tenantMiddleware, salesRoutes);
app.use('/api/customers', authMiddleware, tenantMiddleware, customersRoutes);
app.use('/api/accounts-receivable', authMiddleware, tenantMiddleware, accountsReceivableRoutes);
app.use('/api/tenant', authMiddleware, tenantMiddleware, tenantRoutes);
app.use('/api/inventory/reports', authMiddleware, tenantMiddleware, reportsRoutes);
app.use('/api/invoice-import', authMiddleware, tenantMiddleware, invoiceImportRoutes);
app.use('/api/users', authMiddleware, tenantMiddleware, userRoutes);

const path = require('path');
app.use('/uploads/logos', express.static(path.join(__dirname, '../uploads/logos')));

// ================= HEALTH =================
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/test-db', async (req, res) => {
  const connected = await testConnection();
  res.json({
    success: connected,
    message: connected ? 'Base de datos conectada' : 'Error de conexión'
  });
});

// ================= ERRORS =================
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

// ================= START =================
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  const connected = await testConnection();
  console.log(connected ? '✅ DB conectada' : '❌ Error DB');
});

module.exports = app;