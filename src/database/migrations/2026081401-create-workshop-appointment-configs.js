'use strict';

// Horario/capacidad de reserva de citas del taller, configurable por SEDE
// (no por tenant completo) -- cada branch puede tener horarios distintos.
// business_hours: { mon:[{start,end}], tue:[...], ..., sun:[] } -- array
// vacío = cerrado ese día. Un solo rango por día (sin partir en almuerzo)
// para mantener el MVP simple; blocked_dates cubre festivos/excepciones.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('workshop_appointment_configs')) return;

    await queryInterface.createTable('workshop_appointment_configs', {
      id:        { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: { type: Sequelize.UUID, allowNull: false },
      branch_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'branches', key: 'id' }, onDelete: 'CASCADE' },
      business_hours: {
        type: Sequelize.JSONB, allowNull: false,
        defaultValue: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      },
      slot_duration_minutes:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 60 },
      capacity_per_slot:        { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      advance_booking_days:     { type: Sequelize.INTEGER, allowNull: false, defaultValue: 30 },
      min_notice_hours:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      blocked_dates:            { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      is_public_booking_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('workshop_appointment_configs', ['tenant_id', 'branch_id'], {
      unique: true,
      name: 'workshop_appointment_configs_tenant_branch_unique',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('workshop_appointment_configs');
  },
};
