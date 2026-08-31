'use strict';

// El modelo Tenant (src/models/auth/Tenant.js) declara `website` y
// `dian_config` desde hace tiempo, pero ninguna migración las creó nunca en
// la tabla `tenants` -- ni el schema.sql base ni la migración baseline las
// incluyen. Cualquier SELECT * de Sequelize sobre Tenant (ej. el listado de
// /api/superadmin/tenants) revienta con "no existe la columna Tenant.website"
// porque Sequelize pide la columna aunque nunca haya existido en la BD real.
//
// `tenants` vive SOLO en el schema `public` (arquitectura schema-per-tenant),
// pero provisionTenantSchema.js corre el set completo de migraciones dentro
// del search_path de cada tenant nuevo -- así que hay que calificar el
// schema explícitamente o esta migración revienta con "no existe la
// relación «tenants»" al aprovisionar cualquier tenant (ver
// 2026072705-add-cutover-status-to-tenants.js, mismo patrón).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('tenants', { schema: 'public' });
    const addIfMissing = (name, def) => existingColumns[name]
      ? Promise.resolve()
      : queryInterface.addColumn('tenants', name, def, { schema: 'public' });

    await addIfMissing('website', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await addIfMissing('dian_config', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
      comment: 'Configuración DIAN: NIT, software_id, certificado, resoluciones, etc.',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenants', 'dian_config', { schema: 'public' });
    await queryInterface.removeColumn('tenants', 'website', { schema: 'public' });
  },
};
