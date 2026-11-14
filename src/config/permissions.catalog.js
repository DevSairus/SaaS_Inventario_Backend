// backend/src/config/permissions.catalog.js
//
// Permisos por empresa: acciones que cada empresa puede dar o quitar a
// cualquier rol (Ajustes → Roles y permisos). `roles` es el valor por
// defecto y replica lo que hacían las listas fijas de checkRole() antes de
// existir este catálogo, así que una empresa que no toca nada sigue igual.
// Lo que cada empresa cambia vive en tenant_role_permissions
// (services/tenantPermissions.service.js). super_admin siempre puede.
//
// locked: no se puede quitar al rol admin (evita que una empresa se quede
// sin nadie que administre los permisos).

const TENANT_ROLES = ['admin', 'manager', 'accountant', 'seller', 'warehouse_keeper', 'inventory_lead', 'technician', 'user', 'viewer'];

const ROLE_LABELS = {
  admin: 'Administrador',
  manager: 'Gerente',
  accountant: 'Contador',
  seller: 'Vendedor',
  warehouse_keeper: 'Bodeguero',
  inventory_lead: 'Líder de inventarios',
  technician: 'Técnico',
  user: 'Usuario',
  viewer: 'Visualizador',
};

const ALL = TENANT_ROLES;
const MGMT = ['admin', 'manager'];

