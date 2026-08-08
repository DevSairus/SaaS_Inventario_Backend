'use strict';

// Registro LOCAL y liviano del módulo Ensambladora -- deliberadamente
// separado de la tabla real `users` de Pitbox (usada por toda la app,
// con su propio sistema de roles/permisos). Tocar esa tabla para agregar
// documento_identidad/rol técnico-asesor hubiera sido un cambio de mucho
// más riesgo para algo que solo le importa a este módulo. Si el taller
// quiere cruzar un técnico de acá con un usuario real del sistema, lo
// hace manualmente por ahora -- ver LEEME de esta fase.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('ensambladora_tecnicos_asesores')) {
      await queryInterface.createTable('ensambladora_tecnicos_asesores', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        documento_identidad: { type: Sequelize.STRING, allowNull: false, unique: true },
        nombre: { type: Sequelize.STRING, allowNull: true },
        rol: { type: Sequelize.ENUM('tecnico', 'asesor'), allowNull: false },
        vinculado: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
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

    if (!tables.includes('ensambladora_runt_solicitudes')) {
      await queryInterface.createTable('ensambladora_runt_solicitudes', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        vin: { type: Sequelize.STRING, allowNull: false },
        tipo_reporte: { type: Sequelize.ENUM('matricula', 'traspaso'), allowNull: false },
        datos_tramite: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
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
    await queryInterface.dropTable('ensambladora_runt_solicitudes');
    await queryInterface.dropTable('ensambladora_tecnicos_asesores');
  },
};
