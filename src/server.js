require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { testConnection } = require('./config/database');
const { authMiddleware } = require('./middleware/auth');
const { tenantMiddleware } = require('./middleware/tenant');

// Cargar asociaciones de modelos (debe ejecutarse antes de cualquier ruta)
require('./models');

const app = express();

// ================= MIDDLEWARE =================
app.use(helmet());
app.set('etag', false);
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
const dashboardRoutes = require('./routes/dashboard.routes'); // ✅ NUEVA LÍNEA

// NUEVAS RUTAS - Movimientos Avanzados
const supplierReturnsRoutes = require('./routes/inventory/supplierReturns.routes');
const transfersRoutes = require('./routes/inventory/transfers.routes');
const internalConsumptionsRoutes = require('./routes/inventory/internalConsumptions.routes');
const customerReturnsRoutes = require('./routes/sales/customerReturns.routes');

// Public
app.use('/api/auth', authRoutes);

// Super Admin Routes (sin tenant middleware)
app.use('/api/superadmin', authMiddleware, superadminRoutes);

// Protected (con tenant middleware)
app.use('/api/products', authMiddleware, tenantMiddleware, productsRoutes);
app.use('/api/categories', authMiddleware, tenantMiddleware, categoriesRoutes);
app.use('/api/inventory/suppliers', authMiddleware, tenantMiddleware, suppliersRoutes);
app.use('/api/inventory/purchases', authMiddleware, tenantMiddleware, purchasesRoutes);
app.use('/api/inventory/movements', authMiddleware, tenantMiddleware, movementsRoutes);
app.use('/api/inventory/adjustments', authMiddleware, tenantMiddleware, adjustmentsRoutes);
app.use('/api/inventory/warehouses', authMiddleware, tenantMiddleware, warehousesRoutes);
app.use('/api/stock-alerts', authMiddleware, stockAlertsRoutes);
app.use('/api/dashboard', authMiddleware, tenantMiddleware, dashboardRoutes); // ✅ NUEVA LÍNEA

// RUTAS DE MOVIMIENTOS AVANZADOS - DEBEN IR ANTES DE LAS RUTAS GENÉRICAS
// Estas rutas específicas deben registrarse ANTES de /api/sales para evitar conflictos con /:id
app.use('/api/sales/customer-returns', authMiddleware, tenantMiddleware, customerReturnsRoutes);
app.use('/api/inventory/supplier-returns', authMiddleware, tenantMiddleware, supplierReturnsRoutes);
app.use('/api/inventory/transfers', authMiddleware, tenantMiddleware, transfersRoutes);
app.use('/api/inventory/internal-consumptions', authMiddleware, tenantMiddleware, internalConsumptionsRoutes);

// Rutas genéricas (van después de las específicas)
app.use('/api/sales', authMiddleware, tenantMiddleware, salesRoutes);
app.use('/api/customers', authMiddleware, tenantMiddleware, customersRoutes);
app.use('/api/tenant', authMiddleware, tenantMiddleware, tenantRoutes);
app.use('/api/inventory/reports', authMiddleware, tenantMiddleware, reportsRoutes);

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