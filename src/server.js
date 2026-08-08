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
const { authMiddleware, checkRole } = require('./middleware/auth');
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
  'http://localhost:5172',
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
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    // Se guarda el body crudo para poder validar firmas HMAC de webhooks
    // entrantes (ej. NCF) sin depender de reserializar el JSON parseado,
    // que podría no coincidir byte a byte con lo que se firmó del otro lado.
    req.rawBody = buf;
  },
}));
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
const accountingRoutes              = require('./routes/accounting/accounting.routes');
const aiAssistantRoutes              = require('./routes/ai/aiAssistant.routes');
const permissionsRoutes             = require('./routes/permissions.routes');
const vehiclesRoutes                = require('./routes/workshop/vehicles.routes');
const workOrdersRoutes              = require('./routes/workshop/workOrders.routes');
const commissionSettlementsRoutes   = require('./routes/workshop/commissionSettlements.routes');
const runtRoutes                    = require('./routes/workshop/runt.routes');
const diagramTemplatesRoutes        = require('./routes/workshop/diagramTemplates.routes');
const userRoutes                    = require('./routes/user.routes');

// Movimientos Avanzados
const supplierReturnsRoutes         = require('./routes/inventory/supplierReturns.routes');
const transfersRoutes               = require('./routes/inventory/transfers.routes');
const internalConsumptionsRoutes    = require('./routes/inventory/internalConsumptions.routes');
const customerReturnsRoutes         = require('./routes/sales/customerReturns.routes');
const saleWorkshopDiagnosisRoutes   = require('./routes/sales/workshopDiagnosis.routes');
const crmCustomers360Routes         = require('./routes/crm/customers360.routes');
const crmOpportunitiesRoutes        = require('./routes/crm/opportunities.routes');
const crmFollowupsRoutes            = require('./routes/crm/followups.routes');
const crmTagsRoutes                 = require('./routes/crm/tags.routes');
const crmDashboardRoutes            = require('./routes/crm/dashboard.routes');
const crmMetaIntegrationRoutes      = require('./routes/crm/metaIntegration.routes');
const crmPipelineStagesRoutes       = require('./routes/crm/pipelineStages.routes');
const crmLossReasonsRoutes          = require('./routes/crm/lossReasons.routes');
const crmMessageTemplatesRoutes     = require('./routes/crm/messageTemplates.routes');
const crmAutomationRulesRoutes      = require('./routes/crm/automationRules.routes');

// Anuncios
const announcementsRoutes           = require('./routes/announcements.routes');

// Soporte
const supportRoutes                 = require('./routes/support.routes');
const superadminSupportRoutes       = require('./routes/superadmin/support.routes');

// Cartera
const accountsReceivableRoutes      = require('./routes/accounts-receivable.routes');
const accountsPayableRoutes         = require('./routes/accounts-payable.routes');
const expensesRoutes                = require('./routes/expenses.routes');
const cashflowRoutes                = require('./routes/cashflow.routes');
const cashSessionsRoutes            = require('./routes/cashSessions.routes');
const receiptsRoutes                = require('./routes/receipts.routes');

// Públicas y Cron
const publicRoutes                  = require('./routes/public.routes');
const cronRoutes                    = require('./routes/cron.routes');

// ✅ DIAN — Facturación Electrónica
const whatsappRoutes  = require('./routes/whatsapp.routes');
const publicPdfRoutes = require('./routes/publicPdf.routes');
const ncfWebhookRoutes = require('./routes/ncfWebhook.routes');
const metaWebhookRoutes = require('./routes/metaWebhook.routes');
const dianRoutes                    = require('./routes/dian.routes');
const ensambladoraSyncRoutes        = require('./routes/ensambladora/sync.routes');
const ensambladoraEventsRoutes      = require('./routes/ensambladora/events.routes');
const ensambladoraVehiculosRoutes   = require('./routes/ensambladora/vehiculos.routes');
const ensambladoraCicloVidaRoutes   = require('./routes/ensambladora/ciclovida.routes');
const ensambladoraGarantiasRoutes   = require('./routes/ensambladora/garantias.routes');
const ensambladoraLiquidacionesRoutes = require('./routes/ensambladora/liquidaciones.routes');
const ensambladoraTecnicosRoutes    = require('./routes/ensambladora/tecnicos.routes');
const ensambladoraRuntRoutes        = require('./routes/ensambladora/runt.routes');

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
app.use('/api/superadmin/support', authMiddleware, superadminSupportRoutes);
app.use('/api/webhooks/ncf', ncfWebhookRoutes);
app.use('/api/webhooks/meta', metaWebhookRoutes);
app.use('/api/webhooks/ensambladora/sync', ensambladoraSyncRoutes);

