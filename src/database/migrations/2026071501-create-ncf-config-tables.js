'use strict';

// Configuración de la conexión de Pitbox con el Núcleo Central de
// Facturación (NCF) de ESC DataCore -- ver src/models/payments/NcfConfig.js
// y TenantNcfConfig.js. ncf_config es un singleton (una sola fila, la
// credencial de Pitbox como SistemaOrigen frente al Núcleo);
// tenant_ncf_config guarda los datos fiscales de cada tenant para poder
// facturarle su suscripción.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ncf_config', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      ncf_base_url: { type: Sequelize.STRING(300), allowNull: true },
      ncf_api_key: { type: Sequelize.TEXT, allowNull: true },
      ncf_webhook_secret: { type: Sequelize.STRING(255), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      last_test_at: { type: Sequelize.DATE, allowNull: true },
      last_test_ok: { type: Sequelize.BOOLEAN, allowNull: true },
      last_test_message: { type: Sequelize.STRING(500), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('tenant_ncf_config', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false, unique: true,
        references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      facturacion_centralizada_activa: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      tipo_documento: { type: Sequelize.ENUM('NIT', 'CC', 'CE'), defaultValue: 'NIT' },
      numero_documento: { type: Sequelize.STRING(20), allowNull: true },
      dv: { type: Sequelize.STRING(1), allowNull: true },
      razon_social: { type: Sequelize.STRING(200), allowNull: true },
      email_facturacion: { type: Sequelize.STRING(150), allowNull: true },
      telefono: { type: Sequelize.STRING(30), allowNull: true },
      direccion: { type: Sequelize.STRING(250), allowNull: true },
      ciudad: { type: Sequelize.STRING(100), allowNull: true },
      regimen_code: { type: Sequelize.STRING(10), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('tenant_ncf_config', ['facturacion_centralizada_activa']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tenant_ncf_config');
    await queryInterface.dropTable('ncf_config');
  },
};
