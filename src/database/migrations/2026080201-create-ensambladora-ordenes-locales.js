'use strict';

// Fase 2 -- lado CSA/PDV. Estas 3 tablas viven en el schema del tenant
// (default, igual que vehiculos_cache) porque son operación diaria del
// centro autorizado, ya con el tenant resuelto por el middleware normal.
// El CSA es "dueño" de este dato (contrato de sincronización, sección 1);
// el Core guarda su propia copia consolidada al recibir el evento.
//
// sync_estado / evento_sync_id siguen el patrón descrito en
// modelo-datos-ensambladora.md, sección 6 ("Órdenes locales"): permiten
// saber si el evento correspondiente ya se confirmó en el Core o quedó
// pendiente/en error, sin tener que ir a mirar ensambladora_eventos_sync
// cada vez.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('ensambladora_ventas')) {
      await queryInterface.createTable('ensambladora_ventas', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        vin: { type: Sequelize.STRING, allowNull: false, unique: true },
        cliente_documento: { type: Sequelize.STRING, allowNull: true },
        cliente_nombre: { type: Sequelize.STRING, allowNull: true },
        cliente_telefono: { type: Sequelize.STRING, allowNull: true },
        fecha_venta: { type: Sequelize.DATEONLY, allowNull: false },
        precio: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
        sync_estado: {
          type: Sequelize.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
          allowNull: false,
          defaultValue: 'pendiente',
        },
        evento_sync_id: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
    }

    if (!tables.includes('ensambladora_ordenes_alistamiento')) {
      await queryInterface.createTable('ensambladora_ordenes_alistamiento', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        vin: { type: Sequelize.STRING, allowNull: false },
        responsable: { type: Sequelize.STRING, allowNull: true },
        fecha: { type: Sequelize.DATE, allowNull: false },
        checklist: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        observaciones: { type: Sequelize.TEXT, allowNull: true },
        sync_estado: {
          type: Sequelize.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
          allowNull: false,
          defaultValue: 'pendiente',
        },
        evento_sync_id: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
    }

    if (!tables.includes('ensambladora_ordenes_entrega')) {
      await queryInterface.createTable('ensambladora_ordenes_entrega', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        vin: { type: Sequelize.STRING, allowNull: false, unique: true },
        fecha_entrega: { type: Sequelize.DATE, allowNull: false },
        recibido_por: { type: Sequelize.STRING, allowNull: true },
        evidencia_url: { type: Sequelize.STRING, allowNull: true },
        sync_estado: {
          type: Sequelize.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
          allowNull: false,
          defaultValue: 'pendiente',
        },
        evento_sync_id: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ensambladora_ordenes_entrega');
    await queryInterface.dropTable('ensambladora_ordenes_alistamiento');
    await queryInterface.dropTable('ensambladora_ventas');
  },
};
