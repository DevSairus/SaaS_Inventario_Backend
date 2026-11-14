'use strict';

// 2.1 — Permisos de inventario separados: crear / editar / eliminar / aprobar
// por recurso (config/permissions.catalog.js). Antes había un solo
// inventory.<recurso>.write por recurso.
//
// Las empresas que ya habían cambiado algún permiso (tenant_role_permissions)
// conservan exactamente lo que tenían: cada excepción del permiso anterior se
// copia a todos los permisos nuevos que lo reemplazan. Las que no habían
// cambiado nada no necesitan filas: los valores por defecto del catálogo
// replican el comportamiento anterior.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. to_regclass porque también corre en `public`.

// permiso anterior -> permisos nuevos que lo reemplazan
const SPLITS = {
  'inventory.products.write': ['inventory.products.create', 'inventory.products.edit', 'inventory.products.delete'],
  'inventory.warehouses.write': ['inventory.warehouses.create', 'inventory.warehouses.edit', 'inventory.warehouses.delete'],
  'inventory.adjustments.write': ['inventory.adjustments.create', 'inventory.adjustments.edit', 'inventory.adjustments.delete', 'inventory.adjustments.approve'],
  'inventory.physical_counts.write': ['inventory.physical_counts.create', 'inventory.physical_counts.approve'],
  // transfers.write sigue existiendo (enviar, recibir y cancelar); solo se le
  // desprenden crear y eliminar.
  'inventory.transfers.write': ['inventory.transfers.create', 'inventory.transfers.delete'],
};
// Los que dejan de existir en el catálogo (sus filas se borran tras copiarlas).
const REMOVED = ['inventory.products.write', 'inventory.warehouses.write', 'inventory.adjustments.write', 'inventory.physical_counts.write'];

const pairs = Object.entries(SPLITS).flatMap(([oldKey, newKeys]) => newKeys.map((k) => [oldKey, k]));
const values = pairs.map(([o, n]) => `('${o}', '${n}')`).join(', ');
const list = (keys) => keys.map((k) => `'${k}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      DO $$ BEGIN
        IF to_regclass('tenant_role_permissions') IS NOT NULL THEN
          INSERT INTO tenant_role_permissions (tenant_id, role, permission_key, allowed, updated_by, created_at, updated_at)
          SELECT t.tenant_id, t.role, m.new_key, t.allowed, t.updated_by, t.created_at, NOW()
          FROM tenant_role_permissions t
          JOIN (VALUES ${values}) AS m(old_key, new_key) ON m.old_key = t.permission_key
          ON CONFLICT (tenant_id, role, permission_key) DO NOTHING;

          DELETE FROM tenant_role_permissions WHERE permission_key IN (${list(REMOVED)});
        END IF;
      END $$;
    `);
  },

  // Best-effort: el permiso anterior toma el valor del primero de sus
  // reemplazos (si la empresa los había separado, se pierde esa diferencia).
  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const firsts = REMOVED.map((o) => `('${o}', '${SPLITS[o][0]}')`).join(', ');
    const allNew = Object.values(SPLITS).flat().filter((k) => k !== 'inventory.transfers.write');
    await q(`
      DO $$ BEGIN
        IF to_regclass('tenant_role_permissions') IS NOT NULL THEN
          INSERT INTO tenant_role_permissions (tenant_id, role, permission_key, allowed, updated_by, created_at, updated_at)
          SELECT t.tenant_id, t.role, m.old_key, t.allowed, t.updated_by, t.created_at, NOW()
          FROM tenant_role_permissions t
          JOIN (VALUES ${firsts}) AS m(old_key, new_key) ON m.new_key = t.permission_key
          ON CONFLICT (tenant_id, role, permission_key) DO NOTHING;

          DELETE FROM tenant_role_permissions WHERE permission_key IN (${list(allNew)});
        END IF;
      END $$;
    `);
  },
};
