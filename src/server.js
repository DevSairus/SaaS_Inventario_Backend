require('dotenv').config();
const validateEnv = require('./config/validateEnv');
try { validateEnv(); } catch (e) { console.error('[ENV] Advertencia:', e.message); }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const { testConnection } = require('./config/database');
const { runMigrations } = require('./database/migrator');
const { authMiddleware } = require('./middleware/auth');
const { tenantMiddleware } = require('./middleware/tenant');
const { branchMiddleware } = require('./middleware/branch');
const { requireModule } = require('./middleware/checkModule');
const { generalLimiter, authLimiter } = require('./middleware/rateLimiter');

// Cargar asociaciones de modelos (debe ejecutarse antes de cualquier ruta)
require('./models');

const app = express();

// ✅ CRÍTICO para Vercel y cualquier proxy inverso:
// Sin esto, express-rate-limit no puede leer IPs reales desde X-Forwarded-For,
// lo que hace que TODOS los usuarios compartan el mismo cupo de rate limit
// y tenants distintos se bloqueen entre sí.
app.set('trust proxy', 1);

// ================= MIDDLEWARE =================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],  // unsafe-eval necesario para algunos bundlers en dev
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false, // evita romper PDF embeds
}));
app.set('etag', false);

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://saa-s-inventario-frontend.vercel.app',
  'https://pitbox.esc-datacore.com',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim()] : []),
].filter(Boolean);

