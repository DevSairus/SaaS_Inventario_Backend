'use strict';

// Corrección de diseño: la sincronización con el Núcleo NCF es POR SISTEMA
// (todo Pitbox habla con el Núcleo con una sola credencial, ver ncf_config),
// no por tenant uno a uno. Los datos fiscales de cada tenant YA viven en
// `tenants` (business_name, tax_id, email, phone, address) -- no hace
// falta una tabla aparte para repetirlos. Este migration:
//   1. Elimina `tenant_ncf_config` (si llegó a crearse).
//   2. Agrega a `tenants` unas pocas columnas de bookkeeping para saber, por
//      tenant, cuál fue el resultado de la última sincronización -- sin
//      montar una tabla nueva, todo dentro de `tenants` como corresponde.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('tenant_ncf_config').catch(() => {
      // No existía -- ok, sigue de largo (puede pasar si nunca se llegó a
      // desplegar la migración anterior en este ambiente).
    });

    await queryInterface.addColumn('tenants', 'ncf_ciudad', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: 'Ciudad para efectos de facturación DIAN vía el Núcleo (no siempre coincide con address)',
    });
    await queryInterface.addColumn('tenants', 'ncf_regimen_code', {
      type: Sequelize.STRING(10),
      allowNull: true,
      defaultValue: 'O-47',
      comment: 'Código de responsabilidad fiscal DIAN del tenant (O-47 régimen común, R-99-PN persona natural no responsable, etc.)',
    });
    await queryInterface.addColumn('tenants', 'ncf_external_ref', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: 'external_ref de la última prefactura enviada al Núcleo para este tenant',
    });
    await queryInterface.addColumn('tenants', 'ncf_last_sync_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'ncf_last_status', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Último estado conocido de la prefactura/factura en el Núcleo: sent | rejected | payment_link_generated | paid | invoiced | expired | error',
    });
    await queryInterface.addColumn('tenants', 'ncf_payment_link_url', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'ncf_last_error', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tenants', 'ncf_last_error');
    await queryInterface.removeColumn('tenants', 'ncf_payment_link_url');
    await queryInterface.removeColumn('tenants', 'ncf_last_status');
    await queryInterface.removeColumn('tenants', 'ncf_last_sync_at');
    await queryInterface.removeColumn('tenants', 'ncf_external_ref');
    await queryInterface.removeColumn('tenants', 'ncf_regimen_code');
    await queryInterface.removeColumn('tenants', 'ncf_ciudad');
  },
};
