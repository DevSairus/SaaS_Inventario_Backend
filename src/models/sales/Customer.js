const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Customer = sequelize.define('Customer', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  customer_type: {
    type: DataTypes.STRING(20),
    defaultValue: 'individual',
  },
  first_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  last_name: {
    type: DataTypes.STRING(255),
  },
  business_name: {
    type: DataTypes.STRING(255),
  },
  trade_name: {
    type: DataTypes.STRING(255),
  },
  tax_id: {
    type: DataTypes.STRING(50),
  },
  email: {
    type: DataTypes.STRING(255),
  },
  phone: {
    type: DataTypes.STRING(20),
  },
  mobile: {
    type: DataTypes.STRING(20),
  },
  address: {
    type: DataTypes.TEXT,
  },
  city: {
    type: DataTypes.STRING(100),
    comment: 'Nombre de la ciudad/municipio — poblado por el selector DIVIPOLA junto con city_code',
  },
  state: {
    type: DataTypes.STRING(100),
    comment: 'Nombre del departamento — poblado por el selector DIVIPOLA junto con city_code',
  },
  city_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Código DIVIPOLA (DANE) de la ciudad/municipio — fuente de verdad para la dirección DIAN del comprador. El departamento se deriva con city_code.substring(0,2), igual que para el emisor.',
  },
  document_type: {
    type: DataTypes.STRING(4),
    allowNull: true,
    defaultValue: '13',
    comment: 'Tipo de identificación DIAN (schemeID): 13=Cédula, 31=NIT, 12=Tarjeta identidad, 21=Tarjeta extranjería, 22=Cédula extranjería, 41=Pasaporte, 91=NUIP, etc.',
  },
  country: {
    type: DataTypes.STRING(100),
    defaultValue: 'Colombia',
  },
  postal_code: {
    type: DataTypes.STRING(20),
  },
  default_price_list_id: {
    type: DataTypes.UUID,
  },
  customer_category: {
    type: DataTypes.STRING(50),
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  notes: {
    type: DataTypes.TEXT,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  // ── CRM (Fase 1) ────────────────────────────────────────────
  owner_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Asesor/vendedor dueño de la cuenta (informativo salvo que is_assigned_account=true)',
  },
  is_assigned_account: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Si es true, solo owner_user_id (o manager/admin) puede cotizar/vender/abrir OT para este cliente',
  },
  lifecycle_stage: {
    type: DataTypes.ENUM('prospecto', 'activo', 'inactivo', 'en_riesgo', 'perdido'),
    allowNull: true,
    comment: 'Calculado por job nocturno a partir de compras e interacciones',
  },
  last_interaction_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Desnormalizado desde CustomerInteraction para ordenar listados sin JOIN',
  },
  next_vehicle_service_due: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: 'Solo aplica con módulo Taller activo — desnormalizado desde Vehicle/WorkOrder',
  },
}, {
  tableName: 'customers',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'is_active'] },
    { fields: ['tenant_id', 'tax_id'], unique: true },
    { fields: ['tenant_id', 'owner_user_id'] },
    { fields: ['tenant_id', 'lifecycle_stage'] },
  ],

  hooks: {
    // Los formularios de creación rápida (OT, Ventas, webhook de WhatsApp/
    // Meta) no piden ciudad DIVIPOLA -- por fricción del flujo, no por
    // descuido: un asesor recibiendo un carro no debería tener que buscar
    // departamento/ciudad para poder guardar el cliente y seguir. Si no
    // llega city_code, se autocompleta con la ciudad configurada del tenant
    // (misma fuente que ya usa el emisor en dianKitAdapter#buildAddress) en
    // vez de quedar en null -- así, al momento de facturar, la mayoría de
    // los clientes ya tienen dato real en vez de caer en el fallback
    // hardcodeado de Bogotá/Cundinamarca (el hallazgo original de la
    // auditoría). Nunca pisa un city_code que sí haya llegado en el body.
    // Si el cliente resulta ser de otra ciudad, se corrige después en su
    // ficha -- el gate de facturación (customerDianReadiness.js) es quien
    // realmente exige el dato correcto antes de emitir, esto es solo un
    // atajo de UX para no bloquear la creación rápida.
    beforeValidate: async (customer, options) => {
      if (customer.city_code) return;
      try {
        const Tenant = require('../auth/Tenant');
        const tenant = await Tenant.findByPk(customer.tenant_id, { transaction: options.transaction });
        const cfg = tenant?.dian_config;
        if (cfg?.city_code) {
          customer.city_code = cfg.city_code;
          if (!customer.city) customer.city = cfg.city || null;
          if (!customer.state) customer.state = cfg.dept || null;
        }
      } catch (e) {
        // No bloquear la creación del cliente si falla este lookup -- el
        // gate de facturación es la fuente de verdad real, esto es best-effort.
      }
    },
  },
});

// Sobrescribe toJSON para agregar full_name al JSON de respuesta
Customer.prototype.toJSON = function () {
  const values = this.get();
  values.full_name = [values.first_name, values.last_name].filter(Boolean).join(' ');
  return values;
};

module.exports = Customer;