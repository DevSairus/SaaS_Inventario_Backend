// backend/src/models/auth/Tenant.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Tenant = sequelize.define('Tenant', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  company_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  slug: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  business_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  tax_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  logo_url: {
    type: DataTypes.STRING,
    allowNull: true
  },
  website: {
    type: DataTypes.STRING,
    allowNull: true
  },

  // Personalización
  primary_color: {
    type: DataTypes.STRING,
    defaultValue: '#3B82F6'
  },
  secondary_color: {
    type: DataTypes.STRING,
    defaultValue: '#1E40AF'
  },
  pdf_config: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  // Configuración tributaria del tenant: tarifas de ReteFuente/ReteIVA/ReteICA
  // e is_autoretenedor. Columna agregada en la migración
  // 2026070302-add-multi-tax-system.js pero nunca declarada aquí -> Sequelize
  // ignoraba lecturas y escrituras en silencio (bug raíz del cálculo de
  // retenciones siempre en 0).
  tax_config: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },

  // Suscripción
  plan: {
    type: DataTypes.STRING,
    defaultValue: 'free',
    validate: {
      isIn: [['free', 'basic', 'premium', 'enterprise']]
    }
  },
  // Fuente de verdad del plan efectivo (límites y módulos). Independiente
  // del estado de tenant_subscriptions (billing/MercadoPago).
  plan_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  // Overrides puntuales de módulos por tenant, además de los del plan
  modules_enabled: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  modules_disabled: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  subscription_status: {
    type: DataTypes.STRING,
    defaultValue: 'trial',
    validate: {
      isIn: [['trial', 'active', 'suspended', 'cancelled']]
    }
  },
  trial_ends_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  subscription_starts_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  next_billing_date: {
    type: DataTypes.DATE,
    allowNull: true
  },

  // Límites del plan
  max_users: {
    type: DataTypes.INTEGER,
    defaultValue: 3
  },
  max_clients: {
    type: DataTypes.INTEGER,
    defaultValue: 50
  },
  max_products: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },
  max_warehouses: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  max_invoices_per_month: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },

  // Features y configuración
  features: {
    type: DataTypes.JSONB,
    defaultValue: {
      basic_reports: true,
      advanced_reports: false,
      barcode_scanner: true,
      multi_warehouse: false,
      api_access: false
    }
  },
  business_config: {
    type: DataTypes.JSONB,
    defaultValue: {
      currency: 'COP',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      date_format: 'DD/MM/YYYY',
      cost_method: 'weighted_average',
      // % estimado de costo de mano de obra (comisión a técnicos) sobre el
      // ingreso de servicios, usado en reportes cuando la OT aún no ha sido
      // liquidada (no hay commission_percentage real todavía). Ver
      // services/workshop/laborCost.service.js.
      default_labor_cost_percentage: 40
    }
  },

  // Schema dedicado (arquitectura schema-per-tenant). NULL = tenant todavía
  // en modo legado (public + tenant_id). Ver src/middleware/tenant.js y
  // src/config/registerTenantSchemaHooks.js.
  schema_name: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },

  // Estado
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  // Configuración DIAN - Facturación Electrónica
  dian_config: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
    comment: 'Configuración DIAN: NIT, software_id, certificado, resoluciones, etc.'
  },

  // Facturación centralizada vía el Núcleo Central de Facturación (NCF) de
  // ESC DataCore. No hay tabla aparte -- la sincronización es por sistema
  // completo (ver ncfSyncService.js), esto es solo el estado de la última
  // prefactura enviada para este tenant.
  ncf_sync_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'true = listo para incluirse en la sincronización NCF (cron o botón manual) -- se marca a propósito después de cargar ciudad/tarifa/fecha de cobro',
  },
  ncf_city_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Código DIVIPOLA (DANE) -- fuente de verdad; ncf_ciudad es el nombre derivado de este código',
  },
  ncf_ciudad: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  ncf_regimen_code: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'O-47',
  },
  ncf_external_ref: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  ncf_last_sync_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  ncf_last_status: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  ncf_payment_link_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  ncf_last_error: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  // Fase 5 (visibilidad operativa) del plan de schema-per-tenant.
  cutover_last_attempt_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  cutover_last_status: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  cutover_last_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },

  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'tenants',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Tenant;