// ── Anuncios (sin tenant) ──
app.use('/api/announcements', authMiddleware, announcementsRoutes);

// ── Soporte (con tenant) ──
app.use('/api/support', authMiddleware, tenantMiddleware, supportRoutes);

// ── Permisos (sin tenant) ──
app.use('/api/permissions', authMiddleware, permissionsRoutes);

// ── Taller ──
app.use('/api/workshop/vehicles/runt',         authMiddleware, tenantMiddleware, runtRoutes);
app.use('/api/workshop/vehicles',              authMiddleware, tenantMiddleware, vehiclesRoutes);
app.use('/api/workshop/work-orders',           authMiddleware, tenantMiddleware, branchMiddleware, workOrdersRoutes);
app.use('/api/workshop/commission-settlements',authMiddleware, tenantMiddleware, commissionSettlementsRoutes);
app.use('/api/workshop/diagram-templates',     authMiddleware, tenantMiddleware, diagramTemplatesRoutes);

// ── Inventario ──
app.use('/api/products',                       authMiddleware, tenantMiddleware, productsRoutes);
app.use('/api/categories',                     authMiddleware, tenantMiddleware, categoriesRoutes);
app.use('/api/inventory/suppliers',            authMiddleware, tenantMiddleware, suppliersRoutes);
app.use('/api/inventory/purchases',            authMiddleware, tenantMiddleware, branchMiddleware, purchasesRoutes);
app.use('/api/inventory/movements',            authMiddleware, tenantMiddleware, branchMiddleware, movementsRoutes);
app.use('/api/inventory/adjustments',          authMiddleware, tenantMiddleware, adjustmentsRoutes);
app.use('/api/inventory/warehouses',           authMiddleware, tenantMiddleware, warehousesRoutes);
app.use('/api/branches',                       authMiddleware, tenantMiddleware, branchesRoutes);
app.use('/api/stock-alerts',                   authMiddleware, stockAlertsRoutes);
app.use('/api/dashboard',                      authMiddleware, tenantMiddleware, dashboardRoutes);

// Estas rutas específicas ANTES de /api/sales para evitar conflicto con /:id
app.use('/api/sales/customer-returns',         authMiddleware, tenantMiddleware, branchMiddleware, customerReturnsRoutes);
app.use('/api/inventory/supplier-returns',     authMiddleware, tenantMiddleware, branchMiddleware, supplierReturnsRoutes);
app.use('/api/inventory/transfers',            authMiddleware, tenantMiddleware, branchMiddleware, transfersRoutes);
app.use('/api/inventory/internal-consumptions',authMiddleware, tenantMiddleware, branchMiddleware, internalConsumptionsRoutes);