// Patrones adicionales: cualquier preview/branch de Vercel del proyecto frontend
const allowedOriginPatterns = [
  /^https:\/\/saa-s-inventario-frontend[\w-]*\.vercel\.app$/,
  /^https:\/\/saa-s-inventario-frontend-[\w-]+-devsairus-projects\.vercel\.app$/,
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (allowedOriginPatterns.some(pattern => pattern.test(origin))) return callback(null, true);
    console.warn(`[CORS] Bloqueado para: ${origin}`);
    callback(new Error(`CORS bloqueado para: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // x-branch-id: header custom usado por branchMiddleware (Fase 3 multi-sede) para
  // indicar la sede activa en cada request; sin incluirlo aquí el navegador bloquea
  // el preflight de TODAS las rutas que lo envían (branches, warehouses, sales, etc.)
  allowedHeaders: ['Content-Type', 'Authorization', 'x-branch-id'],
  optionsSuccessStatus: 200, // algunos navegadores (IE11) usan 204 y fallan
};

// Responder preflight OPTIONS en TODAS las rutas antes de cualquier middleware
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ================= SWAGGER =================
const swaggerUiOptions = {
  customSiteTitle: 'Pitbox API — Docs',
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
  swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, docExpansion: 'none', filter: true },
};

// Swagger solo disponible fuera de producción
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
  app.get('/api/docs.json', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.send(swaggerSpec); });
} else {
  // En producción — docs solo para super_admin autenticado
  const { authMiddleware: _am } = require('./middleware/auth');
  const { checkRole: _cr } = require('./middleware/auth');
  app.use('/api/docs', _am, _cr('super_admin'), swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
  app.get('/api/docs.json', _am, _cr('super_admin'), (req, res) => { res.setHeader('Content-Type', 'application/json'); res.send(swaggerSpec); });
}

// ================= ROUTES =================
const authRoutes                    = require('./routes/auth/auth.routes');
const productsRoutes                = require('./routes/inventory/products.routes');
const categoriesRoutes              = require('./routes/inventory/categories.routes');
const suppliersRoutes               = require('./routes/inventory/suppliers.routes');
const purchasesRoutes               = require('./routes/inventory/purchases.routes');
const movementsRoutes               = require('./routes/inventory/movements.routes');
const adjustmentsRoutes             = require('./routes/inventory/adjustments.routes');
const warehousesRoutes              = require('./routes/inventory/warehouses.routes');
const branchesRoutes                = require('./routes/branches.routes');
const stockAlertsRoutes             = require('./routes/stockAlerts.routes');
const superadminRoutes              = require('./routes/superadmin.routes');
const salesRoutes                   = require('./routes/sales.routes');
const customersRoutes               = require('./routes/customers.routes');
const tenantRoutes                  = require('./routes/tenant.routes');
const reportsRoutes                 = require('./routes/reports.routes');
const dashboardRoutes               = require('./routes/dashboard.routes');
const invoiceImportRoutes           = require('./routes/invoiceImport.routes');
const permissionsRoutes             = require('./routes/permissions.routes');
const vehiclesRoutes                = require('./routes/workshop/vehicles.routes');
const workOrdersRoutes              = require('./routes/workshop/workOrders.routes');
const commissionSettlementsRoutes   = require('./routes/workshop/commissionSettlements.routes');
const runtRoutes                    = require('./routes/workshop/runt.routes');
const userRoutes                    = require('./routes/user.routes');

// Movimientos Avanzados
const supplierReturnsRoutes         = require('./routes/inventory/supplierReturns.routes');
const transfersRoutes               = require('./routes/inventory/transfers.routes');
const internalConsumptionsRoutes    = require('./routes/inventory/internalConsumptions.routes');
const customerReturnsRoutes         = require('./routes/sales/customerReturns.routes');

// Anuncios
const announcementsRoutes           = require('./routes/announcements.routes');

// Cartera
const accountsReceivableRoutes      = require('./routes/accounts-receivable.routes');
const accountsPayableRoutes         = require('./routes/accounts-payable.routes');
const expensesRoutes                = require('./routes/expenses.routes');
const cashflowRoutes                = require('./routes/cashflow.routes');
const cashSessionsRoutes            = require('./routes/cashSessions.routes');

// Públicas y Cron
const publicRoutes                  = require('./routes/public.routes');
const cronRoutes                    = require('./routes/cron.routes');

// ✅ DIAN — Facturación Electrónica
const whatsappRoutes  = require('./routes/whatsapp.routes');
const publicPdfRoutes = require('./routes/publicPdf.routes');
const dianRoutes                    = require('./routes/dian.routes');

// Rate limiting global
app.use('/api/', generalLimiter);

// ── Rutas PÚBLICAS (sin auth) ──
app.use('/api/public', publicRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/auth', authRoutes);

// ── Super Admin (sin tenant) ──
// Ruta pública para PDFs compartidos (sin auth, token JWT temporal)
app.use('/api/public/pdf', publicPdfRoutes);

app.use('/api/superadmin', authMiddleware, superadminRoutes);

// ── Anuncios (sin tenant) ──
app.use('/api/announcements', authMiddleware, announcementsRoutes);

// ── Permisos (sin tenant) ──
app.use('/api/permissions', authMiddleware, permissionsRoutes);

// ── Taller (módulo: workshop) ──
app.use('/api/workshop/vehicles/runt',         authMiddleware, tenantMiddleware, requireModule('workshop'), runtRoutes);
app.use('/api/workshop/vehicles',              authMiddleware, tenantMiddleware, requireModule('workshop'), vehiclesRoutes);
app.use('/api/workshop/work-orders',           authMiddleware, tenantMiddleware, requireModule('workshop'), branchMiddleware, workOrdersRoutes);
app.use('/api/workshop/commission-settlements',authMiddleware, tenantMiddleware, requireModule('workshop'), commissionSettlementsRoutes);

// ── Inventario (módulo: inventory) ──
app.use('/api/products',                       authMiddleware, tenantMiddleware, requireModule('inventory'), productsRoutes);
app.use('/api/categories',                     authMiddleware, tenantMiddleware, requireModule('inventory'), categoriesRoutes);
app.use('/api/inventory/suppliers',            authMiddleware, tenantMiddleware, requireModule('inventory'), suppliersRoutes);
app.use('/api/inventory/purchases',            authMiddleware, tenantMiddleware, requireModule('inventory'), branchMiddleware, purchasesRoutes);
app.use('/api/inventory/movements',            authMiddleware, tenantMiddleware, requireModule('inventory'), movementsRoutes);
app.use('/api/inventory/adjustments',          authMiddleware, tenantMiddleware, requireModule('inventory'), adjustmentsRoutes);
app.use('/api/inventory/warehouses',           authMiddleware, tenantMiddleware, requireModule('inventory'), warehousesRoutes);
// Sedes: infraestructura transversal usada por varios módulos — sin gating.
app.use('/api/branches',                       authMiddleware, tenantMiddleware, branchesRoutes);
app.use('/api/stock-alerts',                   authMiddleware, tenantMiddleware, requireModule('inventory'), stockAlertsRoutes);
app.use('/api/dashboard',                      authMiddleware, tenantMiddleware, dashboardRoutes);

// Estas rutas específicas ANTES de /api/sales para evitar conflicto con /:id
app.use('/api/sales/customer-returns',         authMiddleware, tenantMiddleware, requireModule('sales'), branchMiddleware, customerReturnsRoutes);
app.use('/api/inventory/supplier-returns',     authMiddleware, tenantMiddleware, requireModule('inventory'), branchMiddleware, supplierReturnsRoutes);
app.use('/api/inventory/transfers',            authMiddleware, tenantMiddleware, requireModule('inventory'), transfersRoutes);
app.use('/api/inventory/internal-consumptions',authMiddleware, tenantMiddleware, requireModule('inventory'), branchMiddleware, internalConsumptionsRoutes);

// ── Ventas (módulo: sales — genéricas, después de las específicas) ──
app.use('/api/sales',                          authMiddleware, tenantMiddleware, requireModule('sales'), branchMiddleware, salesRoutes);
app.use('/api/customers',                      authMiddleware, tenantMiddleware, requireModule('sales'), customersRoutes);
// ── Cartera (módulo: receivables) ──
app.use('/api/accounts-receivable',            authMiddleware, tenantMiddleware, requireModule('receivables'), accountsReceivableRoutes);
// ── Tesorería (módulo: treasury) ──
app.use('/api/accounts-payable',               authMiddleware, tenantMiddleware, requireModule('treasury'), branchMiddleware, accountsPayableRoutes);
app.use('/api/expenses',                       authMiddleware, tenantMiddleware, requireModule('treasury'), branchMiddleware, expensesRoutes);
app.use('/api/cashflow',                       authMiddleware, tenantMiddleware, requireModule('treasury'), branchMiddleware, cashflowRoutes);
app.use('/api/cash-sessions',                  authMiddleware, tenantMiddleware, requireModule('treasury'), branchMiddleware, cashSessionsRoutes);
// Núcleo — sin gating de módulo.
app.use('/api/tenant',                         authMiddleware, tenantMiddleware, tenantRoutes);
app.use('/api/inventory/reports',              authMiddleware, tenantMiddleware, requireModule('inventory'), reportsRoutes);
app.use('/api/invoice-import',                 authMiddleware, tenantMiddleware, requireModule('inventory'), branchMiddleware, invoiceImportRoutes);
app.use('/api/users',                          authMiddleware, tenantMiddleware, userRoutes);

// ✅ DIAN — Facturación Electrónica: vive dentro de Ventas, siempre incluida
// en el plan base. Se gatea con el módulo "sales", no con uno propio.
app.use('/api/whatsapp',                      authMiddleware, whatsappRoutes);
app.use('/api/dian',                           authMiddleware, tenantMiddleware, requireModule('sales'), branchMiddleware, dianRoutes);

const path = require('path');
// /uploads/logos eliminado — logos ahora en Cloudinary (Vercel stateless)

// ================= HEALTH =================
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'API funcionando correctamente', timestamp: new Date().toISOString() });
});

app.get('/api/test-db', async (req, res) => {
  const connected = await testConnection();
  res.json({ success: connected, message: connected ? 'Base de datos conectada' : 'Error de conexión' });
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
  res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});

// ================= START =================
// Vercel = serverless: no llamar app.listen(), usar module.exports = app
// Local / Railway / Render: levantar servidor normal
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, async () => {
    console.log('Servidor corriendo en puerto ' + PORT);
    const connected = await testConnection();
    console.log(connected ? 'DB conectada OK' : 'ERROR: DB no conectada');

    // Ejecutar migraciones pendientes automáticamente
    if (connected) {
      try {
        await runMigrations();
      } catch (err) {
        console.error('[Migrator] Error ejecutando migraciones:', err.message);
      }
    }
  });
} else {
  // Warm-up de conexion en serverless
  testConnection().then(async (ok) => {
    if (!ok) {
      console.error('[Vercel] No se pudo conectar a la BD al iniciar');
      return;
    }
    // Ejecutar migraciones pendientes en serverless
    try {
      await runMigrations();
    } catch (err) {
      console.error('[Migrator] Error ejecutando migraciones:', err.message);
    }
  });
}

module.exports = app;