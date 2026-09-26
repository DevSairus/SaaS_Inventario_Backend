'use strict';

// Reagendamiento de citas de taller (PATCH /workshop/appointments/:id/reschedule).
// No se crea una cita nueva: se mueve la misma (conserva share_token, vínculo
// con vehículo/cliente y el historial de confirmación), y se deja rastro de
// que se movió para mostrarlo en la agenda y en el mensaje al cliente.
//  - previous_scheduled_at: fecha/hora anterior al ÚLTIMO reagendamiento.
//  - rescheduled_count / last_rescheduled_at: cuántas veces y cuándo.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // OJO: provisionTenantSchema.js corre esto con un pool de UNA sola
      // conexión -- SQL crudo con { transaction } en vez de addColumn (ver
      // 2026082101-add-global-discount-to-work-orders-and-sales.js).
      await queryInterface.sequelize.query(`
        ALTER TABLE workshop_appointments
          ADD COLUMN IF NOT EXISTS previous_scheduled_at TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS rescheduled_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_rescheduled_at TIMESTAMP WITH TIME ZONE;
      `, { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE workshop_appointments
        DROP COLUMN IF EXISTS previous_scheduled_at,
        DROP COLUMN IF EXISTS rescheduled_count,
        DROP COLUMN IF EXISTS last_rescheduled_at;
    `);
  },
};
