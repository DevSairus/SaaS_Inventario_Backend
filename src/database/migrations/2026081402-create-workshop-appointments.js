'use strict';

// Solicitud de cita de taller -- creada por el cliente desde la página
// pública (/agendar/:slug, sin login) o por el staff (walk-in/teléfono).
// share_token se genera siempre al crear (a diferencia de Sale/WorkOrder,
// donde se genera perezosamente al compartir) porque es el ÚNICO dato que
// el cliente público se lleva para poder consultar el estado después --
// no hay ningún otro identificador previo posible en este flujo.
// converted_to_work_order_id es guard de conversión única, mismo patrón
// que Sale.converted_to_work_order_id.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('workshop_appointments')) return;

    await queryInterface.createTable('workshop_appointments', {
      id:        { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: { type: Sequelize.UUID, allowNull: false },
      branch_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'branches', key: 'id' }, onDelete: 'CASCADE' },
      scheduled_at:      { type: Sequelize.DATE, allowNull: false },
      duration_minutes:  { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.ENUM('pendiente', 'confirmada', 'cancelada', 'no_asistio', 'completada'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      customer_name:  { type: Sequelize.STRING, allowNull: false },
      customer_phone: { type: Sequelize.STRING, allowNull: false },
      customer_email: { type: Sequelize.STRING, allowNull: true },
      vehicle_plate:  { type: Sequelize.STRING, allowNull: true },
      vehicle_brand:  { type: Sequelize.STRING, allowNull: true },
      vehicle_model:  { type: Sequelize.STRING, allowNull: true },
      service_description: { type: Sequelize.TEXT, allowNull: true },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      vehicle_id:  { type: Sequelize.UUID, allowNull: true, references: { model: 'vehicles', key: 'id' }, onDelete: 'SET NULL' },
      converted_to_work_order_id: {
        type: Sequelize.UUID, allowNull: true, unique: true,
        references: { model: 'work_orders', key: 'id' }, onDelete: 'SET NULL',
      },
      share_token: { type: Sequelize.UUID, allowNull: false, unique: true },
      confirmed_by:      { type: Sequelize.UUID, allowNull: true, references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onDelete: 'SET NULL' },
      confirmed_at:      { type: Sequelize.DATE, allowNull: true },
      cancelled_reason:  { type: Sequelize.STRING, allowNull: true },
      reminder_sent_at:  { type: Sequelize.DATE, allowNull: true },
      source: { type: Sequelize.ENUM('public', 'staff'), allowNull: false, defaultValue: 'public' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('workshop_appointments', ['tenant_id', 'branch_id', 'scheduled_at'], {
      name: 'workshop_appointments_tenant_branch_scheduled_idx',
    });
    await queryInterface.addIndex('workshop_appointments', ['tenant_id', 'status'], {
      name: 'workshop_appointments_tenant_status_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('workshop_appointments');
  },
};
