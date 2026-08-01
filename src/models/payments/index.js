/**
 * Módulo de Pagos y Configuración de MercadoPago y NCF (Núcleo Central de
 * Facturación de ESC DataCore)
 * Exports: SuperAdminMercadoPagoConfig, TenantMercadoPagoConfig, NcfConfig
 */

const SuperAdminMercadoPagoConfig = require('./SuperAdminMercadoPagoConfig');
const TenantMercadoPagoConfig = require('./TenantMercadoPagoConfig');
const NcfConfig = require('./NcfConfig');
const MetaConfig = require('./MetaConfig');
const TenantMetaConfig = require('./TenantMetaConfig');

module.exports = {
  SuperAdminMercadoPagoConfig,
  TenantMercadoPagoConfig,
  NcfConfig,
  MetaConfig,
  TenantMetaConfig,
};
