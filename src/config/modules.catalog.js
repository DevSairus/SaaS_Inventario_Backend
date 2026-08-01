// backend/src/config/modules.catalog.js
// Catálogo de módulos facturables y sus dependencias duras.
// Fuente única de verdad — usado por moduleAccess.js (backend) y expuesto
// vía GET /api/superadmin/modules-catalog para el frontend de superadmin.

const MODULES_CATALOG = [
  { key: 'workshop', label: 'Taller', dependsOn: ['sales', 'inventory'], reserved: false },
  { key: 'sales', label: 'Ventas', dependsOn: [], reserved: false },
  { key: 'inventory', label: 'Inventario', dependsOn: [], reserved: false },
  { key: 'receivables', label: 'Cartera', dependsOn: ['sales'], reserved: false },
  { key: 'treasury', label: 'Tesorería', dependsOn: ['sales', 'inventory'], reserved: false },
  { key: 'accounting', label: 'Contabilidad', dependsOn: ['treasury', 'sales', 'inventory'], reserved: false },
  { key: 'ai_assistant', label: 'NEXA (Asistente IA)', dependsOn: [], reserved: false },
  // CRM: núcleo (pipeline, interacciones, vista 360°) sirve a cualquier
  // vertical; la conversión cotización→OT se especializa cuando además
  // 'workshop' está activo (ver workOrders.controller.js: convertQuoteToWorkOrder).
  { key: 'crm', label: 'CRM', dependsOn: ['sales'], reserved: false },
  // Integración de leads de Meta (Facebook/Instagram Lead Ads) dentro del
  // pipeline del CRM. Costo separado del CRM base porque en modo "servicio
  // Pitbox" (sin cuenta propia de Meta) hay infraestructura compartida de
  // por medio -- ver TenantMetaConfig.provider_mode.
  { key: 'crm_meta_leads', label: 'CRM: Integración con Meta', dependsOn: ['crm'], reserved: false },
  // Módulo Ensambladora -- operación diaria del centro autorizado (CSA/PDV)
  // sincronizada con el Core Ensambladora (sistema independiente, ver
  // ensambladora-vehiculos-diseno.md). Depende de 'workshop' porque extiende
  // el patrón WorkOrder para alistamiento/entrega/revisión/garantía (que a su
  // vez ya trae 'sales' e 'inventory' por dependencia transitiva).
  { key: 'ensambladora', label: 'Ensambladora', dependsOn: ['workshop'], reserved: false },
];

const MODULES_BY_KEY = MODULES_CATALOG.reduce((acc, m) => {
  acc[m.key] = m;
  return acc;
}, {});

const MODULE_KEYS = MODULES_CATALOG.map((m) => m.key);

module.exports = { MODULES_CATALOG, MODULES_BY_KEY, MODULE_KEYS };
