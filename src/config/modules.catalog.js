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
  { key: 'accounting', label: 'Contabilidad', dependsOn: ['treasury', 'sales', 'inventory'], reserved: true },
  { key: 'ai_assistant', label: 'Asistente IA', dependsOn: [], reserved: true },
];

const MODULES_BY_KEY = MODULES_CATALOG.reduce((acc, m) => {
  acc[m.key] = m;
  return acc;
}, {});

const MODULE_KEYS = MODULES_CATALOG.map((m) => m.key);

module.exports = { MODULES_CATALOG, MODULES_BY_KEY, MODULE_KEYS };