const PERMISSIONS = [
  // ── Inventario ──
  // Un permiso por acción y recurso (crear / editar / eliminar / aprobar), para
  // poder dar "crear" sin "eliminar". Los valores por defecto replican lo que
  // hacía cada permiso único anterior (inventory.<recurso>.write), así que una
  // empresa que no toca nada sigue igual; la migración 2026111301 copia lo que
  // cada empresa ya había cambiado a los permisos nuevos.
  { key: 'inventory.products.create', group: 'Inventario', label: 'Crear productos', hint: 'Incluye la importación masiva desde Excel.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.products.edit', group: 'Inventario', label: 'Editar productos', hint: 'Incluye desactivar, equivalencias, aplicaciones a vehículos, imagen y ubicación en bodega.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.products.delete', group: 'Inventario', label: 'Eliminar productos', hint: 'Borrado permanente de un producto sin movimientos.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.costs.edit', group: 'Inventario', label: 'Fijar costos de productos', hint: 'El costo inicial al crear un producto. Después el costo solo cambia con compras y ajustes.', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.categories.create', group: 'Inventario', label: 'Crear categorías', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.categories.edit', group: 'Inventario', label: 'Editar y desactivar categorías', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.categories.delete', group: 'Inventario', label: 'Eliminar categorías', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.warehouses.create', group: 'Inventario', label: 'Crear bodegas', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.warehouses.edit', group: 'Inventario', label: 'Editar bodegas', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.warehouses.delete', group: 'Inventario', label: 'Eliminar bodegas', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.locations.create', group: 'Inventario', label: 'Crear ubicaciones de bodega', hint: 'Pasillo / estante / nivel donde se guarda cada producto.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.locations.edit', group: 'Inventario', label: 'Editar ubicaciones de bodega', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.locations.delete', group: 'Inventario', label: 'Eliminar ubicaciones de bodega', hint: 'Los productos que estaban en la ubicación quedan sin ubicación.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.adjustments.create', group: 'Inventario', label: 'Crear ajustes de inventario', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.adjustments.edit', group: 'Inventario', label: 'Editar ajustes de inventario (borrador)', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.adjustments.delete', group: 'Inventario', label: 'Eliminar y cancelar ajustes de inventario', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.adjustments.approve', group: 'Inventario', label: 'Confirmar ajustes de inventario', hint: 'Confirmar mueve el stock y genera el asiento contable.', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.transfers.create', group: 'Inventario', label: 'Crear traslados entre bodegas', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.transfers.write', group: 'Inventario', label: 'Enviar, recibir y cancelar traslados', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.transfers.close', group: 'Inventario', label: 'Cerrar traslados y remisiones recibidas', hint: 'Un traslado cerrado ya no se puede editar ni anular.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.transfers.delete', group: 'Inventario', label: 'Eliminar traslados', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.physical_counts.create', group: 'Inventario', label: 'Crear conteos físicos y revisar el archivo subido', hint: 'Genera la sesión, descarga la plantilla y previsualiza el conteo sin aplicarlo.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.physical_counts.approve', group: 'Inventario', label: 'Aplicar conteos físicos', hint: 'Aplicar genera los ajustes de inventario por sobrantes y faltantes.', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'inventory.consumptions.approve', group: 'Inventario', label: 'Aprobar consumos internos', roles: MGMT },
  { key: 'inventory.consumptions.delete', group: 'Inventario', label: 'Eliminar consumos internos', roles: [...MGMT, 'warehouse_keeper'] },
  { key: 'inventory.price_adjustments.write', group: 'Inventario', label: 'Ajustes de precios', roles: MGMT },
  // ── Compras ──
  { key: 'purchases.write', group: 'Compras', label: 'Crear, confirmar y recibir compras', roles: ALL },
  // ── Tesorería ──
  { key: 'expenses.write', group: 'Tesorería', label: 'Ver y registrar gastos', roles: [...MGMT, 'accountant'] },
  { key: 'expenses.delete', group: 'Tesorería', label: 'Eliminar gastos', roles: MGMT },
  { key: 'payables.pay', group: 'Tesorería', label: 'Registrar pagos a proveedores', roles: [...MGMT, 'accountant'] },
  { key: 'payments.schedule', group: 'Tesorería', label: 'Programar lotes de pago', roles: [...MGMT, 'accountant'] },
  { key: 'payments.approve', group: 'Tesorería', label: 'Aprobar lotes de pago y generar el archivo del banco', roles: MGMT },
  // ── Proyectos ──
  { key: 'projects.manage', group: 'Proyectos', label: 'Crear y editar proyectos, presupuesto y lista de materiales', roles: MGMT },
  { key: 'projects.stock', group: 'Proyectos', label: 'Reservar, pedir y despachar materiales a la obra', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'projects.pnl', group: 'Proyectos', label: 'Ver rentabilidad y costos de los proyectos', roles: [...MGMT, 'accountant'] },
  { key: 'projects.billing', group: 'Proyectos', label: 'Cortes de obra y facturas parciales', hint: 'Armar y aprobar cortes, facturarlos y liberar la retención de garantía.', roles: [...MGMT, 'accountant'] },
  { key: 'projects.time.write', group: 'Proyectos', label: 'Registrar horas de trabajo por proyecto', roles: [...MGMT, 'technician', 'warehouse_keeper', 'inventory_lead'] },
  { key: 'projects.maintenance.manage', group: 'Proyectos', label: 'Planes de mantenimiento: equipos, frecuencia y tareas', hint: 'Crear y editar planes de mantenimiento de las instalaciones y sus equipos, y reprogramar o cancelar visitas.', roles: MGMT },
  { key: 'projects.maintenance.visit', group: 'Proyectos', label: 'Registrar visitas de mantenimiento', hint: 'Diligenciar el checklist, las observaciones y la firma del cliente al cerrar una visita.', roles: [...MGMT, 'technician'] },
  { key: 'solar.quote', group: 'Proyectos', label: 'Cotizador solar: estudios, cotizaciones y proyecto desde el estudio', roles: [...MGMT, 'seller'] },
  { key: 'solar.configure', group: 'Proyectos', label: 'Configurar precios y parámetros del cotizador solar', roles: MGMT },
  // ── Herramientas ──
  { key: 'tools.manage', group: 'Herramientas', label: 'Registrar herramientas, mantenimientos, calibraciones y bajas', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  { key: 'tools.assign', group: 'Herramientas', label: 'Entregar y recibir herramientas (actas)', roles: [...MGMT, 'warehouse_keeper', 'inventory_lead'] },
  // ── Documentos ──
  { key: 'attachments.write', group: 'Documentos', label: 'Adjuntar soportes (PDF, XML, fotos)', roles: ALL.filter((r) => r !== 'viewer') },
  { key: 'attachments.delete', group: 'Documentos', label: 'Eliminar adjuntos', roles: MGMT },
  // ── Administración ──
  { key: 'approvals.configure', group: 'Administración', label: 'Configurar reglas de aprobación', roles: ['admin'] },
  { key: 'permissions.manage', group: 'Administración', label: 'Administrar roles y permisos', roles: ['admin'], locked: true },
];

const PERMISSIONS_BY_KEY = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));

module.exports = { TENANT_ROLES, ROLE_LABELS, PERMISSIONS, PERMISSIONS_BY_KEY };