// ── Ventas (genéricas — después de las específicas) ──
app.use('/api/sales',                          authMiddleware, tenantMiddleware, branchMiddleware, salesRoutes);
// Mapa de intervención + conversión a OT en cotizaciones — mismo prefijo
// /api/sales, pero solo para tenants con el módulo Taller activo.
app.use('/api/sales',                          authMiddleware, tenantMiddleware, branchMiddleware, requireModule('workshop'), saleWorkshopDiagnosisRoutes);
app.use('/api/customers',                      authMiddleware, tenantMiddleware, customersRoutes);
// CRM (Fase 1): interacciones, vista 360°, asignación de cuenta. Núcleo
// genérico — no depende de Taller (ver módulo 'crm' en modules.catalog.js).
app.use('/api/crm/customers',                  authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmCustomers360Routes);
app.use('/api/crm/opportunities',              authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmOpportunitiesRoutes);
app.use('/api/crm/followups',                  authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmFollowupsRoutes);
app.use('/api/crm/tags',                       authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmTagsRoutes);
app.use('/api/crm/dashboard',                  authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmDashboardRoutes);
app.use('/api/crm/meta-integration',           authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm_meta_leads'), crmMetaIntegrationRoutes);
app.use('/api/crm/pipeline-stages',            authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmPipelineStagesRoutes);
app.use('/api/crm/loss-reasons',                authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmLossReasonsRoutes);
app.use('/api/crm/message-templates',          authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmMessageTemplatesRoutes);
app.use('/api/crm/automation-rules',           authMiddleware, tenantMiddleware, branchMiddleware, requireModule('crm'), crmAutomationRulesRoutes);
app.use('/api/accounts-receivable',            authMiddleware, tenantMiddleware, accountsReceivableRoutes);
app.use('/api/accounts-payable',               authMiddleware, tenantMiddleware, branchMiddleware, requireModule('treasury'), accountsPayableRoutes);
app.use('/api/expenses',                       authMiddleware, tenantMiddleware, branchMiddleware, requireModule('treasury'), expensesRoutes);
app.use('/api/cashflow',                       authMiddleware, tenantMiddleware, branchMiddleware, requireModule('treasury'), cashflowRoutes);
app.use('/api/cash-sessions',                  authMiddleware, tenantMiddleware, branchMiddleware, requireModule('treasury'), cashSessionsRoutes);
app.use('/api/receipts',                       authMiddleware, tenantMiddleware, branchMiddleware, requireModule('treasury'), receiptsRoutes);
app.use('/api/tenant',                         authMiddleware, tenantMiddleware, tenantRoutes);
app.use('/api/inventory/reports',              authMiddleware, tenantMiddleware, branchMiddleware, reportsRoutes);
app.use('/api/invoice-import',                 authMiddleware, tenantMiddleware, branchMiddleware, invoiceImportRoutes);
app.use('/api/users',                          authMiddleware, tenantMiddleware, userRoutes);

// ✅ DIAN — Facturación Electrónica (con tenant)
app.use('/api/whatsapp',                      authMiddleware, whatsappRoutes);
app.use('/api/dian',                           authMiddleware, tenantMiddleware, branchMiddleware, dianRoutes);
// Contabilidad: mismo mecanismo que ya usa el resto de la app (checkRole +
// requireModule). Roles reales del sistema (ver User.js): super_admin, admin,
// manager, seller, warehouse_keeper, accountant, user, viewer, technician,
// support — de esos, solo admin/super_admin/manager/accountant tienen
// sentido para tocar libros contables. requireModule('accounting') además
// exige que el tenant tenga el módulo contratado (antes no se validaba acá,
// solo se ocultaba el menú en el frontend).
// Sin esta línea, cualquier usuario autenticado del tenant (un vendedor, un
// bodeguero) podía postear, anular o reversar asientos, o cambiar el mapeo
// de cuentas — no había segregación de funciones.
app.use('/api/accounting',                     authMiddleware, tenantMiddleware, branchMiddleware, requireModule('accounting'), checkRole('admin', 'super_admin', 'manager', 'accountant'), accountingRoutes);
app.use('/api/ai-assistant',                   authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ai_assistant'), aiAssistantRoutes);
app.use('/api/ensambladora/sync',              authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraEventsRoutes);
app.use('/api/ensambladora/vehiculos',          authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraVehiculosRoutes);
app.use('/api/ensambladora/garantias',          authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraGarantiasRoutes);
app.use('/api/ensambladora/tecnicos',           authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraTecnicosRoutes);
app.use('/api/ensambladora/runt',               authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraRuntRoutes);
app.use('/api/ensambladora',                    authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraLiquidacionesRoutes);
app.use('/api/ensambladora',                    authMiddleware, tenantMiddleware, branchMiddleware, requireModule('ensambladora'), ensambladoraCicloVidaRoutes);

const path = require('path');
// /uploads/logos eliminado — logos ahora en Cloudinary (Vercel stateless)
// Archivos de soporte (fallback local cuando no hay Cloudinary)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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
  const http = require('http');
  const server = http.createServer(app);

  // Socket.io — señalización para acceso remoto
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
  require('./services/remoteSupportSignaling')(io);

  // Notificaciones en vivo de tickets
  const { initTicketNotifications } = require('./services/ticketNotifications.socket');
  initTicketNotifications(io);

  // Notificaciones en vivo de cotizaciones de OT aprobadas por el cliente
  const { initQuoteNotifications } = require('./services/quoteNotifications.socket');
  initQuoteNotifications(io);

  server.listen(PORT, async () => {
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

      // Propagar esas mismas migraciones a cada schema de tenant ya
      // cortado (schema-per-tenant) -- sin esto, runMigrations() de arriba
      // solo deja `public` al día y cada tenant migrado se va desalineando
      // con cada release nueva. Desactivable con
      // ENABLE_TENANT_SCHEMA_MIGRATIONS=false (ej. para correrlo aparte a
      // mano en vez de en cada arranque, si el número de tenants crece
      // demasiado para hacerlo en cada deploy).
      if (process.env.ENABLE_TENANT_SCHEMA_MIGRATIONS !== 'false') {
        try {
          const { migrateAllTenantSchemas } = require('./scripts/migrateAllTenantSchemas');
          const result = await migrateAllTenantSchemas();
          console.log(`[Migrator] Schemas de tenant: ${result.ok.length}/${result.total} al día` + (result.failed.length ? `, ${result.failed.length} con errores (ver log arriba)` : ''));
        } catch (err) {
          console.error('[Migrator] Error propagando migraciones a schemas de tenant:', err.message);
        }
      }

      // Siembrar diagramas base si no existen (o actualizar si cambiaron)
      try {
        const { seedDiagramTemplates } = require('./services/seedDiagramTemplates');
        await seedDiagramTemplates();
      } catch (err) {
        console.error('[Seed] Error al sembrar diagram templates:', err.message);
      }

      // Jobs programados (vehicle-reminders, stock-alerts, ncf-sync) --
      // corren dentro de este mismo proceso porque Railway lo mantiene
      // vivo 24/7 (a diferencia de Vercel serverless, donde no aplicaría).
      // Ver src/jobs/scheduler.js -- desactivable con ENABLE_CRON_SCHEDULER=false.
      try {
        const { iniciarScheduler } = require('./jobs/scheduler');
        iniciarScheduler();
      } catch (err) {
        console.error('[Scheduler] Error al iniciar los jobs programados:', err.message);
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
    // Propagar a cada schema de tenant ya cortado -- ver comentario en la
    // rama Railway/local más arriba.
    if (process.env.ENABLE_TENANT_SCHEMA_MIGRATIONS !== 'false') {
      try {
        const { migrateAllTenantSchemas } = require('./scripts/migrateAllTenantSchemas');
        const result = await migrateAllTenantSchemas();
        console.log(`[Migrator] Schemas de tenant: ${result.ok.length}/${result.total} al día` + (result.failed.length ? `, ${result.failed.length} con errores (ver log arriba)` : ''));
      } catch (err) {
        console.error('[Migrator] Error propagando migraciones a schemas de tenant:', err.message);
      }
    }
    // Siembrar diagramas base
    try {
      const { seedDiagramTemplates } = require('./services/seedDiagramTemplates');
      await seedDiagramTemplates();
    } catch (err) {
      console.error('[Seed] Error al sembrar diagram templates:', err.message);
    }
  });
}

module.exports = app;